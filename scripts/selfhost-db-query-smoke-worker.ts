// Worker for `selfhost-container-smoke.mjs db-query`: drives the real
// DbQueryContainer against the db-query image under workerd's localDocker
// engine, through the calls db-query-service.ts makes.

import { DbQueryContainer } from "../workers/main/src/db-query-container.ts";
import { getDbQueryContainer, runDbQuery } from "../workers/main/src/db-query-service.ts";

export { DbQueryContainer };

interface SmokeEnv {
  SANDBOX: DurableObjectNamespace<DbQueryContainer>;
  WAREHOUSE_EXPORT_BUCKET: R2Bucket;
  SMOKE_PUBLIC_DB?: string;
}

const MARKER = "camelai-db-query-ok";
// The runner command pipes DB_RUNNER_SRC into `node --input-type=module`, so
// these ES modules ride in it like the real runner does.
const DRIVERS = `import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/");
for (const m of ["pg", "pg-cursor", "mysql2", "tedious", "@dsnp/parquetjs", "socks"]) require.resolve(m);
console.log("drivers-ok");`;
const COUNT_CLOUDFLARED = `import fs from "node:fs";
const count = fs.readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d)).filter((d) => {
  try { return fs.readFileSync("/proc/" + d + "/comm", "utf8").trim() === "cloudflared"; } catch { return false; }
}).length;
console.log(count);`;
const WRITE_EXPORT = `import fs from "node:fs";
import path from "node:path";
fs.mkdirSync(path.dirname(process.env.DB_EXPORT_PATH), { recursive: true });
fs.writeFileSync(process.env.DB_EXPORT_PATH, "camelai-export-ok");`;
const EXPORT_EXISTS = `import fs from "node:fs";
console.log(fs.existsSync(process.env.DB_EXPORT_PATH) ? "left" : "gone");`;

/** The runner is `printf "$DB_RUNNER_SRC" | node`, so any script can ride in it. */
function script(source: string, extra: Record<string, string> = {}): Record<string, string> {
  return { DB_RUNNER_SRC: source, ...extra };
}

export default {
  async fetch(_request: Request, env: SmokeEnv): Promise<Response> {
    const container = getDbQueryContainer({ DB_QUERY_SANDBOX: env.SANDBOX }, "ws-selfhost-smoke");
    try {
      await container.start();
      const drivers = await container.runRunner(script(DRIVERS), 60_000);
      if (drivers.stdout.trim() !== "drivers-ok") return Response.json({ ...drivers, success: false, step: "drivers" });

      // The relay forwarder's lifecycle with the real cloudflared, which
      // listens before it dials the relay. Starting it twice leaves one.
      await container.startRelayForwarder({ hostname: "relay.invalid" });
      await container.startRelayForwarder({ hostname: "relay.invalid" });
      let forwarderUp = false;
      for (let attempt = 0; attempt < 60 && !forwarderUp; attempt += 1) {
        forwarderUp = await container.relayForwarderReady();
        if (!forwarderUp) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const forwarders = await container.runRunner(script(COUNT_CLOUDFLARED), 10_000);

      // A self-host export: the runner writes into the prepared prefix, and
      // publishing moves the file into the R2 binding (a write-only sync mount).
      const prefix = "warehouse/ws-selfhost-smoke";
      const exportPath = `/${prefix}/conn/q.parquet`;
      await container.prepareWarehouseExport(prefix);
      const wrote = await container.runRunner(
        script(WRITE_EXPORT, { DB_EXPORT_PATH: exportPath }),
        10_000,
      );
      await container.publishWarehouseExport(prefix, exportPath);
      const exported = await env.WAREHOUSE_EXPORT_BUCKET.get(exportPath.slice(1));
      const leftover = await container.runRunner(
        script(EXPORT_EXISTS, { DB_EXPORT_PATH: exportPath }),
        10_000,
      );

      const timedOut = await container.runRunner(script("setTimeout(() => {}, 30000)"), 1_000);

      let publicDb = "skipped";
      if (env.SMOKE_PUBLIC_DB === "1") {
        // RNAcentral's public read-only Postgres, dialed directly (no relay).
        const result = await runDbQuery({ container, relay: null }, {
          engine: "postgres",
          target: {
            host: "hh-pgsql-public.ebi.ac.uk",
            port: 5432,
            user: "reader",
            password: "NWDMCE5xdipIjRrp",
            database: "pfmegrnargs",
            sslMode: "disable",
          },
          sql: "select 42 as answer",
          timeoutMs: 30_000,
        });
        publicDb = result.ok && result.rows[0]?.answer === 42 ? "ok" : JSON.stringify(result).slice(0, 500);
      }

      const checks = {
        forwarderUp,
        oneForwarder: forwarders.stdout.trim() === "1",
        exportWritten: wrote.exitCode === 0,
        exportPublished: exported !== null && (await exported.text()) === "camelai-export-ok",
        localCopyRemoved: leftover.stdout.trim() === "gone",
        timeout: timedOut.timedOut,
        publicDb: publicDb === "ok" || publicDb === "skipped",
      };
      if (Object.values(checks).includes(false)) {
        return Response.json({ success: false, checks, publicDb, forwarders, drivers, wrote });
      }
      return Response.json({ success: true, stdout: `${MARKER} publicDb=${publicDb}` });
    } finally {
      await container.destroy();
    }
  },
};
