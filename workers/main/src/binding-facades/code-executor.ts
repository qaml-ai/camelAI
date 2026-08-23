import {
  bindingFacadeJson,
  jsonRequest,
  type BindingFacadeFetcher,
} from "./transport.js";

export interface CodeExecutorFacadeEnv {
  CODE_EXECUTOR_SERVICE?: BindingFacadeFetcher;
}

export interface PortableCodeExecutionRequest {
  code: string;
  orgId: string;
  workspaceId: string;
  userId?: string;
  threadId?: string;
  toolUseId?: string;
  timeoutMs: number;
  maxOutputCharacters: number;
}

export interface PortableCodeExecutionResult {
  text: string;
}

export function runPortableCode(
  env: CodeExecutorFacadeEnv,
  request: PortableCodeExecutionRequest,
): Promise<PortableCodeExecutionResult> {
  if (!env.CODE_EXECUTOR_SERVICE) {
    throw new Error("CODE_EXECUTOR_SERVICE is not configured");
  }
  const timeoutMs = (Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
    ? request.timeoutMs
    : 1) + 5_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(
      `Portable Code Mode exceeded its ${request.timeoutMs}ms execution timeout`,
      "TimeoutError",
    ));
  }, timeoutMs);
  return bindingFacadeJson<PortableCodeExecutionResult>(
    env.CODE_EXECUTOR_SERVICE,
    "code-executor",
    "run",
    jsonRequest(request, { method: "POST", signal: controller.signal }),
  ).finally(() => clearTimeout(timeout));
}
