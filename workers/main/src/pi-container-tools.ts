import { Type } from "typebox";
import type {
  WorkspaceFileStoreLike,
  WorkspaceReadFileResponse,
  WorkspaceReadFileStreamResponse,
} from "./workspace-filesystem-do";
import {
  detectSupportedImageMimeType,
  inlineImageMaxBase64Chars,
  isSupportedImageMimeType,
  prepareInlineImageFromBytes,
  prepareInlineImageFromStream,
  readImageSniffBytesAndReplayStream,
  readStreamBytes,
} from "./image-tool-content";
import { isNotebookPath, normalizeNotebookJson } from "./notebook-normalize";
import {
  applyTextEdits,
  generateTextEditDetails,
  normalizeTextEditArguments,
} from "./text-edit";

const CONTAINER_CWD = "/workspace";
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type PiContainerToolResult = {
  text: string;
  content: ToolContent[];
  details?: Record<string, unknown>;
};

const PI_FILE_LOCATION_PARAMETERS = {
  location: Type.Union([
    Type.Literal("workspace"),
    Type.Literal("project"),
    Type.Literal("r2"),
  ], {
    description:
      "Required. Use 'workspace' for loose durable workspace files, 'project' for DO-backed project source files, or 'r2' for workspace-scoped R2 paths (uploads/..., outputs/..., tmp/...).",
  }),
  project: Type.Optional(Type.String({
    description: "Unique workspace project name when location is 'project'.",
  })),
};

export const PI_READ_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the file to read. For location='r2', use uploads/<path>, outputs/<path>, or tmp/<path> with no leading slash." }),
  offset: Type.Optional(Type.Number({ description: "1-indexed line offset for large files" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return" })),
  ...PI_FILE_LOCATION_PARAMETERS,
}, { additionalProperties: false });

export const PI_WRITE_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write" }),
  content_type: Type.Optional(Type.String({ description: "R2 object content type when location is 'r2'." })),
  ...PI_FILE_LOCATION_PARAMETERS,
}, { additionalProperties: false });

export const PI_EDIT_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Optional(Type.Union([
    Type.Array(Type.Object({
      oldText: Type.String({
        description:
          "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
      }),
      newText: Type.String({ description: "Replacement text for this targeted edit." }),
    }, { additionalProperties: false })),
    Type.String({ description: "Compatibility form: a JSON-encoded edits array." }),
  ], {
    description:
      "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
  })),
  oldText: Type.Optional(Type.String({ description: "Compatibility form for a single replacement." })),
  newText: Type.Optional(Type.String({ description: "Compatibility form for a single replacement." })),
  ...PI_FILE_LOCATION_PARAMETERS,
}, { additionalProperties: false });

export const PI_DELETE_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the file or directory to delete (relative or absolute)" }),
  recursive: Type.Optional(Type.Boolean({ description: "Delete directories recursively when supported." })),
  force: Type.Optional(Type.Boolean({ description: "Do not fail if the path does not exist when supported." })),
  ...PI_FILE_LOCATION_PARAMETERS,
}, { additionalProperties: false });

export const PI_LS_PARAMETERS = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
  cursor: Type.Optional(Type.String({ description: "Continuation cursor for paged R2 listings when location is 'r2'." })),
  ...PI_FILE_LOCATION_PARAMETERS,
}, { additionalProperties: false });

export const PI_GREP_PARAMETERS = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
  context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
  ...PI_FILE_LOCATION_PARAMETERS,
}, { additionalProperties: false });

export const PI_FIND_PARAMETERS = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
  }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
  ...PI_FILE_LOCATION_PARAMETERS,
}, { additionalProperties: false });

export const PI_CONTAINER_TOOL_DEFINITIONS = {
  read: {
    name: "read",
    label: "read",
    description:
      `Read a file. Required location: use location='workspace' for loose durable workspace files, location='project' plus project for DO-backed project source files, or location='r2' for workspace-scoped R2. R2 paths must be uploads/<path> for read-only user uploads, outputs/<path> for user-visible outputs, or tmp/<path> for temporary objects; do not use leading slashes, /mnt paths, /r2 paths, or raw R2 keys. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB for workspace/project files. Images are returned as image content when possible.`,
    parameters: PI_READ_PARAMETERS,
  },
  write: {
    name: "write",
    label: "write",
    description:
      "Write content to a required location: use location='workspace' for loose durable workspace files, location='project' plus project for DO-backed project source files, or location='r2' for workspace-scoped R2. R2 writable paths are outputs/<path> and tmp/<path>; uploads/<path> is read-only. Do not use leading slashes, /mnt paths, /r2 paths, or raw R2 keys.",
    parameters: PI_WRITE_PARAMETERS,
  },
  edit: {
    name: "edit",
    label: "edit",
    description:
      "Edit a single text file at a required location: use location='workspace' for loose durable workspace files, location='project' plus project for DO-backed project source files, or location='r2' for workspace-scoped R2. Use one call with multiple entries for disjoint changes. Every edits[].oldText is matched against the original file and must identify a unique, non-overlapping region. Merge nearby changes, and keep oldText as small as possible while still unique; do not pad it with large unchanged regions.",
    parameters: PI_EDIT_PARAMETERS,
  },
  delete: {
    name: "delete",
    label: "delete",
    description:
      "Delete a file at a required location: use location='workspace' for loose durable workspace files, location='project' plus project for DO-backed project source files, or location='r2' for workspace-scoped R2.",
    parameters: PI_DELETE_PARAMETERS,
  },
  ls: {
    name: "ls",
    label: "ls",
    description:
      "List directory contents at a required location: use location='workspace' for loose durable workspace files, location='project' plus project for DO-backed project source files, or location='r2' for workspace-scoped R2. For R2, path must be uploads, outputs, tmp, or a path under one of them with no leading slash. Returns entries sorted alphabetically, with '/' suffix for directories where applicable.",
    parameters: PI_LS_PARAMETERS,
  },
  grep: {
    name: "grep",
    label: "grep",
    description:
      "Search file contents at a required location: use location='workspace' for loose durable workspace files, or location='project' plus project for DO-backed project source files. R2 search is not supported. Returns matching lines with file paths and line numbers.",
    parameters: PI_GREP_PARAMETERS,
  },
  find: {
    name: "find",
    label: "find",
    description:
      "Search files by glob pattern at a required location: use location='workspace' for loose durable workspace files, or location='project' plus project for DO-backed project source files. R2 search is not supported. Returns matching file paths relative to the search directory.",
    parameters: PI_FIND_PARAMETERS,
  },
} as const;

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeMaybeText(bytes: Uint8Array): { content: string; isBinary: boolean } {
  if (bytes.includes(0)) return { content: "", isBinary: true };
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), isBinary: false };
  } catch {
    return { content: "", isBinary: true };
  }
}

function formatSize(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

function result(text: string, details?: Record<string, unknown>): PiContainerToolResult {
  return {
    text,
    content: [{ type: "text", text }],
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

function truncateHead(text: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES) {
  const lines = text.split("\n");
  const selected: string[] = [];
  let usedBytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;
  for (const line of lines) {
    if (selected.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const lineBytes = bytes(line) + (selected.length > 0 ? 1 : 0);
    if (usedBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    selected.push(line);
    usedBytes += lineBytes;
  }
  return {
    content: selected.join("\n"),
    truncation: truncatedBy
      ? {
          truncated: true,
          truncatedBy,
          totalLines: lines.length,
          outputLines: selected.length,
          outputBytes: usedBytes,
          totalBytes: bytes(text),
          maxLines,
          maxBytes,
        }
      : undefined,
  };
}

function normalizePath(value: unknown, fallback = CONTAINER_CWD): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const raw = value.trim();
  if (raw === "~") return CONTAINER_CWD;
  if (raw.startsWith("~/")) return `${CONTAINER_CWD}/${raw.slice(2)}`;
  if (raw.startsWith("/")) return raw;
  return `${CONTAINER_CWD}/${raw}`;
}

function relativeTo(base: string, target: string): string {
  const root = base.replace(/\/+$/, "");
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
  if (target.startsWith(`${CONTAINER_CWD}/`)) return target.slice(CONTAINER_CWD.length + 1);
  return target.replace(/^.*\//, "");
}

function imageMime(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

function workspaceImageResult({
  path,
  size,
  mimeType,
  prepared,
}: {
  path: string;
  size: number | null;
  mimeType: string;
  prepared: Awaited<ReturnType<typeof prepareInlineImageFromStream>>;
}): PiContainerToolResult {
  let text = `Read image file [${prepared?.mimeType ?? mimeType}]\n[Image: ${path}${typeof size === "number" ? ` (${formatSize(size)})` : ""}]`;
  if (prepared?.optimizedForInlineView) {
    text += `\n[Image optimized for inline model context and may be scaled/compressed from the source.]`;
  }
  const content: ToolContent[] = [{ type: "text", text }];
  if (prepared) {
    content.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
  } else {
    text += `\n[Image omitted: could not be resized below the inline image size limit of ${inlineImageMaxBase64Chars()} base64 chars.]`;
    content[0] = { type: "text", text };
  }
  return {
    text,
    content,
    details: {
      mimeType: prepared?.mimeType ?? mimeType,
      originalMimeType: mimeType,
      size,
      image: true,
      inlineImage: Boolean(prepared),
      optimizedForInlineView: prepared?.optimizedForInlineView ?? false,
      maxInlineDimension: prepared?.maxInlineDimension ?? null,
      usedImagesBinding: prepared?.usedImagesBinding ?? false,
      base64Chars: prepared?.base64Chars ?? null,
    },
  };
}

export class PiContainerTools {
  constructor(
    private readonly workspace: WorkspaceFileStoreLike,
    private readonly options: { images?: ImagesBinding } = {},
  ) {}

  private async readWorkspaceFile(path: string): Promise<WorkspaceReadFileResponse> {
    const file = await this.workspace.readFile(path);
    if (!file.success) {
      throw new Error(file.error || `Failed to read ${path}`);
    }
    return file;
  }

  private async readWorkspaceFileStream(path: string): Promise<WorkspaceReadFileStreamResponse> {
    const file = await this.workspace.readFileStream(path);
    if (!file.success || !file.stream) {
      throw new Error(file.error || `Failed to read ${path}`);
    }
    return file;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<PiContainerToolResult> {
    switch (name) {
      case "read":
        return this.read(args);
      case "write":
        return this.write(args);
      case "edit":
        return this.edit(args);
      case "delete":
        return this.delete(args);
      case "ls":
        return this.ls(args);
      case "grep":
        return this.grep(args);
      case "find":
        return this.find(args);
      default:
        throw new Error(`Unknown Pi workspace tool: ${name}`);
    }
  }

  private async read(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const path = normalizePath(args.path);
    let file: WorkspaceReadFileResponse;
    if (typeof this.workspace.readFileStream === "function") {
      const streamed = await this.readWorkspaceFileStream(path);
      const sniffed = await readImageSniffBytesAndReplayStream(streamed.stream!);
      const mimeType = detectSupportedImageMimeType(sniffed.prefix)
        || (streamed.mimeType && isSupportedImageMimeType(streamed.mimeType) ? streamed.mimeType : null)
        || imageMime(path);
      if (mimeType?.startsWith("image/")) {
        if (!this.options.images) throw new Error("IMAGES binding is required for image reads");
        const prepared = await prepareInlineImageFromStream(sniffed.stream, mimeType, this.options.images, {
          createRetryStream: async () => {
            const retry = await this.readWorkspaceFileStream(path);
            return retry.stream!;
          },
        });
        return workspaceImageResult({
          path,
          size: streamed.size ?? null,
          mimeType,
          prepared,
        });
      }
      const bytes = await readStreamBytes(sniffed.stream);
      const decoded = decodeMaybeText(bytes);
      file = {
        success: true,
        content: decoded.content,
        size: streamed.size ?? bytes.byteLength,
        isBinary: decoded.isBinary,
        encoding: decoded.isBinary ? "base64" : "utf8",
        mimeType: streamed.mimeType,
      };
    } else {
      file = await this.readWorkspaceFile(path);
      if (file.isBinary && typeof file.content === "string") {
        const imageBytes = base64ToBytes(file.content);
        const mimeType = detectSupportedImageMimeType(imageBytes)
          || (file.mimeType && isSupportedImageMimeType(file.mimeType) ? file.mimeType : null)
          || imageMime(path);
        if (mimeType?.startsWith("image/")) {
          if (!this.options.images) throw new Error("IMAGES binding is required for image reads");
          const prepared = await prepareInlineImageFromBytes(imageBytes, mimeType, this.options.images);
          return workspaceImageResult({
            path,
            size: file.size ?? imageBytes.byteLength,
            mimeType,
            prepared,
          });
        }
      }
    }
    if (file.isBinary) {
      return result("[Binary file omitted. Use js_exec with tools.move for binary inspection.]", { isBinary: true, size: file.size ?? 0 });
    }

    const lines = String(file.content ?? "").split("\n");
    const start = typeof args.offset === "number" ? Math.max(0, args.offset - 1) : 0;
    if (start >= lines.length) throw new Error(`Offset ${args.offset} is beyond end of file (${lines.length} lines total)`);
    const end = typeof args.limit === "number" ? Math.min(start + args.limit, lines.length) : lines.length;
    const selected = lines.slice(start, end).join("\n");
    const { content, truncation } = truncateHead(selected);
    const notices: string[] = [];
    if (truncation) {
      const nextOffset = start + truncation.outputLines + 1;
      notices.push(`Showing lines ${start + 1}-${start + truncation.outputLines} of ${lines.length}. Use offset=${nextOffset} to continue.`);
    } else if (end < lines.length) {
      notices.push(`${lines.length - end} more lines in file. Use offset=${end + 1} to continue.`);
    }
    return result(`${content}${notices.length ? `\n\n[${notices.join(" ")}]` : ""}`, truncation ? { truncation } : undefined);
  }

  private async write(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    if (typeof args.content !== "string") throw new Error("content must be a string");
    const path = normalizePath(args.path);
    const { content, notice } = await this.normalizeNotebookContent(path, args.content);
    const response = await this.workspace.writeFile(path, content);
    if (!response.success) throw new Error(response.error || `Failed to write ${path}`);
    return result(`Successfully wrote ${content.length} bytes to ${path}${notice}`);
  }

  private async edit(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const path = normalizePath(args.path);
    const edits = normalizeTextEditArguments(args);
    if (this.workspace.editTextFile) {
      const response = await this.workspace.editTextFile(path, edits);
      if (!response.success) throw new Error(response.error || `Failed to edit ${path}`);
      const notice = response.notice ? `\n[${response.notice}]` : "";
      return result(
        `Successfully replaced ${response.replacementCount ?? edits.length} block(s) in ${path}.${notice}`,
        {
          diff: response.diff ?? "",
          patch: response.patch ?? "",
          firstChangedLine: response.firstChangedLine,
          usedFuzzyMatch: response.usedFuzzyMatch ?? false,
        },
      );
    }
    const file = await this.readWorkspaceFile(path);
    if (file.isBinary) throw new Error(`Cannot edit binary file: ${path}`);
    const before = String(file.content ?? "");
    const applied = applyTextEdits(before, edits, path);
    const { content: after, notice } = await this.normalizeNotebookContentForEdit(path, before, applied.after);
    const response = await this.workspace.writeFile(path, after);
    if (!response.success) throw new Error(response.error || `Failed to write ${path}`);
    const details = after === applied.after
      ? applied
      : generateTextEditDetails(path, before, after);
    return result(`Successfully replaced ${edits.length} block(s) in ${path}.${notice}`, {
      diff: details.diff,
      patch: details.patch,
      firstChangedLine: details.firstChangedLine,
      usedFuzzyMatch: applied.usedFuzzyMatch,
    });
  }

  /**
   * Repair nbformat papercuts on .ipynb writes (missing outputs/execution_count,
   * missing cell ids, source lines missing their separating newlines) and reject
   * unparseable notebook JSON at write time — a broken notebook is far cheaper to
   * fix here than as an opaque nbconvert failure on the next run_notebook.
   *
   * Async (despite doing no I/O) so a validation throw rejects behind the
   * caller's await instead of synchronously rejecting the tool promise before
   * callTool's adoption attaches handlers — workerd reports that one-microtask
   * gap as an unhandled rejection.
   */
  private async normalizeNotebookContent(path: string, content: string): Promise<{ content: string; notice: string }> {
    if (!isNotebookPath(path)) return { content, notice: "" };
    const normalized = normalizeNotebookJson(content);
    if (!normalized.changed) return { content, notice: "" };
    return {
      content: normalized.content,
      notice: `\n[Notebook normalized for nbformat: ${normalized.fixes.join("; ")}]`,
    };
  }

  /**
   * Edit-path variant: an edit must be able to make forward progress on a
   * notebook that was ALREADY structurally invalid on disk (an edit usually
   * fixes one region at a time, and failing the whole write because a
   * different region is still broken would force a full rewrite). So a
   * post-edit validation failure only rejects the edit when the pre-edit
   * content was valid — i.e. when this edit is what broke the notebook.
   */
  private async normalizeNotebookContentForEdit(
    path: string,
    before: string,
    after: string,
  ): Promise<{ content: string; notice: string }> {
    if (!isNotebookPath(path)) return { content: after, notice: "" };
    let afterError: unknown;
    try {
      return await this.normalizeNotebookContent(path, after);
    } catch (error) {
      afterError = error;
    }
    try {
      normalizeNotebookJson(before);
    } catch {
      // Baseline was already invalid — let the (still-invalid) edit through so
      // repair can proceed incrementally, and tell the agent what remains.
      const message = afterError instanceof Error ? afterError.message : String(afterError);
      return {
        content: after,
        notice: `\n[Notebook is still structurally invalid after this edit: ${message}]`,
      };
    }
    throw afterError;
  }

  private async delete(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const path = normalizePath(args.path);
    const response = await this.workspace.deleteFile(path, {
      recursive: args.recursive === true,
      force: args.force === true,
    });
    if (!response.success) throw new Error(response.error || `Failed to delete ${path}`);
    const text = `Deleted ${path}`;
    return result(text, { path, deleted: true });
  }

  private async ls(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const path = normalizePath(args.path);
    const limit = Math.max(1, typeof args.limit === "number" ? args.limit : 500);
    const listing = await this.workspace.listFiles(path, {
      recursive: false,
      includeHidden: true,
      limit: limit + 1,
    });
    if (!listing.success) throw new Error(listing.error || `Failed to list ${path}`);
    const entries = [...listing.files];
    const output = entries.slice(0, limit).map((entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`).join("\n");
    if (!output) return result("(empty directory)");
    const { content, truncation } = truncateHead(output, Number.MAX_SAFE_INTEGER);
    const suffix = entries.length > limit ? `\n\n[${limit} entries limit reached. Use limit=${limit * 2} for more.]` : "";
    return result(`${content}${suffix}`, truncation ? { truncation } : entries.length > limit ? { entryLimitReached: limit } : undefined);
  }

  private async grep(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    if (typeof args.pattern !== "string" || !args.pattern.trim()) throw new Error("pattern is required");
    const path = normalizePath(args.path);
    const limit = Math.max(1, typeof args.limit === "number" ? args.limit : 100);
    const globRegex = typeof args.glob === "string" && args.glob.trim()
      ? globToRegex(args.glob.trim())
      : null;
    const matcher = args.literal
      ? null
      : new RegExp(args.pattern, args.ignoreCase ? "i" : "");
    const literal = args.ignoreCase ? args.pattern.toLowerCase() : args.pattern;
    const listing = await this.workspace.listFiles(path, {
      recursive: true,
      includeHidden: true,
      limit: 20_000,
    });
    if (!listing.success) throw new Error(listing.error || `Failed to search ${path}`);
    const matches: string[] = [];
    let lineTruncated = false;
    for (const entry of listing.files) {
      if (entry.type !== "file") continue;
      const displayPath = relativeTo(path, entry.absolutePath).replace(/\\/g, "/");
      if (globRegex && !globRegex.test(displayPath)) continue;
      const file = await this.workspace.readFile(entry.absolutePath);
      if (!file.success || file.isBinary) continue;
      const lines = String(file.content ?? "").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const haystack = args.ignoreCase ? line.toLowerCase() : line;
        if (matcher ? matcher.test(line) : haystack.includes(literal)) {
          const text = line.length > GREP_MAX_LINE_LENGTH
            ? `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`
            : line;
          lineTruncated ||= text !== line;
          matches.push(`${displayPath}:${index + 1}: ${text.trimStart()}`);
          if (matches.length >= limit) break;
        }
        if (matcher) matcher.lastIndex = 0;
      }
      if (matches.length >= limit) break;
    }
    if (matches.length === 0) return result("No matches found");
    const { content, truncation } = truncateHead(matches.join("\n"), Number.MAX_SAFE_INTEGER);
    const notices: string[] = [];
    if (matches.length >= limit) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    if (lineTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    return result(
      `${content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`,
      {
        ...(truncation ? { truncation } : {}),
        ...(matches.length >= limit ? { matchLimitReached: limit } : {}),
        ...(lineTruncated ? { linesTruncated: true } : {}),
      },
    );
  }

  private async find(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const path = normalizePath(args.path);
    const limit = Math.max(1, typeof args.limit === "number" ? args.limit : 1000);
    let pattern = typeof args.pattern === "string" && args.pattern.trim()
      ? args.pattern.trim()
      : typeof args.name === "string" && args.name.trim()
        ? args.name.trim()
        : "*";
    if (pattern.includes("/") && !pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
      pattern = `**/${pattern}`;
    }
    const regex = globToRegex(pattern);
    const listing = await this.workspace.listFiles(path, {
      recursive: true,
      includeHidden: true,
      limit: 20_000,
    });
    if (!listing.success) throw new Error(listing.error || `Failed to find files in ${path}`);
    const lines = listing.files
      .filter((entry) => entry.type === "file")
      .map((entry) => relativeTo(path, entry.absolutePath).replace(/\\/g, "/"))
      .filter((line) => regex.test(line))
      .slice(0, limit);
    if (lines.length === 0) return result("No files found matching pattern");
    const output = lines.join("\n");
    const { content, truncation } = truncateHead(output, Number.MAX_SAFE_INTEGER);
    const limitReached = lines.length >= limit;
    return result(
      `${content}${limitReached ? `\n\n[${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern.]` : ""}`,
      { ...(truncation ? { truncation } : {}), ...(limitReached ? { resultLimitReached: limit } : {}) },
    );
  }
}

function globToRegex(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}
