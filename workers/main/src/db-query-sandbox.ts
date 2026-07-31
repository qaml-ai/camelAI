import { Sandbox } from "@cloudflare/sandbox";

import { createSingleFlight, isMountAlreadyPresent } from "./analysis-sandbox.js";
import { DB_QUERY_SLEEP_AFTER } from "./container-sizing.js";
import type { Env } from "./types.js";

/** R2 binding name the export mount resolves against (credential-less mount). */
const WAREHOUSE_EXPORT_BUCKET_BINDING = "WAREHOUSE_EXPORT_BUCKET";

/**
 * Trusted query-execution container with static-IP database egress.
 *
 * Runs NO user code. The query logic is NOT baked in either: db-query-service.ts
 * ships the runner (db-query-sandbox-assets/runner/db-query-runner.mjs) into the
 * container per call by piping it into `node` over stdin (a single stateless
 * exec) and dials the database through the sandbox-host SOCKS relay, so customer
 * databases always see the VM's static egress IP (SANDBOX_OUTBOUND_IP). The
 * image only carries node, the DB drivers, and cloudflared. Authorization
 * happens entirely worker-side BEFORE a query reaches the container.
 *
 * NETWORK POSTURE — `enableInternet = true`. The container needs public DNS to
 * resolve customer database hostnames (raw UDP/TCP egress, which an internet-off
 * container cannot do — the sandbox returns a synthetic address). It does NOT
 * mean the database sees the container's IP: the STATIC-IP guarantee is enforced
 * by the RUNNER, which in relay mode dials the database through the on-host SOCKS
 * relay (`cloudflared access tcp` → tunnel → gost), so egress is always the VM's
 * static IP. With no relay configured the runner dials directly (the opt-out).
 * The runner applies the SSRF guard in both modes, and gost re-applies the same
 * denylist VM-side.
 *
 * HTTPS interception stays on (`interceptHttps = true`) — independent of the
 * internet switch — for two things: the `cloudflared access tcp` WSS to the
 * relay host (opened per-run via `ensureRelayEgress`), and the credential-less
 * R2 export mount (egress interception → the R2 binding, no S3 keys in the
 * container), the same mechanism `AnalysisSandbox` uses.
 *
 * DATA OUT (exports): the workspace's warehouse R2 prefix is mounted READ-WRITE
 * via that credential-less bucket mount, so the export runner writes Parquet
 * extracts straight to R2. One sandbox per workspace + a prefix-scoped mount
 * keeps the bucket multi-tenant-safe.
 */
export class DbQuerySandbox extends Sandbox<Env> {
  // Internet on so the container can resolve customer DB hostnames; the static
  // IP is preserved by the runner routing DB traffic through the relay (see the
  // class doc). Both relay and direct modes run with internet on.
  enableInternet = true;
  // HTTPS interception governs the relay's cloudflared WSS and the R2 export
  // mount — kept on regardless of the internet switch.
  interceptHttps = true;
  // Queries/exports are short-lived; sleep promptly to cut provisioned memory/disk.
  sleepAfter = DB_QUERY_SLEEP_AFTER;

  // Mount paths already established in this container + a per-path single-flight
  // gate (same pattern as AnalysisSandbox.ensureMounted). Instance state on a
  // DO — not a module-level cache — so nothing leaks across containers.
  private readonly mountedPaths = new Set<string>();
  private readonly mountGates = new Map<string, (run: () => Promise<void>) => Promise<void>>();

  /**
   * Ensure the relay host is reachable through HTTPS interception for the
   * container's `cloudflared access tcp` forwarder. Called by db-query-service.ts
   * before each relay-mode run; cheap on a warm container.
   */
  async ensureRelayEgress(relayHostname: string): Promise<void> {
    await this.setAllowedHosts([relayHostname]);
  }

  /**
   * Mount the workspace's warehouse export prefix READ-WRITE at `/<prefix>`,
   * so an export staged at R2 key `<prefix>/x` is written at `/<prefix>/x` —
   * the same `'/' + r2_key` contract the analysis container reads with. At
   * most one mount attempt per path per container life; an already-mounted
   * error from a previous life counts as success.
   */
  async ensureWarehouseExportMount(prefix: string): Promise<void> {
    const mountPath = `/${prefix}`;
    if (this.mountedPaths.has(mountPath)) return;
    let gate = this.mountGates.get(mountPath);
    if (!gate) {
      gate = createSingleFlight();
      this.mountGates.set(mountPath, gate);
    }
    await gate(async () => {
      try {
        await this.mountBucket(WAREHOUSE_EXPORT_BUCKET_BINDING, mountPath, {
          prefix: mountPath,
          readOnly: false,
          // Shrink the s3fs stat cache so a re-export of the same key doesn't
          // read/write through a stale view (matches the analysis mounts).
          s3fsOptions: ["stat_cache_expire=1"],
        });
      } catch (error) {
        if (!isMountAlreadyPresent(error)) throw error;
      }
      this.mountedPaths.add(mountPath);
    });
  }
}
