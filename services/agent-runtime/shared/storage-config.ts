import { fileStorage, type Storage } from "./storage.ts";

/** A serializable description of storage, so agent processes can open the same storage as the server. */
export type StorageDescriptor =
  | { kind: "file"; root: string; shared?: boolean }
  | { kind: "s3"; bucket: string; prefix?: string; region?: string };

export async function openStorage(descriptor: StorageDescriptor): Promise<Storage> {
  if (descriptor.kind === "file") return fileStorage(descriptor.root, { shared: descriptor.shared });
  const { s3Storage } = await import("./s3-storage.ts");
  return s3Storage(descriptor);
}

/** Storage from AGENT_STORAGE (file | shared-file | s3) with AGENT_S3_BUCKET / AGENT_S3_PREFIX / AWS_REGION. */
export function storageFromEnvironment(dataDirectory: string, env = process.env): StorageDescriptor {
  const kind = env.AGENT_STORAGE ?? "file";
  if (kind === "file") return { kind: "file", root: dataDirectory };
  if (kind === "shared-file") return { kind: "file", root: dataDirectory, shared: true };
  if (kind === "s3") {
    if (!env.AGENT_S3_BUCKET) throw new Error("AGENT_STORAGE=s3 needs AGENT_S3_BUCKET");
    return { kind: "s3", bucket: env.AGENT_S3_BUCKET, prefix: env.AGENT_S3_PREFIX, region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION };
  }
  throw new Error(`Unknown AGENT_STORAGE: ${kind}`);
}
