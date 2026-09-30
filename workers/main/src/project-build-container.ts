import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import {
  PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS,
  PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS,
  PROJECT_BUILD_IDLE_TIMEOUT_MS,
  PROJECT_BUILD_INSTANCE_TYPE,
} from "./container-sizing.js";
import { recordObservabilityEvent } from "./observability.js";
import { ProjectBuildContainerUnavailableError } from "./project-build-contracts.js";
import {
  nextBuildSessionDeadline,
  PROJECT_BUILD_SESSION_ACTIVITY_KEY,
} from "./project-build-sandbox-lifecycle.js";
import type { Env } from "./types.js";

/** Key of the build image in wrangler `containers[].images`. */
export const PROJECT_BUILD_IMAGE = "project-build";

/** Directory commands start in when the caller gives no cwd. */
const PROJECT_BUILD_DEFAULT_CWD = "/workspace";

/**
 * Environment for every command. `exec()` sees none of the image's `ENV` lines
 * (only `PATH`), so the shell basics are passed here. HOME matters: the image
 * prebakes the bun cache under /root/.bun.
 */
const PROJECT_BUILD_BASE_ENV: Readonly<Record<string, string>> = {
  HOME: "/root",
  LANG: "C.UTF-8",
};

/** Bound for a command whose caller gave no `timeout`; every caller passes one. */
export const PROJECT_BUILD_DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** GNU `timeout` sends SIGKILL this long after SIGTERM. */
const KILL_AFTER_SECONDS = 5;

/** Exit code GNU `timeout` reports when it stopped the command. */
const TIMEOUT_EXIT_CODE = 124;

export interface ProjectBuildExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Milliseconds. */
  timeout?: number;
}

export interface ProjectBuildExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The command was stopped at its `timeout`; stdout/stderr are partial. */
  timedOut: boolean;
}

export interface ProjectBuildListedFile {
  name: string;
  type: "file" | "directory";
  relativePath: string;
  absolutePath: string;
  size: number;
}

/** The part of `Files` this class uses; tests pass a fake. */
export type ProjectBuildFiles = Pick<Files, "readFile" | "writeFile" | "mkdir">;

/**
 * Per-org build container on the native Durable Object container API
 * (`scheduling_policy: "durable_object"`, Sandbox SDK 1.0).
 *
 * Bound as PROJECT_BUILD_SANDBOX and reached through getProjectBuildSandbox()
 * (one instance per org). The container holds only a build cache: source is
 * re-materialized from the project store, and the source manifest tells a cold
 * workdir apart, so a lost container costs a cold build, never data.
 *
 * Contracts: a missing file reads as `null`, a command stopped at its timeout
 * comes back with `timedOut: true`, and a call that finds no running container
 * throws ProjectBuildContainerUnavailableError.
 */
export class ProjectBuildContainer extends DurableObject<Env> {
  private readonly files: ProjectBuildFiles | null;
  private setup: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env, deps: { files?: ProjectBuildFiles } = {}) {
    super(ctx, env);
    const container = ctx.container;
    this.files = deps.files ?? (container ? new Files(container) : null);
    // The inactivity timeout belongs to the DO instance: a restarted DO (a
    // deploy, an eviction) must set it again or the container stops shortly
    // after the DO goes idle.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        await container.setInactivityTimeout(await this.inactivityTimeoutMs());
      });
    }
  }

  async exec(command: string, options: ProjectBuildExecOptions = {}): Promise<ProjectBuildExecResult> {
    return this.withContainer("exec", () => this.runShell(command, options));
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.withContainer("mkdir", () => this.requireFiles().mkdir(path, { recursive: options.recursive === true }));
  }

  /**
   * Writes a file, creating its parent directories. A string is utf8 unless
   * `encoding: "base64"`; a stream is written as it arrives.
   */
  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options: { encoding?: "base64" | "utf8" } = {},
  ): Promise<void> {
    await this.withContainer("writeFile", async () => {
      const files = this.requireFiles();
      const parent = parentDirectory(path);
      if (parent) await files.mkdir(parent, { recursive: true });
      const body = typeof content === "string" && options.encoding === "base64"
        ? base64ToBytes(content)
        : content;
      await files.writeFile(path, body);
    });
  }

  /** Text (or base64) file contents; `null` when the file does not exist. */
  async readFile(path: string, options: { encoding?: "base64" | "utf8" } = {}): Promise<{ content: string } | null> {
    const bytes = await this.readFileBytes(path);
    if (bytes === null) return null;
    return {
      content: options.encoding === "base64" ? bytesToBase64(bytes) : new TextDecoder().decode(bytes),
    };
  }

  /**
   * Whole-file read; `null` when the file does not exist. Build outputs are
   * bounded by Workers' own per-asset/per-module limits, well under one RPC
   * message.
   */
  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.withContainer("readFile", async () => {
      try {
        const response = await this.requireFiles().readFile(path);
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (SandboxFileError.is(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
        throw error;
      }
    });
  }

  /**
   * Regular files and directories under `path`, with sizes, in one `find`
   * (Files would need a process per directory plus one per stat).
   */
  async listFiles(
    path: string,
    options: { recursive?: boolean; includeHidden?: boolean } = {},
  ): Promise<{ files: ProjectBuildListedFile[] }> {
    return this.withContainer("listFiles", async () => {
      const root = path.length > 1 ? path.replace(/\/+$/, "") : path;
      const argv = [
        "find", root, "-mindepth", "1",
        ...(options.recursive ? [] : ["-maxdepth", "1"]),
        "(", "-type", "f", "-o", "-type", "d", ")",
        "-printf", "%y\\t%s\\t%P\\0",
      ];
      const child = await this.container.exec(argv, { cwd: "/", env: { ...PROJECT_BUILD_BASE_ENV } });
      const output = await child.output();
      if (output.exitCode !== 0) {
        const stderr = new TextDecoder().decode(output.stderr).trim();
        if (/No such file or directory/i.test(stderr)) throw new Error(`Directory not found: ${path}`);
        throw new Error(`Failed to list ${path} (exit ${output.exitCode})${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
      }
      return { files: parseFindOutput(new TextDecoder().decode(output.stdout), root, options.includeHidden !== false) };
    });
  }

  /**
   * Keep the container warm for the org's build session: the window is stored
   * and applied as the container's inactivity timeout. Called when a build
   * finishes; never starts a container.
   */
  async noteBuildSessionActivity(windowMs: number = PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS): Promise<void> {
    const stored = await this.ctx.storage.get<number>(PROJECT_BUILD_SESSION_ACTIVITY_KEY);
    const deadline = nextBuildSessionDeadline(Date.now(), stored, windowMs);
    if (deadline !== null) await this.ctx.storage.put(PROJECT_BUILD_SESSION_ACTIVITY_KEY, deadline);
    const container = this.ctx.container;
    if (container?.running) await container.setInactivityTimeout(await this.inactivityTimeoutMs());
  }

  // -------------------------------------------------------------------------

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The project build container binding is not configured");
    return container;
  }

  private requireFiles(): ProjectBuildFiles {
    if (!this.files) throw new Error("The project build container binding is not configured");
    return this.files;
  }

  /** `org-<org>` (projectBuildSandboxKey), for telemetry. */
  private get orgId(): string | null {
    const name = this.ctx.id.name;
    return name?.startsWith("org-") ? name.slice("org-".length) : null;
  }

  /**
   * Run `operation` against a started container. A failure that leaves the
   * container stopped (it failed to start, or died under the call) becomes
   * ProjectBuildContainerUnavailableError; the next call starts a new container.
   */
  private async withContainer<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      await this.ensureRunning();
      return await run();
    } catch (error) {
      if (this.ctx.container?.running || SandboxFileError.is(error)) throw error;
      this.setup = null;
      throw new ProjectBuildContainerUnavailableError(operation, error);
    }
  }

  private ensureRunning(): Promise<void> {
    if (this.setup === null || !this.container.running) {
      this.setup = this.startContainer().catch((error: unknown) => {
        this.setup = null;
        throw error;
      });
    }
    return this.setup;
  }

  /**
   * Starts the container if needed and (re)applies the inactivity timeout.
   * Runs once per DO instance, or again after the container stopped. Every step
   * after start() is safe to repeat: a deploy can restart the DO mid-setup.
   */
  private async startContainer(): Promise<void> {
    const container = this.container;
    const image = container.images[PROJECT_BUILD_IMAGE];
    // "no such image" is one of the readiness gate's permanent-startup markers.
    if (!image) throw new Error(`no such image: ${PROJECT_BUILD_IMAGE} is missing from the container images`);

    if (container.running) {
      // A deploy never replaces a running container. The first call on a new DO
      // instance moves it to the current image; in-flight commands from the
      // previous instance ended with that instance.
      const info = await container.inspect();
      if (info && info.image !== "" && info.image !== image) {
        await container.destroy();
        recordObservabilityEvent(this.env, {
          event: "build_sandbox_image_replaced",
          severity: "info",
          component: "ProjectBuildContainer",
          operation: "startContainer",
          orgId: this.orgId,
        });
      }
    }

    if (!container.running) {
      container.start({
        image,
        instance: PROJECT_BUILD_INSTANCE_TYPE,
        // Builds need the npm registry.
        enableInternet: true,
      });
      recordObservabilityEvent(this.env, {
        event: "build_sandbox_start",
        severity: "info",
        component: "ProjectBuildContainer",
        operation: "startContainer",
        orgId: this.orgId,
      });
    }

    try {
      await container.setInactivityTimeout(await this.inactivityTimeoutMs());
    } catch (error) {
      await container.destroy();
      throw error;
    }
  }

  /** The 2m idle window, stretched to cover a live build session. */
  private async inactivityTimeoutMs(): Promise<number> {
    const until = await this.ctx.storage.get<number>(PROJECT_BUILD_SESSION_ACTIVITY_KEY);
    const remaining = typeof until === "number" && Number.isFinite(until) ? until - Date.now() : 0;
    return Math.max(PROJECT_BUILD_IDLE_TIMEOUT_MS, Math.min(remaining, PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS));
  }

  /**
   * `bash -c command` under GNU `timeout`, which signals the whole process
   * group (SIGTERM, then SIGKILL after 5s).
   */
  private async runShell(command: string, options: ProjectBuildExecOptions): Promise<ProjectBuildExecResult> {
    const timeoutMs = normalizeTimeoutMs(options.timeout);
    const argv = [
      "timeout", `--kill-after=${KILL_AFTER_SECONDS}`, `${timeoutMs / 1000}s`,
      "bash", "-c", command,
    ];
    const startedAt = Date.now();
    const child = await this.container.exec(argv, {
      cwd: options.cwd ?? PROJECT_BUILD_DEFAULT_CWD,
      env: execEnv(options.env),
    });
    const output = await child.output();
    const decoder = new TextDecoder();
    // Exit 124 alone could be the command's own `timeout`; the elapsed time is
    // what says it was ours.
    const timedOut = output.exitCode === TIMEOUT_EXIT_CODE && Date.now() - startedAt >= timeoutMs;
    return {
      success: output.exitCode === 0,
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      timedOut,
    };
  }
}

function normalizeTimeoutMs(timeout: number | undefined): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return PROJECT_BUILD_DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1, Math.ceil(timeout));
}

function execEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const merged: Record<string, string> = { ...PROJECT_BUILD_BASE_ENV };
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === "string") merged[name] = value;
  }
  return merged;
}

function parentDirectory(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : null;
}

/** Parses `find -printf '%y\t%s\t%P\0'` output. */
export function parseFindOutput(output: string, root: string, includeHidden: boolean): ProjectBuildListedFile[] {
  const files: ProjectBuildListedFile[] = [];
  const base = root === "/" ? "" : root;
  for (const record of output.split("\0")) {
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const kind = record.slice(0, firstTab);
    const size = Number(record.slice(firstTab + 1, secondTab));
    const relativePath = record.slice(secondTab + 1);
    if (!relativePath) continue;
    if (!includeHidden && relativePath.split("/").some((part) => part.startsWith("."))) continue;
    const slash = relativePath.lastIndexOf("/");
    files.push({
      name: slash >= 0 ? relativePath.slice(slash + 1) : relativePath,
      type: kind === "d" ? "directory" : "file",
      relativePath,
      absolutePath: `${base}/${relativePath}`,
      size: Number.isFinite(size) ? size : 0,
    });
  }
  return files;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
