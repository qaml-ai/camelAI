import { constants } from "node:fs";
import { mkdir, realpath, lstat, open, opendir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolBridge } from "./protocol.ts";
import { SANDBOX_LIMITS } from "./limits.ts";

// Demo adapter. Its root must be service-owned: untrusted OS processes must
// not be able to replace intermediate directories while a call is in flight.
export async function localTools(directory: string): Promise<ToolBridge> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  async function pathFor(input: unknown) {
    if (typeof input !== "string" || input.includes("\0")) throw new Error("path must be a valid string");
    const target = resolve(root, input);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes workspace");
    // lstat catches dangling symlinks as well as links to existing targets.
    let current = root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error("Symlink path escapes workspace policy");
        if (!stat.isDirectory() && !stat.isFile()) throw new Error("Only regular files and directories are allowed");
        if (stat.isFile() && stat.nlink !== 1) throw new Error("Hard-linked files are not allowed");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return target;
  }
  return {
    definitions: [
      { name: "read", description: "Read a UTF-8 workspace file", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write", description: "Write a UTF-8 workspace file", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "ls", description: "List a workspace directory", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } } } },
    ],
    async call(name, args, signal) {
      signal.throwIfAborted();
      const path = await pathFor(args.path ?? ".");
      if (name === "ls") {
        const entries: string[] = [];
        const dir = await opendir(path);
        for await (const entry of dir) {
          signal.throwIfAborted();
          if (entries.length >= 1000) throw new Error("Directory entry limit exceeded");
          entries.push(entry.name);
        }
        return { ok: true, data: { entries } };
      }
      if (name !== "read" && name !== "write") throw new Error(`Unknown tool: ${name}`);
      if (name === "write") {
        if (typeof args.content !== "string" || Buffer.byteLength(args.content) > SANDBOX_LIMITS.argumentBytes) throw new Error("Invalid or oversized file content");
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      }
      signal.throwIfAborted();
      const flags = constants.O_NOFOLLOW | (name === "read" ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT);
      const file = await open(path, flags, 0o600);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Only regular, non-linked files are allowed");
        if (name === "read") {
          if (stat.size > SANDBOX_LIMITS.argumentBytes) throw new Error("File size limit exceeded");
          // Bounded read even if another trusted writer changes the file size.
          const buffer = Buffer.alloc(SANDBOX_LIMITS.argumentBytes + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > SANDBOX_LIMITS.argumentBytes) throw new Error("File size limit exceeded");
          signal.throwIfAborted();
          return { ok: true, data: { text: buffer.subarray(0, bytesRead).toString("utf8") } };
        }
        signal.throwIfAborted();
        await file.truncate(0);
        await file.writeFile(args.content as string, { signal });
        return { ok: true, data: { path: args.path } };
      } finally { await file.close(); }
    },
  };
}
