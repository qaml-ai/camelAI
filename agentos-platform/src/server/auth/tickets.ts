import { createHmac, timingSafeEqual } from "node:crypto";

export type AuthTicketPayload = {
  orgId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  /** Unix timestamp in seconds. */
  exp: number;
};

function signingSecret(secret?: string): string {
  return secret?.trim() || process.env.TOKEN_SIGNING_SECRET?.trim() || "dev-secret";
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signature(encodedPayload: string, secret?: string): Buffer {
  return createHmac("sha256", signingSecret(secret))
    .update(encodedPayload)
    .digest();
}

function isTicketPayload(value: unknown): value is AuthTicketPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<AuthTicketPayload>;
  return (
    typeof payload.orgId === "string" &&
    payload.orgId.length > 0 &&
    typeof payload.workspaceId === "string" &&
    payload.workspaceId.length > 0 &&
    typeof payload.threadId === "string" &&
    payload.threadId.length > 0 &&
    typeof payload.userId === "string" &&
    payload.userId.length > 0 &&
    Number.isInteger(payload.exp)
  );
}

export function mintTicket(
  payload: AuthTicketPayload,
  secret?: string,
): string {
  if (!isTicketPayload(payload)) {
    throw new Error("Invalid auth ticket payload");
  }
  const encodedPayload = encode(JSON.stringify(payload));
  return `${encodedPayload}.${encode(signature(encodedPayload, secret))}`;
}

export function verifyTicket(
  ticket: string,
  secret?: string,
): AuthTicketPayload | null {
  const [encodedPayload, encodedSignature, extra] = ticket.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    return null;
  }

  try {
    const actualSignature = Buffer.from(encodedSignature, "base64url");
    const expectedSignature = signature(encodedPayload, secret);
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return null;
    }

    const payload: unknown = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    if (
      !isTicketPayload(payload) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
