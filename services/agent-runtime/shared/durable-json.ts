import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Local-disk commit before acknowledging a request or dispatching a side effect. */
export function writeDurableJson(path: string, value: unknown) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const parent = openSync(directory, "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Expected a JSON value");
  return json;
}
