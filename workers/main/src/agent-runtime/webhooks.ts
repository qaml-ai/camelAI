/**
 * Standard Webhooks verification for the hosted agent runtime's webhook
 * deliveries (routes/agent-runtime-events.ts).
 */
const TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Standard Webhooks: `v1,<base64 HMAC-SHA256("<id>.<timestamp>.<body>")>` under the `whsec_` secret. */
export async function verifyStandardWebhook(
  secret: string,
  headers: Headers,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))));
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",", 2);
    if (version !== "v1" || !signature || signature.length !== expected.length) return false;
    let diff = 0;
    for (let index = 0; index < expected.length; index++) diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
    return diff === 0;
  });
}

/** camelRun v2 signs the raw delivery as HMAC-SHA256(timestamp + "." + body). */
export async function verifyV2Webhook(
  secret: string,
  headers: Headers,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const header = headers.get("x-camelrun-signature");
  const match = header?.match(/^t=(\d{1,16}),v1=([a-f0-9]{64})$/);
  if (!match || !match[1] || !match[2]) return false;
  const [, timestamp, hex] = match;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const signature = new Uint8Array(32);
  for (let index = 0; index < signature.length; index++) {
    signature[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(`${timestamp}.${body}`));
}
