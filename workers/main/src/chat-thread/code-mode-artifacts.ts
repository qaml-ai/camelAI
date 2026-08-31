// Code-mode artifact buffer for ChatThreadDO, extracted as a collaborator:
// the per-parent-tool-call KV artifact accumulation (recorded mid-js_exec by
// code-mode tools over RPC), live delivery onto the current turn's native
// stream as a reconciled data part, and the read/consume path used when the
// tool result is built. All state lives in the DO's KV storage and the DO's
// stream-bridge fields; the class itself is stateless and is constructed per
// access with closures over the owning DO's deps (ChatThreadDO keeps thin
// same-named delegates as its API — the public RPC wrappers
// recordCodeModeArtifact / consumeCodeModeArtifacts stay on the DO).
// Sibling-method calls route back through the deps callbacks — i.e. through
// the DO's delegates — so dynamic dispatch (and every
// `ChatThreadDO.prototype['method'].call(fake)` test seam that stubs a sibling
// on the fake) behaves exactly as it did when the bodies lived on the DO.
import {
  normalizeRuntimeCallArtifacts,
  type RuntimeCallArtifact,
} from "../../../../src/lib/runtime-artifacts";
import {
  piArtifactsPartId,
  type PiChunkEncoder,
  type PiUiMessageChunk,
} from "../../../../src/lib/pi-chunk-encoder";
import type { SyncKvStorage } from "./pi-turn-journal";
import type { PreviewTarget } from "./types";

const CODE_MODE_ARTIFACTS_KEY_PREFIX = 'codeModeArtifacts:';

export interface ChatThreadCodeModeArtifactsDeps {
  kv(): SyncKvStorage;
  /** The stateful encoder for the in-flight turn; null when no turn is bridging. */
  piChunkEncoder(): PiChunkEncoder | null;
  // DO-side operations (shared helpers whose behavior is owned elsewhere).
  enqueuePiStreamChunks(chunks: PiUiMessageChunk[]): void;
  setPreviewTarget(target: PreviewTarget | null): Promise<void>;
  // Sibling routing back through the owning DO's same-named delegates, so a
  // stubbed sibling on a fake (or a subclass override) is honored exactly as
  // it was when these methods lived on ChatThreadDO itself.
  deliverCodeModeArtifacts(
    parentToolUseId: string,
    artifacts: RuntimeCallArtifact[],
  ): void;
  codeModeArtifactsKey(parentToolUseId: string): string;
}

export class ChatThreadCodeModeArtifacts {
  constructor(private readonly deps: ChatThreadCodeModeArtifactsDeps) {}

  async recordCodeModeArtifact(
    parentToolUseId: string,
    artifact: RuntimeCallArtifact,
  ): Promise<void> {
    const normalizedParentToolUseId = parentToolUseId.trim();
    if (!normalizedParentToolUseId) return;
    const key = this.deps.codeModeArtifactsKey(normalizedParentToolUseId);
    const existing = this.deps.kv().get<RuntimeCallArtifact[]>(key);
    const artifacts = normalizeRuntimeCallArtifacts(existing);
    artifacts.push(artifact);
    this.deps.kv().put(key, artifacts);
    // Deliver the artifact to the client on the native stream as a standalone
    // data part reconciled by tool call id (full accumulated set each time). The
    // artifact is usually recorded mid-js_exec, possibly after item/completed
    // built the tool result, so a separate part — folded onto the tool_result by
    // uiMessageToMessage at read time — is the right shape. The durable KV row
    // above backs reload/backfill (surfaced onto the tool_result there too).
    this.deps.deliverCodeModeArtifacts(normalizedParentToolUseId, artifacts);
    await this.deps.setPreviewTarget({ kind: "runtime_artifact", artifact });
  }

  // Emit the code-mode artifacts data part into the current turn's native stream.
  // A no-op when no turn is bridging (encoder null) — the artifacts still persist
  // to KV above and reach the client via top-up backfill on the next connect.
  deliverCodeModeArtifacts(
    parentToolUseId: string,
    artifacts: RuntimeCallArtifact[],
  ): void {
    if (!this.deps.piChunkEncoder()) return;
    this.deps.enqueuePiStreamChunks([
      {
        type: "data-pi-artifacts",
        id: piArtifactsPartId(parentToolUseId),
        data: { toolCallId: parentToolUseId, artifacts },
      },
    ]);
  }

  async consumeCodeModeArtifacts(
    parentToolUseId: string,
    options: { deleteAfterRead?: boolean } = {},
  ): Promise<RuntimeCallArtifact[]> {
    const normalizedParentToolUseId = parentToolUseId.trim();
    if (!normalizedParentToolUseId) return [];
    const key = this.deps.codeModeArtifactsKey(normalizedParentToolUseId);
    const artifacts = normalizeRuntimeCallArtifacts(
      this.deps.kv().get<RuntimeCallArtifact[]>(key),
    );
    if (options.deleteAfterRead === true) {
      this.deps.kv().delete(key);
    }
    return artifacts;
  }

  codeModeArtifactsKey(parentToolUseId: string): string {
    return `${CODE_MODE_ARTIFACTS_KEY_PREFIX}${parentToolUseId}`;
  }
}
