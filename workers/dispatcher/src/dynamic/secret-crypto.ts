/**
 * Edge-only AES-256-GCM encryption for WfP-migrated `secret_text` bindings
 * stored at rest in R2 (`dynamic-secrets/<script>.enc.json`).
 *
 * Plaintext secret values are extracted edge-to-edge from WfP Export Shims
 * over the internal `env.DISPATCHER` binding, immediately encrypted using a
 * key derived from `MIGRATION_HMAC_SECRET || TOKEN_SIGNING_SECRET`, and
 * decrypted only inside `chiridion-dispatcher` when booting the tenant's
 * Dynamic Worker isolate. Plaintext secrets never leave Cloudflare's edge.
 */

export interface EncryptedSecretsEnvelope {
  v: 1;
  iv: string;
  ct: string;
  names: string[];
  updatedAt: string;
}

export function dynamicSecretsR2Key(dispatchScriptName: string): string {
  return `dynamic-secrets/${encodeURIComponent(dispatchScriptName)}.enc.json`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function deriveAesKey(masterSecret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(`chiridion-dynamic-secrets-v1:${masterSecret}`);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecretsPayload(
  masterSecret: string,
  secrets: Record<string, string>,
): Promise<EncryptedSecretsEnvelope> {
  const key = await deriveAesKey(masterSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  return {
    v: 1,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ciphertext),
    names: Object.keys(secrets).sort(),
    updatedAt: new Date().toISOString(),
  };
}

export async function decryptSecretsPayload(
  masterSecret: string,
  envelope: EncryptedSecretsEnvelope,
): Promise<Record<string, string>> {
  const key = await deriveAesKey(masterSecret);
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
