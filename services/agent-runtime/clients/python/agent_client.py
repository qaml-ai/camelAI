"""Hosted agents over SSE + HTTP, with local tool functions and replay receipts."""
import asyncio
from dataclasses import dataclass
import inspect
import json
import os
from pathlib import Path
from typing import get_type_hints
from urllib.parse import urlparse
import uuid

import httpx


class AgentError(RuntimeError):
    def __init__(self, message, status=0, request_id=None):
        super().__init__(message)
        self.status, self.request_id = status, request_id


@dataclass
class ToolContext:
    call_id: str


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    function: object
    with_context: bool

    def definition(self):
        return {"name": self.name, "description": self.description, "parameters": self.parameters}


def tool(function=None, *, name=None, description=None):
    """Expose an async function; infer its JSON schema from Python annotations."""
    def decorate(fn):
        hints = get_type_hints(fn)
        properties, required = {}, []
        with_context = False
        kinds = {str: "string", int: "integer", float: "number", bool: "boolean", dict: "object", list: "array"}
        for key, parameter in inspect.signature(fn).parameters.items():
            if key == "context" and hints.get(key) is ToolContext:
                with_context = True
                continue
            annotation = hints.get(key)
            if annotation not in kinds:
                raise TypeError(f"Annotate {key} with str, int, float, bool, dict, list, or use context: ToolContext")
            if parameter.kind not in (parameter.POSITIONAL_OR_KEYWORD, parameter.KEYWORD_ONLY):
                raise TypeError("Tool parameters must be named arguments")
            properties[key] = {"type": kinds[annotation]}
            if parameter.default is parameter.empty:
                required.append(key)
        if not inspect.iscoroutinefunction(fn):
            raise TypeError("Tools must be async functions; use asyncio.to_thread for blocking work")
        return Tool(name or fn.__name__, description or inspect.getdoc(fn) or fn.__name__,
                    {"type": "object", "properties": properties, "required": required, "additionalProperties": False}, fn, with_context)
    return decorate(function) if function else decorate


def _origin(url):
    address = urlparse(url)
    if address.username or address.password or address.query or address.fragment or address.path not in ("", "/"):
        raise ValueError("Use a runtime origin without credentials, path, or query")
    if address.scheme != "https" and not (address.scheme == "http" and address.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("Remote runtimes require https://")
    return url.rstrip("/")


def _save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(f".{uuid.uuid4()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(value, file, allow_nan=False)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


async def _http(client, base, path, token, method="GET", body=None, retry=True, headers=None):
    encoded = None if body is None else json.dumps(body, allow_nan=False).encode()
    if encoded and len(encoded) > 1_100_000:
        raise AgentError("Request exceeds transport limit")
    for attempt in range(4):
        try:
            response = await client.request(method, base + path, content=encoded, headers={
                "Authorization": f"Bearer {token}", "Content-Type": "application/json", **(headers or {})})
            value = response.json()
            if not response.is_success:
                raise AgentError(value.get("error", f"HTTP {response.status_code}"), response.status_code)
            return value
        except Exception as error:
            if not retry or attempt == 3 or (isinstance(error, AgentError) and error.status < 500):
                raise
            await asyncio.sleep(0.1 * 2 ** attempt)


class AgentRuntime:
    def __init__(self, url=None, api_key=None, state_directory=None):
        self.base = _origin(url or os.environ.get("AGENT_URL", "http://127.0.0.1:8790"))
        self.api_key = api_key or os.environ.get("AGENT_RUNTIME_TOKEN")
        self.state_directory = state_directory
        self.http = httpx.AsyncClient(timeout=10, follow_redirects=False)
        self.agents = []

    async def create_agent(self, *, tools, system_prompt=None, name=None, type=None, idempotency_key=None, on_event=None, on_error=None):
        if not self.api_key:
            raise AgentError("Set api_key or AGENT_RUNTIME_TOKEN to provision an agent")
        session = await _http(self.http, self.base, "/client-sessions", self.api_key, "POST",
                              {"tools": [item.definition() for item in tools], **({"name": name} if name is not None else {}), **({"type": type} if type is not None else {}), **({"systemPrompt": system_prompt} if system_prompt is not None else {})},
                              headers={"Idempotency-Key": idempotency_key or str(uuid.uuid4())})
        return await self.connect_agent(session, tools=tools, on_event=on_event, on_error=on_error)

    async def connect_agent(self, session, *, tools, on_event=None, on_error=None):
        agent = AgentClient(self.base, session, tools, self.state_directory, on_event, on_error)
        self.agents.append(agent)
        try:
            await agent.connect()
            return agent
        except BaseException:
            await agent.close()
            raise

    async def close(self):
        await asyncio.gather(*(agent.close() for agent in self.agents))
        await self.http.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()


class AgentClient:
    def __init__(self, base, session, tools, state_directory=None, on_event=None, on_error=None):
        import re
        if not re.fullmatch(r"client_[a-f0-9]{40}", session["id"]):
            raise ValueError("Invalid session id")
        self.base = _origin(base)
        self.session = {key: session[key] for key in ("id", "token", "expiresAt")}
        self.tools = {item.name: item for item in tools}
        self.on_event, self.on_error = on_event, on_error
        self.http = httpx.AsyncClient(timeout=10, follow_redirects=False)
        self.path = f"/clients/{session['id']}"
        self.journal_path = Path(state_directory or os.environ.get("AGENT_CLIENT_STATE_DIR", ".agent-runtime/client-sdk")) / f"{session['id']}.json"
        try:
            self.journal = json.loads(self.journal_path.read_text())
        except FileNotFoundError:
            self.journal = {"version": 1, "cursor": 0, "calls": {}}
        if self.journal["version"] != 1:
            raise AgentError("Unsupported client journal")
        self.pending, self.active = {}, {}
        self.delivered = set()
        self.ready = asyncio.Event()
        self.runner = None
        self.closed = False
        self.fatal = None

    def _save(self):
        _save(self.journal_path, self.journal)

    async def _http(self, suffix, method="GET", body=None, retry=True):
        return await _http(self.http, self.base, self.path + suffix, self.session["token"], method, body, retry)

    async def connect(self):
        if self.closed:
            raise AgentError("Client closed")
        if not self.runner:
            self.runner = asyncio.create_task(self._events())
        await asyncio.wait_for(self.ready.wait(), 10)
        if self.fatal:
            raise self.fatal

    def _report(self, error):
        if self.on_error:
            self.on_error(error)

    async def _events(self):
        backoff = 0.25
        while not self.closed:
            try:
                async with self.http.stream("GET", self.base + self.path + "/events", headers={
                    "Authorization": f"Bearer {self.session['token']}", "Accept": "text/event-stream",
                    "Last-Event-ID": str(self.journal["cursor"])}, timeout=20) as response:
                    if response.status_code == 409:
                        state = await self._sync()
                        self.journal["cursor"] = state["cursor"]
                        self._save()
                        if self.on_event:
                            self.on_event({"type": "replay_gap", "cursor": state["cursor"]})
                        continue
                    if not response.is_success:
                        raise AgentError(f"Event stream HTTP {response.status_code}", response.status_code)
                    if not response.headers.get("content-type", "").startswith("text/event-stream"):
                        raise AgentError("Expected SSE response")
                    buffer = b""
                    async for chunk in response.aiter_bytes():
                        buffer += chunk
                        while b"\n\n" in buffer:
                            frame, buffer = buffer.split(b"\n\n", 1)
                            if len(frame) > 1_100_000:
                                raise AgentError("SSE frame too large")
                            lines = frame.decode().split("\n")
                            data = "\n".join(line[5:].lstrip() for line in lines if line.startswith("data:"))
                            if not data:
                                continue
                            if "event: ready" in lines:
                                await self._sync()
                                backoff = 0.25
                                self.ready.set()
                                continue
                            cursor = int(next(line[3:] for line in lines if line.startswith("id:")))
                            if cursor <= self.journal["cursor"]:
                                continue
                            self._receive(json.loads(data))
                            self.journal["cursor"] = cursor
                            self._save()
                        if len(buffer) > 1_100_000:
                            raise AgentError("SSE frame too large")
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if isinstance(error, AgentError) and error.status in (401, 403, 410):
                    self.fatal = error
                    self.ready.set()
                    for future in self.pending.values():
                        if not future.done():
                            future.set_exception(error)
                    self._report(error)
                    return
                if not self.closed:
                    self._report(error)
            if not self.closed:
                await asyncio.sleep(backoff)
                backoff = min(5, backoff * 2)

    def _receive(self, event):
        if event["type"] == "tool_call":
            self._dispatch(event["call"])
        elif event["type"] == "tool_cancel":
            task = self.active.get(event["id"])
            if task:
                task.cancel()
        elif event["type"] == "response":
            self._settle(event["id"], event["outcome"])
        elif event["type"] == "event" and self.on_event:
            self.on_event(event["event"])

    def _settle(self, request_id, value):
        future = self.pending.pop(request_id, None)
        if future and not future.done():
            if "error" in value:
                future.set_exception(AgentError(value["error"], request_id=request_id))
            else:
                future.set_result(value.get("result"))

    async def _sync(self):
        state = await self.outcomes()
        for request in state["requests"]:
            if "outcome" in request:
                self._settle(request["id"], request["outcome"])
        for call in state["calls"]:
            self._dispatch(call)
        return state

    def _dispatch(self, call):
        call_id = call["id"]
        if self.closed or call_id in self.active or call_id in self.delivered or call["state"] in ("completed", "cancelled"):
            return
        task = asyncio.create_task(self._run_tool(call))
        self.active[call_id] = task
        def finished(task):
            self.active.pop(call_id, None)
            if not task.cancelled() and task.exception():
                self._report(task.exception())
        task.add_done_callback(finished)

    async def _run_tool(self, call):
        call_id = call["id"]
        receipt = self.journal["calls"].get(call_id)
        if receipt and receipt["state"] == "done":
            await self._http(f"/calls/{call_id}/outcome", "POST", receipt["outcome"])
            self.delivered.add(call_id)
            return
        if call["state"] == "uncertain":
            return
        if call["state"] == "started":
            value = {"error": "Client lost its execution outcome; reconciliation required", "uncertain": True}
        else:
            self.journal["calls"][call_id] = {"state": "started"}
            self._save()
            try:
                claim = await self._http(f"/calls/{call_id}/claim", "POST", {}, retry=False)
                if not claim["execute"]:
                    if claim["call"]["state"] != "started":
                        return
                    value = {"error": "Tool already claimed; outcome unknown", "uncertain": True}
                else:
                    try:
                        definition = self.tools[call["name"]]
                        args = dict(call["args"])
                        if definition.with_context:
                            args["context"] = ToolContext(call_id=call_id)
                        import time
                        remaining = max(0.001, call["deadline"] / 1000 - time.time())
                        result = await asyncio.wait_for(definition.function(**args), remaining)
                        if len(json.dumps(result, allow_nan=False).encode()) > 1024 * 1024:
                            raise ValueError("Tool result too large")
                        value = {"result": result}
                    except (asyncio.CancelledError, TimeoutError):
                        value = {"error": "Tool cancelled; verify any side effects", "uncertain": True}
                    except Exception as error:
                        value = {"error": str(error)[:2048]}
            except asyncio.CancelledError:
                value = {"error": "Tool cancelled during claim; outcome unknown", "uncertain": True}
            except Exception as error:
                value = {"error": f"Execution claim failed: {str(error)[:1800]}", "uncertain": True}
        self.journal["calls"][call_id] = {"state": "done", "outcome": value}
        self._save()
        await self._http(f"/calls/{call_id}/outcome", "POST", value)
        self.delivered.add(call_id)

    async def request(self, method, params=None, *, idempotency_key=None, timeout=180):
        if self.closed or self.fatal:
            raise self.fatal or AgentError("Client closed")
        request_id = idempotency_key or str(uuid.uuid4())
        if request_id in self.pending or len(self.pending) >= 8:
            raise AgentError("Request already pending or too many outstanding requests", request_id=request_id)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            record = await self._http("/requests", "POST", {"id": request_id, "method": method, "params": params or {}})
            if "outcome" in record:
                self._settle(request_id, record["outcome"])
            return await asyncio.wait_for(future, timeout)
        except TimeoutError as error:
            raise AgentError("Request timed out; inspect request_status() or reuse the same idempotency_key", request_id=request_id) from error
        finally:
            self.pending.pop(request_id, None)
            if future.done() and not future.cancelled():
                future.exception()  # An SSE error may arrive while POST fails.
            elif not future.done():
                future.cancel()

    async def prompt(self, text, **options):
        return await self.request("prompt", {"text": text}, **options)

    async def execute(self, code, *, execution_timeout_ms=None, **options):
        params = {"code": code}
        if execution_timeout_ms is not None:
            params["timeoutMs"] = execution_timeout_ms
        return await self.request("execute", params, **options)

    async def set_metadata(self, *, name, type):
        return await self._http("/metadata", "POST", {"name": name, "type": type})

    async def status(self):
        return await self.request("status")

    async def abort(self):
        return await self.request("abort")

    async def outcomes(self):
        return await self._http("/state")

    async def request_status(self, request_id):
        from urllib.parse import quote
        return await self._http(f"/requests/{quote(request_id, safe='')}")

    async def reconcile(self, call_id, verified_outcome):
        from urllib.parse import quote
        return await self._http(f"/calls/{quote(call_id, safe='')}/reconcile", "POST", verified_outcome, retry=False)

    async def acknowledge_request(self, request_id):
        from urllib.parse import quote
        return await self._http(f"/requests/{quote(request_id, safe='')}/reconcile", "POST", {"acknowledged": True}, retry=False)

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if self.runner:
            self.runner.cancel()
            await asyncio.gather(self.runner, return_exceptions=True)
        for request_id, future in self.pending.items():
            if not future.done():
                future.set_exception(AgentError("Client closed; request may still be running", request_id=request_id))
        tasks = list(self.active.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=1)
        await self.http.aclose()

    async def destroy(self):
        try:
            await self._http("", "DELETE")
        finally:
            await self.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()
