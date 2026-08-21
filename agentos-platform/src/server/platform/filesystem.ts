import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveDataDir } from "./store.ts";

export type FsEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
};

export type ProjectFilesystemOptions = {
  dataDir?: string;
  workspaceId: string;
  projectId: string;
};

/**
 * Project-scoped filesystem rooted at
 * `{DATA_DIR}/projects/{workspaceId}/{projectId}`.
 */
export class ProjectFilesystem {
  readonly root: string;
  readonly workspaceId: string;
  readonly projectId: string;

  constructor(options: ProjectFilesystemOptions) {
    if (!options.workspaceId?.trim()) {
      throw new Error("ProjectFilesystem: workspaceId is required");
    }
    if (!options.projectId?.trim()) {
      throw new Error("ProjectFilesystem: projectId is required");
    }
    this.workspaceId = options.workspaceId.trim();
    this.projectId = options.projectId.trim();
    this.root = resolve(
      resolveDataDir(options.dataDir),
      "projects",
      this.workspaceId,
      this.projectId,
    );
    mkdirSync(this.root, { recursive: true });
  }

  exists(path: string): boolean {
    return existsSync(this.resolveSafe(path));
  }

  read(path: string): string {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) {
      throw new Error(`File not found: ${this.displayPath(path)}`);
    }
    const st = statSync(abs);
    if (!st.isFile()) {
      throw new Error(`Not a file: ${this.displayPath(path)}`);
    }
    return readFileSync(abs, "utf8");
  }

  write(path: string, content: string): void {
    const abs = this.resolveSafe(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  /**
   * Search/replace edit. Fails if `oldText` is missing or matches more than once
   * (pass `replaceAll: true` to replace every occurrence).
   */
  edit(
    path: string,
    oldText: string,
    newText: string,
    options: { replaceAll?: boolean } = {},
  ): { replacements: number } {
    if (oldText === "") {
      throw new Error(`edit: oldText must be non-empty (${this.displayPath(path)})`);
    }
    const before = this.read(path);
    const count = countOccurrences(before, oldText);
    if (count === 0) {
      throw new Error(
        `edit: oldText not found in ${this.displayPath(path)}`,
      );
    }
    if (!options.replaceAll && count > 1) {
      throw new Error(
        `edit: oldText matched ${count} times in ${this.displayPath(path)}; pass replaceAll: true or narrow the match`,
      );
    }
    const after = options.replaceAll
      ? before.split(oldText).join(newText)
      : before.replace(oldText, newText);
    this.write(path, after);
    return { replacements: options.replaceAll ? count : 1 };
  }

  delete(path: string): void {
    const abs = this.resolveSafe(path);
    if (abs === this.root) {
      throw new Error("delete: refusing to delete project root");
    }
    if (!existsSync(abs)) {
      throw new Error(`Path not found: ${this.displayPath(path)}`);
    }
    rmSync(abs, { recursive: true, force: false });
  }

  mkdir(path: string): void {
    const abs = this.resolveSafe(path);
    mkdirSync(abs, { recursive: true });
  }

  ls(path = "."): FsEntry[] {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) {
      throw new Error(`Directory not found: ${this.displayPath(path)}`);
    }
    const st = statSync(abs);
    if (!st.isDirectory()) {
      throw new Error(`Not a directory: ${this.displayPath(path)}`);
    }
    const baseRel = this.toRelative(abs);
    return readdirSync(abs)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const childAbs = join(abs, name);
        const childSt = statSync(childAbs);
        const childRel =
          baseRel === "." ? name : `${baseRel.replace(/\\/g, "/")}/${name}`;
        if (childSt.isDirectory()) {
          return { name, path: childRel, type: "directory" as const };
        }
        return {
          name,
          path: childRel,
          type: "file" as const,
          size: childSt.size,
        };
      });
  }

  /** Resolve a relative project path under root only. */
  resolveSafe(path: string): string {
    const normalized = normalizeRelative(path);
    const abs = resolve(this.root, normalized);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || rel === ".." || abs === ".." || isAbsoluteEscape(rel)) {
      throw new Error(
        `Path escapes project root: ${path || "."} (resolved under ${this.root})`,
      );
    }
    // Defend against resolve() landing outside on weird inputs.
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(
        `Path escapes project root: ${path || "."} (resolved under ${this.root})`,
      );
    }
    return abs;
  }

  private toRelative(abs: string): string {
    const rel = relative(this.root, abs);
    return rel === "" ? "." : rel.replace(/\\/g, "/");
  }

  private displayPath(path: string): string {
    return normalizeRelative(path) || ".";
  }
}

function normalizeRelative(path: string): string {
  const trimmed = (path ?? "").replace(/\\/g, "/").trim();
  if (!trimmed || trimmed === ".") {
    return ".";
  }
  return trimmed.replace(/^\/+/, "");
}

function isAbsoluteEscape(rel: string): boolean {
  // On Windows relative() can yield an absolute path when roots differ.
  return /^([a-zA-Z]:)?[\\/]/.test(rel);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count += 1;
    idx = found + needle.length;
  }
  return count;
}
