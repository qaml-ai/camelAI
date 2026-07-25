// Test-only worker entry: exports every Durable Object class the non-chat
// worker tests bind to, but deliberately does NOT pull in ChatThreadDO.
// ChatThreadDO's module graph (agents, @cloudflare/ai-chat, pi-agent-core,
// pi-ai, agents/chat) costs ~8s to evaluate in every isolate, and workerd
// re-evaluates the entry graph per test file. Tests that need chat run
// against the real entry via wrangler.test.jsonc.
export { UserDO } from '../src/identity/user-do';
export { OrgDO } from '../src/identity/org-do';
export { WorkspaceDO } from '../src/workspace';
export { OrgSlugDO } from '../src/org-slug-registry';
export { EmailHandleDO } from '../src/email-handle-registry';
export { SignupDO } from '../src/signup-do';
export { WorkspaceCronDO } from '../src/workspace-cron';
export { WorkspaceFilesystemDO } from '../src/workspace-filesystem-do';
export { WorkerLogsDO } from '../src/worker-logs-do';
export { SlackTeamRegistryDO, TelegramRegistryDO } from '../src/channel-registries';
export default { async fetch() { return new Response('slim test entry'); } };
