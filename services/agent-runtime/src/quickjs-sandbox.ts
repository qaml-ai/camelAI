import {
  newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC,
  type QuickJSHandle, type QuickJSDeferredPromise,
} from "quickjs-emscripten";
import { prepareCodeModeUserCode, stripTypeScriptFromUserCode } from "../shared/code-mode-source.ts";
import { SANDBOX_LIMITS, jsonWithinLimit } from "./limits.ts";
import { validateDefinitions, validateToolCall } from "./tool-policy.ts";
import { SANDBOX_BOOTSTRAP } from "./sandbox-bootstrap.ts";
import type { ToolDefinition } from "./protocol.ts";

export async function runSandbox(options: {
  code: string;
  tools: ToolDefinition[];
  timeoutMs: number;
  maxOutputCharacters: number;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onOutput: (text: string) => void;
}) {
  validateDefinitions(options.tools);
  // Hard guest-memory boundary: setMemoryLimit alone undercounts bulk
  // allocations in the pinned 0.32.0 release (upstream issue #271).
  const pages = SANDBOX_LIMITS.wasmBytes / 65536;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  const module = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
  if (module.getWasmMemory() !== memory) throw new Error("QuickJS did not use the bounded memory");
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(SANDBOX_LIMITS.heapBytes);
  runtime.setMaxStackSize(SANDBOX_LIMITS.stackBytes);
  runtime.setModuleLoader(() => { throw new Error("Module imports are disabled in codemode"); });
  const vm = runtime.newContext();
  const handles: QuickJSHandle[] = [];
  const pending = new Set<QuickJSDeferredPromise>();
  const output: string[] = [];
  let remaining = options.maxOutputCharacters;
  let outputEvents = 0;
  let truncated = false;
  let calls = 0;
  let transferred = 0;
  let closed = false;
  let cpuMs = 0;
  let enteredAt = performance.now();
  const deadline = enteredAt + options.timeoutMs;
  let wake: (() => void) | undefined;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    const now = performance.now();
    interrupted ||= now >= deadline || cpuMs + now - enteredAt >= SANDBOX_LIMITS.cpuMs;
    return interrupted;
  });
  function run<T>(fn: () => T): T {
    enteredAt = performance.now();
    try { return fn(); }
    finally { cpuMs += performance.now() - enteredAt; }
  }
  // Never dump arbitrary guest objects into Node. Getters/proxies/toJSON must
  // execute inside QuickJS with the same limits as the rest of the script.
  function string(handle: QuickJSHandle, maxChars: number): string {
    if (vm.typeof(handle) !== "string") throw new Error("Sandbox bridge expects a string");
    const length = vm.getProp(handle, "length");
    try { if (vm.getNumber(length) > maxChars) throw new Error("Sandbox bridge string exceeds size limit"); }
    finally { length.dispose(); }
    return vm.getString(handle);
  }
  let formatError: QuickJSHandle;
  function guestError(handle: QuickJSHandle): Error {
    if (interrupted) return new Error("Codemode CPU or wall-clock limit exceeded");
    const formatted = run(() => vm.callFunction(formatError, vm.undefined, handle));
    try {
      return new Error(formatted.error ? "Sandbox execution failed (memory or execution limit)" : string(formatted.value, 2048));
    } finally { formatted.dispose(); }
  }
  try {
    const emit = vm.newFunction("emit", (value, overflow) => {
      const text = string(value, 128_000);
      const part = outputEvents < SANDBOX_LIMITS.outputEvents ? text.slice(0, remaining) : "";
      truncated ||= text.length > part.length || vm.getNumber(overflow) === 1;
      if (part) {
        outputEvents++;
        remaining -= part.length;
        output.push(part);
        options.onOutput(part);
      }
      return vm.undefined;
    });
    handles.push(emit);
    const call = vm.newFunction("call", (nameHandle, jsonHandle) => {
      const name = string(nameHandle, 80);
      const args = JSON.parse(string(jsonHandle, SANDBOX_LIMITS.argumentBytes));
      const checked = validateToolCall(options.tools, name, args);
      if (++calls > SANDBOX_LIMITS.toolCalls) throw new Error("Codemode tool call limit exceeded");
      if (pending.size >= SANDBOX_LIMITS.concurrentTools) throw new Error("Too many concurrent tool calls");
      transferred += checked.bytes;
      if (transferred > SANDBOX_LIMITS.totalToolBytes) throw new Error("Codemode transfer limit exceeded");
      const promise = vm.newPromise();
      pending.add(promise);
      void Promise.resolve().then(() => {
        if (closed) throw new Error("Sandbox execution ended");
        return options.call(name, checked.args);
      }).then(value => {
        if (closed) return;
        const json = jsonWithinLimit(value, SANDBOX_LIMITS.resultBytes, "Tool result");
        transferred += Buffer.byteLength(json);
        if (transferred > SANDBOX_LIMITS.totalToolBytes) throw new Error("Codemode transfer limit exceeded");
        const result = vm.newString(json);
        try { promise.resolve(result); } finally { result.dispose(); }
      }).catch(error => {
        if (closed) return;
        const message = error instanceof Error ? error.message : "Tool call failed";
        const result = vm.newError(message.slice(0, 2048));
        try { promise.reject(result); } finally { result.dispose(); }
      }).finally(() => {
        if (closed) return;
        pending.delete(promise);
        promise.dispose();
        wake?.();
      });
      return promise.handle;
    });
    handles.push(call);
    const bootstrap = vm.unwrapResult(vm.evalCode(SANDBOX_BOOTSTRAP, "sandbox-bootstrap.js"));
    handles.push(bootstrap);
    const catalog = vm.newString(JSON.stringify(options.tools));
    handles.push(catalog);
    formatError = vm.unwrapResult(vm.callFunction(bootstrap, vm.undefined, call, emit, catalog));
    handles.push(formatError);
    const code = prepareCodeModeUserCode(await stripTypeScriptFromUserCode(options.code));
    const initial = run(() => vm.evalCode(`(async function() { "use strict";\n${code}\n})().then(value => { if (value !== undefined) text(value); })`, "codemode.js"));
    if (initial.error) { try { throw guestError(initial.error); } finally { initial.dispose(); } }
    const result = initial.value;
    handles.push(result);
    while (true) {
      const jobs = run(() => runtime.executePendingJobs(64));
      if (jobs.error) { try { throw guestError(jobs.error); } finally { jobs.dispose(); } }
      jobs.dispose();
      const state = vm.getPromiseState(result);
      if (state.type === "fulfilled") {
        state.value.dispose();
        if (pending.size) throw new Error("Unawaited tool calls: await all tool promises before returning");
        break;
      }
      if (state.type === "rejected") { try { throw guestError(state.error); } finally { state.error.dispose(); } }
      if (interrupted) throw new Error("Codemode CPU or wall-clock limit exceeded");
      // Bounded batches yield to host IPC. No guest timers, network, filesystem,
      // process APIs or host object references are installed.
      if (runtime.hasPendingJob()) await new Promise<void>(resolve => setImmediate(resolve));
      else await new Promise<void>(resolve => { wake = resolve; });
    }
    return { output, truncated };
  } finally {
    closed = true;
    wake = undefined;
    for (const promise of pending) promise.dispose();
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    vm.dispose();
    runtime.dispose();
  }
}
