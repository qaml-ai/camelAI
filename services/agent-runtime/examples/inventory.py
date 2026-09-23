"""A Python/SQLite application exposing ordinary functions to a hosted agent."""
import asyncio
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clients" / "python"))
from agent_client import AgentRuntime, ToolContext, tool


async def main():
    # Synthetic, process-local database: no production systems or credentials.
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE inventory (sku TEXT PRIMARY KEY, item TEXT, stock INTEGER, target INTEGER);
        INSERT INTO inventory VALUES ('BEAN-01', 'Espresso beans', 8, 40), ('OAT-02', 'Oat milk', 6, 30), ('CUP-03', 'Cups', 200, 100);
        CREATE TABLE restock (sku TEXT PRIMARY KEY REFERENCES inventory(sku), quantity INTEGER, call_id TEXT);
    """)

    @tool
    async def read_inventory():
        """Read inventory and target stock from the application's SQLite database."""
        return [dict(row) for row in db.execute("SELECT * FROM inventory ORDER BY sku")]

    @tool
    async def plan_restock(sku: str, quantity: int, context: ToolContext):
        """Set one SKU's local restock quantity. Does not place orders."""
        if type(quantity) is not int or not 1 <= quantity <= 100:
            raise ValueError("Invalid restock quantity")
        if not db.execute("SELECT 1 FROM inventory WHERE sku = ?", (sku,)).fetchone():
            raise ValueError("Unknown SKU")
        db.execute("INSERT OR REPLACE INTO restock VALUES (?, ?, ?)", (sku, quantity, context.call_id))
        db.commit()
        return {"planned": True, "sku": sku, "quantity": quantity}

    def event(message):
        if message.get("type") == "message_end" and message.get("message", {}).get("role") == "assistant":
            for part in message["message"]["content"]:
                if part.get("type") == "text":
                    print(part["text"])

    async with AgentRuntime() as runtime:
        agent = await runtime.create_agent(tools=[read_inventory, plan_restock], on_event=event)
        try:
            print(f"\nPython + SQLite inventory → hosted agent PID {(await agent.status())['pid']}")
            if "--prompt" in sys.argv:
                index = sys.argv.index("--prompt")
                prompt = sys.argv[index + 1] if len(sys.argv) > index + 1 else "Read the cafe inventory. Plan restocks for every item below target and explain the plan."
                result = await agent.prompt(prompt)
            else:
                result = await agent.execute("""
                    const rows = await tools.read_inventory({});
                    const low = rows.filter(row => row.stock < row.target);
                    return await Promise.all(low.map(row => tools.plan_restock({sku: row.sku, quantity: row.target - row.stock})));
                """)
            if result.get("error"):
                raise RuntimeError(result["error"])
            print(json.dumps({"agentResult": result, "localRestockPlan": [dict(row) for row in db.execute("SELECT sku, quantity FROM restock ORDER BY sku")]}, indent=2))
        finally:
            await agent.destroy()
            db.close()


if __name__ == "__main__":
    asyncio.run(main())
