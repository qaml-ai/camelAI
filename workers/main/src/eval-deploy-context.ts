/**
 * Real deploys are the default for agent eval runs and opt-out: within an agent eval
 * (`RUN_AGENT_EVALS=1`) an eval deploys for real to the testing-grounds namespace
 * whenever a Cloudflare API token is available, unless explicitly disabled with
 * `EVAL_REAL_DEPLOY=0` (or "false"). It stays inert when there is no token to deploy
 * with, and outside agent eval runs entirely — so other Sandbox-backed harnesses (e.g.
 * `RUN_SANDBOX_EVAL_PROTOTYPE`) are never forced through the real-deploy path.
 */
export function isRealEvalDeployEnabled(env: {
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
}): boolean {
  if (env.RUN_AGENT_EVALS !== "1") return false;
  const flag = env.EVAL_REAL_DEPLOY?.trim().toLowerCase();
  if (flag === "0" || flag === "false") return false;
  return Boolean(env.CF_API_TOKEN?.trim());
}
