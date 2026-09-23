"""Run with: python3 services/agent-runtime/tests/python_sdk.py (requires httpx)."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "clients" / "python"))
from agent_client import AgentRuntime, ToolContext, tool


class PythonSDKTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="camelai-python-sdk-")
        self.token = "fixture-only-python-sdk-operator-token"
        self.host = await asyncio.create_subprocess_exec(
            "bun", str(ROOT / "src" / "server.ts"), stdout=asyncio.subprocess.PIPE,
            env={"PATH": os.environ["PATH"], "HOME": self.directory.name,
                 "AGENT_DATA_DIR": self.directory.name, "AGENT_RUNTIME_TOKEN": self.token, "PORT": "0",
                 **({"AGENT_RUNTIME": os.environ["AGENT_RUNTIME"]} if "AGENT_RUNTIME" in os.environ else {})},
        )
        ready = json.loads(await asyncio.wait_for(self.host.stdout.readline(), 15))
        self.runtime = AgentRuntime(url=f"http://127.0.0.1:{ready['address']['port']}", api_key=self.token,
                                    state_directory=Path(self.directory.name) / "sdk")

    async def asyncTearDown(self):
        await self.runtime.close()
        self.host.terminate()
        await asyncio.wait_for(self.host.wait(), 10)
        self.directory.cleanup()

    async def test_annotations_reconnect_and_lost_acknowledgements(self):
        writes = []
        entered, release = asyncio.Event(), asyncio.Event()

        @tool
        async def save(value: str, context: ToolContext):
            """Save an application value and its idempotency key."""
            if value == "hold":
                entered.set()
                await release.wait()
            writes.append((value, context.call_id))
            return {"saved": value}

        self.assertEqual(save.parameters["properties"], {"value": {"type": "string"}})
        self.assertEqual(save.parameters["required"], ["value"])
        agent = await self.runtime.create_agent(tools=[save], system_prompt="You are the inventory planner.", name="Downtown cafe", type="inventory-planner")
        saved = json.loads((Path(self.directory.name) / "client-sessions" / f"{agent.session['id']}.json").read_text())
        self.assertEqual(saved["config"]["systemPrompt"], "You are the inventory planner.")
        self.assertEqual(saved["metadata"], {"name": "Downtown cafe", "type": "inventory-planner"})
        await agent.set_metadata(name="Uptown cafe", type="inventory-planner")
        saved = json.loads((Path(self.directory.name) / "client-sessions" / f"{agent.session['id']}.json").read_text())
        self.assertEqual(saved["metadata"]["name"], "Uptown cafe")
        original = agent.http.request
        dropped = set()

        async def flaky_request(method, url, **kwargs):
            response = await original(method, url, **kwargs)
            suffix = str(url).split("/")[-1]
            if method == "POST" and suffix in ("requests", "outcome") and suffix not in dropped:
                dropped.add(suffix)
                raise ConnectionError("Simulated acknowledgement lost after server commit")
            return response

        agent.http.request = flaky_request
        script = 'return await tools.save({value:"once"})'
        first = await agent.execute(script, idempotency_key="stable-python-request")
        repeated = await agent.execute(script, idempotency_key="stable-python-request")
        self.assertEqual(first, repeated)
        self.assertEqual(len(writes), 1)
        self.assertEqual(dropped, {"requests", "outcome"})

        # Restart only the receive stream while the application callback is live.
        pending = asyncio.create_task(agent.execute('return await tools.save({value:"hold"})'))
        await asyncio.wait_for(entered.wait(), 5)
        agent.runner.cancel()
        await asyncio.gather(agent.runner, return_exceptions=True)
        agent.runner = None
        agent.ready.clear()
        await agent.connect()
        release.set()
        result = await asyncio.wait_for(pending, 5)
        self.assertEqual(json.loads(result["output"][0]), {"saved": "hold"})
        self.assertEqual(len(writes), 2)
        self.assertNotEqual(writes[0][1], writes[1][1])
        self.assertFalse((await agent.outcomes())["needsReconciliation"])
        await agent.destroy()


if __name__ == "__main__":
    unittest.main()
