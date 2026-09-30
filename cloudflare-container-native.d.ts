/* eslint-disable */
// Native Durable Object container API (`ctx.container` under the
// `scheduling_policy: "durable_object"` container policy), declared as
// interface merges onto the older runtime types in cloudflare-env.d.ts.
//
// Copied from the runtime types `wrangler types` generates with
// workerd@1.20260930.2 (wrangler 4.145.0). A full `bun run cf-typegen` pulls
// these in too, but it also moves ~8k lines of unrelated runtime types and
// surfaces ~50 unrelated type errors, so it is its own change. Delete this file
// once cloudflare-env.d.ts is regenerated with a workerd that has them.

interface ExecOutput {
    readonly stdout: ArrayBuffer;
    readonly stderr: ArrayBuffer;
    readonly exitCode: number;
}
interface ContainerExecOptions {
    cwd?: string;
    env?: Record<string, string>;
    user?: string;
    signal?: AbortSignal;
    pty?: boolean | ContainerExecPtyOptions;
    stdin?: ReadableStream | "pipe";
    stdout?: "pipe" | "ignore";
    stderr?: "pipe" | "ignore" | "combined";
}
interface ContainerExecPtyOptions {
    cols?: number;
    rows?: number;
}
interface ExecProcess {
    readonly stdin: WritableStream | null;
    readonly stdout: ReadableStream | null;
    readonly stderr: ReadableStream | null;
    readonly pid: number;
    readonly isPty: boolean;
    readonly exitCode: Promise<number>;
    output(): Promise<ExecOutput>;
    kill(signal?: number): void;
    resize(cols: number, rows: number): void;
}
interface Container {
    get images(): Record<string, string>;
    interceptOutboundHttp(addr: string, binding: Fetcher): Promise<void>;
    interceptAllOutboundHttp(binding: Fetcher): Promise<void>;
    interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void>;
    exec(cmd: string[], options?: ContainerExecOptions): Promise<ExecProcess>;
    inspect(): Promise<ContainerInfo | null>;
}
interface ContainerStartupOptions {
    /** durable_object policy only: `ctx.container.images.<name>` or "cloudflare/debian-trixie". */
    image?: string;
    /** durable_object policy only; defaults to "lite". */
    instance?: "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4" | ContainerStartResources;
    labels?: Record<string, string>;
}
interface ContainerInfo {
    labels: Record<string, string>;
    image: string;
}
interface ContainerStartResources {
    vcpu: number;
    memoryMib: number;
    diskMb: number;
}
