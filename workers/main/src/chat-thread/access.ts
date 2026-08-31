// Chat access grants + client-message dedup for ChatThreadDO, extracted as a
// collaborator: the degraded-auth grant map (users who recently passed full
// route-side authorization, admitted on reconnect when the authorization DOs
// are unreachable) and the recently-accepted clientMessageId list (drops
// duplicate sends when the browser retransmits after a reconnect). All state
// lives in the DO's KV storage; the class itself is stateless and is cached
// for the owning DO's lifetime with closures over its live deps
// (ChatThreadDO keeps thin same-named private delegates as its internal API).
// Sibling-method calls route back through the deps callbacks — i.e. through
// the DO's delegates — so dynamic dispatch (and every
// `ChatThreadDO.prototype['method'].call(fake)` test seam that stubs a sibling
// on the fake) behaves exactly as it did when the bodies lived on the DO.
import type { SyncKvStorage } from "./pi-turn-journal";

// Users who have passed full route-side authorization for this thread,
// mapped to when they last did (ms). Used to admit reconnects when the
// authorization DOs are unreachable (degraded auth); never admits a user who
// has not recently connected with full auth, so revoked members age out
// instead of keeping a permanent fail-open grant.
const CHAT_AUTHORIZED_USERS_KEY = "chat_authorized_user_ids";
const CHAT_AUTHORIZED_USERS_MAX = 100;
const CHAT_DEGRADED_AUTH_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
// Avoid rewriting the grant map on every reconnect burst.
const CHAT_DEGRADED_AUTH_GRANT_REFRESH_MS = 5 * 60 * 1000;
// Recently accepted clientMessageIds, used to drop duplicate sends when the
// browser retransmits after a reconnect (it cannot know whether a message
// sent right before a socket drop was received).
const CHAT_RECENT_CLIENT_MESSAGE_IDS_KEY = "chat_recent_client_message_ids";
const CHAT_RECENT_CLIENT_MESSAGE_IDS_MAX = 200;

export interface ChatThreadAccessDeps {
  kv(): SyncKvStorage;
  // Sibling routing back through the owning DO's same-named delegate, so a
  // stubbed sibling on a fake (or a subclass override) is honored exactly as
  // it was when these methods lived on ChatThreadDO itself.
  readAuthorizedChatUserGrants(): Record<string, number>;
}

export class ChatThreadAccess {
  constructor(private readonly deps: ChatThreadAccessDeps) {}

  readAuthorizedChatUserGrants(): Record<string, number> {
    const value = this.deps.kv().get<unknown>(CHAT_AUTHORIZED_USERS_KEY);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // Includes the pre-TTL string[] format: discard rather than grant
      // untimestamped fail-open access.
      return {};
    }
    return value as Record<string, number>;
  }

  isPreviouslyAuthorizedChatUser(userId: string): boolean {
    const grantedAt = this.deps.readAuthorizedChatUserGrants()[userId];
    return (
      typeof grantedAt === "number" &&
      Date.now() - grantedAt < CHAT_DEGRADED_AUTH_GRANT_TTL_MS
    );
  }

  recordAuthorizedChatUser(userId: string): void {
    const grants = this.deps.readAuthorizedChatUserGrants();
    const now = Date.now();
    const existing = grants[userId];
    if (
      typeof existing === "number" &&
      now - existing < CHAT_DEGRADED_AUTH_GRANT_REFRESH_MS
    ) {
      return;
    }
    grants[userId] = now;
    const entries = Object.entries(grants)
      .filter(
        ([, grantedAt]) =>
          typeof grantedAt === "number" &&
          now - grantedAt < CHAT_DEGRADED_AUTH_GRANT_TTL_MS,
      )
      .sort(([, a], [, b]) => a - b);
    while (entries.length > CHAT_AUTHORIZED_USERS_MAX) entries.shift();
    this.deps.kv().put(
      CHAT_AUTHORIZED_USERS_KEY,
      Object.fromEntries(entries),
    );
  }

  hasRecentlyAcceptedClientMessage(clientMessageId: string): boolean {
    const ids = this.deps.kv().get<string[]>(
      CHAT_RECENT_CLIENT_MESSAGE_IDS_KEY,
    );
    return Array.isArray(ids) && ids.includes(clientMessageId);
  }

  recordAcceptedClientMessageId(clientMessageId: string): void {
    const ids = this.deps.kv().get<string[]>(
      CHAT_RECENT_CLIENT_MESSAGE_IDS_KEY,
    );
    const list = Array.isArray(ids) ? ids : [];
    list.push(clientMessageId);
    while (list.length > CHAT_RECENT_CLIENT_MESSAGE_IDS_MAX) list.shift();
    this.deps.kv().put(CHAT_RECENT_CLIENT_MESSAGE_IDS_KEY, list);
  }
}
