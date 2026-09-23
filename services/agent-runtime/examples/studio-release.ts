import { AgentRuntime, schema, tool, type AgentClient } from '../clients/node.ts';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeDurableJson } from '../shared/durable-json.ts';
const root = process.env.STUDIO_DATA_DIR!;
mkdirSync(root, { recursive: true });
const base = process.env.AGENT_URL!;
const secret = { operator: process.env.AGENT_RUNTIME_TOKEN! };
function stored(name: string, fallback: any): any {
 try { return JSON.parse(readFileSync(join(root, name), 'utf8')); }
 catch (e: any) { if (e.code !== 'ENOENT') throw e; return fallback; }
}
let client: AgentClient;
const runtime = new AgentRuntime({ url: base, apiKey: secret.operator, stateDirectory: join(root, 'clients') });
const release = { appState: stored('release.json', { issues: [{ id: 'APP-41', title: 'Checkout retry duplicates receipts', severity: 'high', owner: 'Payments', status: 'open' }, { id: 'APP-42', title: 'Search loses keyboard focus', severity: 'medium', owner: 'Web', status: 'open' }, { id: 'APP-43', title: 'CSV export missing timezone', severity: 'high', owner: 'Data', status: 'resolved' }], note: '' }) };
function persisted(_name: string, fn: (args: any) => unknown) {
  return async (args: any) => {
    try { const result = await fn(args); return result; }
    finally { writeDurableJson(join(root, 'release.json'), release.appState); }
  };
}
const options = {
  tools: {
    list_issues: tool({ description: 'Read issues on the local release board.', input: schema.Object({}), execute: persisted('list_issues', () => release.appState.issues) }),
    update_issue: tool({ description: 'Update the status of a synthetic issue in this local demo board.', input: schema.Object({ id: schema.String(), status: schema.Union([schema.Literal('open'), schema.Literal('resolved')]) }), execute: persisted('update_issue', ({ id, status }) => { const issue = release.appState.issues.find((i: any) => i.id === id); if (!issue) throw new Error('Unknown issue'); issue.status = status; return issue; }) }),
    save_release_note: tool({ description: 'Save a release readiness note locally. Does not publish or send messages.', input: schema.Object({ note: schema.String({ maxLength: 4000 }) }), execute: persisted('save_release_note', ({ note }) => { release.appState.note = note; return { saved: true, note }; }) }),
  },
};
const session = stored('typescript-session.json', null);
client = session ? await runtime.connectAgent(session, options) : await runtime.createAgent({ ...options, name: 'September release', type: 'release-reviewer', systemPrompt: 'Review release readiness using the issue board. Save clear, concise release notes. Only synthetic local data is modified.' });
writeDurableJson(join(root, 'typescript-session.json'), client.session);
await client.setMetadata({ name: 'September release', type: 'release-reviewer' });
process.on('SIGTERM', async () => { await client.close(); process.exit(0); });
setInterval(() => {}, 60000);
