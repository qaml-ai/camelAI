"""A real Python application: SQLite state and SDK callbacks, no HTTP plumbing."""
import asyncio
import json
import os
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'clients' / 'python'))
from agent_client import AgentRuntime, ToolContext, tool



async def main():
    root = Path(os.environ['STUDIO_DATA_DIR'])
    db = sqlite3.connect(root / 'inventory.sqlite')
    db.row_factory = sqlite3.Row
    db.executescript('''
        CREATE TABLE IF NOT EXISTS inventory (sku TEXT PRIMARY KEY, item TEXT, stock INTEGER, target INTEGER);
        INSERT OR IGNORE INTO inventory VALUES ('BEAN-01', 'Espresso beans', 8, 40), ('OAT-02', 'Oat milk', 6, 30), ('CUP-03', 'Cups', 200, 100);
        CREATE TABLE IF NOT EXISTS restock (sku TEXT PRIMARY KEY, quantity INTEGER, call_id TEXT);
    ''')

    @tool
    async def read_inventory(context: ToolContext):
        """Read cafe inventory and target quantities from SQLite."""
        rows = [dict(r) for r in db.execute('SELECT * FROM inventory ORDER BY sku')]
        return rows

    @tool
    async def plan_restock(sku: str, quantity: int, context: ToolContext):
        """Set a local restock plan. This does not purchase anything. Quantity must be 1 to 100."""
        args = {'sku': sku, 'quantity': quantity}
        if type(quantity) is not int or not 1 <= quantity <= 100:
            raise ValueError('Quantity must be between 1 and 100')
        if not db.execute('SELECT 1 FROM inventory WHERE sku = ?', (sku,)).fetchone():
            raise ValueError('Unknown SKU')
        db.execute('INSERT OR REPLACE INTO restock VALUES (?, ?, ?)', (sku, quantity, context.call_id))
        db.commit()
        result = {'planned': True, **args}
        return result

    async with AgentRuntime() as runtime:
        tools = [read_inventory, plan_restock]
        session_path = root / 'python-session.json'
        options = {'tools': tools}
        if session_path.exists():
            agent = await runtime.connect_agent(json.loads(session_path.read_text()), **options)
        else:
            agent = await runtime.create_agent(name='Downtown cafe', type='inventory-planner', system_prompt='Help plan cafe inventory using SQLite tools. This is synthetic local data; planning does not place orders.', **options)
            fd = os.open(session_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump(agent.session, f)
        await agent.set_metadata(name='Downtown cafe', type='inventory-planner')
        try:
            # The SDK keeps its SSE tool receiver connected; Studio observes the runtime.
            await asyncio.Event().wait()
        finally:
            await agent.close()
            db.close()


if __name__ == '__main__':
    asyncio.run(main())
