import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_RUNTIME_ENV_DEFAULTS } from "../scripts/selfhost-agent-runtime.mjs";
import { readSelfhostEnv, repoRoot } from "../scripts/selfhost-common.mjs";
import { restoreReleaseState } from "../scripts/selfhost-release-restore.mjs";
import {
  ensureSelfhostSecrets,
  restoreSelfhostEnvSnapshot,
  SELFHOST_SECRET_DEFAULTS,
} from "../scripts/selfhost-secret-migrations.mjs";

const temporaryDirectories: string[] = [];
const repositoryCommit = "a".repeat(40);
const restoredAt = new Date("2026-11-05T12:34:56.789Z");
const runtimeValues = Object.fromEntries(
  AGENT_RUNTIME_ENV_DEFAULTS.map(([key]) => [key, `current-${key}`]),
);
const snapshotEnv = [
  "TOKEN_SIGNING_SECRET=snapshot-token",
  "ADMIN_API_KEY=snapshot-admin",
  `SELFHOST_APP_IMAGE=example.invalid/app@sha256:${"b".repeat(64)}`,
  "",
].join("\n");
const currentEnv = [
  "TOKEN_SIGNING_SECRET=current-token",
  "ADMIN_API_KEY=current-admin",
  `SELFHOST_APP_IMAGE=example.invalid/app@sha256:${"c".repeat(64)}`,
  ...Object.entries(runtimeValues).map(([key, value]) => `${key}=${value}`),
  "SELFHOST_AGENT_RUNTIME_OUTBOUND_ALLOW_ORIGINS=http://10.1.2.3:8000",
  "SELFHOST_RUNTIME_SWEEP=0",
  "",
].join("\n");
const metadata = {
  schema: 1,
  repositoryCommit,
  environmentFile: "env.selfhost",
};

async function restoreFixture(snapshot = snapshotEnv, current: string | null = currentEnv) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "camelai-release-restore-test-"));
  temporaryDirectories.push(directory);
  const snapshotDir = path.join(directory, "snapshot");
  const envPath = path.join(directory, ".env.selfhost");
  await fs.mkdir(snapshotDir);
  await fs.writeFile(path.join(snapshotDir, "runtime.json"), JSON.stringify(metadata));
  await fs.writeFile(path.join(snapshotDir, "env.selfhost"), snapshot);
  if (current !== null) await fs.writeFile(envPath, current, { mode: 0o644 });
  return { directory, snapshotDir, envPath };
}

function recordingRun(envPath: string) {
  const calls: Array<[string, string[]]> = [];
  const envSnapshots: string[] = [];
  const scriptEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const run = async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    calls.push([command, args]);
    envSnapshots.push(await fs.readFile(envPath, "utf8"));
    scriptEnvs.push(options.env);
  };
  return { calls, envSnapshots, scriptEnvs, run };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("self-host release restore", () => {
  it("keeps runtime values absent from a legacy snapshot and saves the replaced env privately", async () => {
    const { snapshotDir, envPath } = await restoreFixture();
    const { run, envSnapshots } = recordingRun(envPath);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await restoreReleaseState(snapshotDir, { envPath, run, now: () => restoredAt });

    const restoredText = await fs.readFile(envPath, "utf8");
    expect(AGENT_RUNTIME_ENV_DEFAULTS).toHaveLength(7);
    expect(Object.isFrozen(SELFHOST_SECRET_DEFAULTS)).toBe(true);
    expect(SELFHOST_SECRET_DEFAULTS.map(([key]) => key)).toEqual([
      "ADMIN_API_KEY",
      ...AGENT_RUNTIME_ENV_DEFAULTS.map(([key]) => key),
    ]);
    expect(await readSelfhostEnv(true, envPath)).toEqual({
      TOKEN_SIGNING_SECRET: "snapshot-token",
      ADMIN_API_KEY: "snapshot-admin",
      SELFHOST_APP_IMAGE: `example.invalid/app@sha256:${"b".repeat(64)}`,
      ...runtimeValues,
      // An operator's runtime setting outlives the rollback with the runtime.
      SELFHOST_AGENT_RUNTIME_OUTBOUND_ALLOW_ORIGINS: "http://10.1.2.3:8000",
    });
    // Other values only the newer release had are not carried.
    expect(restoredText).not.toContain("SELFHOST_RUNTIME_SWEEP");
    expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);
    expect(envSnapshots[0]).toBe(restoredText);
    expect(await fs.readFile(path.join(snapshotDir, "env.selfhost"), "utf8")).toBe(snapshotEnv);

    const replacedPath = path.join(snapshotDir, "env.selfhost.replaced-2026-11-05T12-34-56-789Z");
    expect(await fs.readFile(replacedPath, "utf8")).toBe(currentEnv);
    expect((await fs.stat(replacedPath)).mode & 0o777).toBe(0o600);
    expect(log).toHaveBeenCalledWith(`Saved the replaced .env.selfhost to ${path.relative(repoRoot, replacedPath)}.`);
    expect(log).toHaveBeenCalledWith(
      `Kept from the current .env.selfhost (the snapshot lacks them): ${[
        ...AGENT_RUNTIME_ENV_DEFAULTS.map(([key]) => key),
        "SELFHOST_AGENT_RUNTIME_OUTBOUND_ALLOW_ORIGINS",
      ].join(", ")}.`,
    );
  });

  it("checks out and configures the restored release before its detached refresh", async () => {
    const { snapshotDir, envPath } = await restoreFixture();
    const { calls, envSnapshots, scriptEnvs, run } = recordingRun(envPath);

    await restoreReleaseState(snapshotDir, { envPath, run, now: () => restoredAt });

    expect(calls).toEqual([
      ["git", ["checkout", "--detach", repositoryCommit]],
      ["bun", ["install", "--frozen-lockfile"]],
      ["bun", ["run", "selfhost:configure"]],
      [process.execPath, ["scripts/selfhost-upgrade.mjs", "--refresh", "--skip-backup"]],
    ]);
    const restoredText = await fs.readFile(envPath, "utf8");
    expect(envSnapshots).toEqual(Array(4).fill(restoredText));
    const restoredValues = await readSelfhostEnv(true, envPath);
    expect(scriptEnvs[2]).toMatchObject(restoredValues);
    expect(scriptEnvs[3]).toMatchObject(restoredValues);
    for (const [command, args] of calls) {
      expect(args).not.toContain("selfhost:up");
      if (command === "docker" && args.includes("compose") && args.includes("up")) {
        expect(args.includes("-d") || args.includes("--detach")).toBe(true);
      }
    }
  });

  it("can re-upgrade with existing runtime volumes, while a plain snapshot copy loses the secrets", async () => {
    const { directory, snapshotDir, envPath } = await restoreFixture();
    const { run } = recordingRun(envPath);
    await restoreReleaseState(snapshotDir, { envPath, run });

    const existingVolumes = async (names: string[]) => names;
    await expect(ensureSelfhostSecrets(envPath, { existingVolumes })).resolves.toEqual({ created: [] });

    const plainCopyPath = path.join(directory, ".env.selfhost-plain-copy");
    await fs.copyFile(path.join(snapshotDir, "env.selfhost"), plainCopyPath);
    await expect(ensureSelfhostSecrets(plainCopyPath, { existingVolumes })).rejects.toThrow(/Refusing to generate/);
    expect(await fs.readFile(plainCopyPath, "utf8")).toBe(snapshotEnv);
  });

  it("lets snapshot values win, replaces empty last definitions once, and keeps current quoting", async () => {
    const snapshot = [
      "AGENT_RUNTIME_SESSION_SECRET=snap",
      "AGENT_RUNTIME_SECRETS_KEY=stale",
      "# keep this comment in place",
      " AGENT_RUNTIME_SECRETS_KEY = ''",
      "TOKEN_SIGNING_SECRET=snapshot-token",
      "",
    ].join("\n");
    const current = [
      "AGENT_RUNTIME_SESSION_SECRET=cur",
      "AGENT_RUNTIME_SECRETS_KEY=stale-current",
      " AGENT_RUNTIME_SECRETS_KEY = 'current key'  ",
      "ADMIN_API_KEY=stale-admin",
      '  ADMIN_API_KEY="a b"  ',
      "TOKEN_SIGNING_SECRET=current-token",
      "UNMANAGED_VALUE=discard",
      "",
    ].join("\n");
    const { snapshotDir, envPath } = await restoreFixture(snapshot, current);

    await expect(restoreSelfhostEnvSnapshot(path.join(snapshotDir, "env.selfhost"), envPath)).resolves.toEqual({
      kept: ["ADMIN_API_KEY", "AGENT_RUNTIME_SECRETS_KEY"],
    });

    const text = await fs.readFile(envPath, "utf8");
    expect(text).toBe([
      "AGENT_RUNTIME_SESSION_SECRET=snap",
      "AGENT_RUNTIME_SECRETS_KEY = 'current key'",
      "# keep this comment in place",
      "TOKEN_SIGNING_SECRET=snapshot-token",
      'ADMIN_API_KEY="a b"',
      "",
    ].join("\n"));
    expect(text.match(/^\s*AGENT_RUNTIME_SECRETS_KEY\s*=/gm)).toHaveLength(1);
  });

  it("keeps the runtime's settings the snapshot lacks, and lets the snapshot's own win", async () => {
    const { snapshotDir, envPath } = await restoreFixture(
      "SELFHOST_AGENT_RUNTIME_PORT=8790\n",
      "SELFHOST_AGENT_RUNTIME_PORT=9000\nAGENT_RUNTIME_CHIRIDION_URL=http://127.0.0.1:3002\nSELFHOST_RUNTIME_SWEEP=0\n",
    );

    await expect(restoreSelfhostEnvSnapshot(path.join(snapshotDir, "env.selfhost"), envPath)).resolves.toEqual({
      kept: ["AGENT_RUNTIME_CHIRIDION_URL"],
    });
    expect(await fs.readFile(envPath, "utf8")).toBe(
      "SELFHOST_AGENT_RUNTIME_PORT=8790\nAGENT_RUNTIME_CHIRIDION_URL=http://127.0.0.1:3002\n",
    );
  });

  it("does not keep an earlier current value when its last definition is empty", async () => {
    const { snapshotDir, envPath } = await restoreFixture(
      "TOKEN_SIGNING_SECRET=snapshot\n",
      'ADMIN_API_KEY=stale\nADMIN_API_KEY=""\nAGENT_RUNTIME_SECRETS_KEY=stale\nAGENT_RUNTIME_SECRETS_KEY=\n',
    );

    await expect(restoreSelfhostEnvSnapshot(path.join(snapshotDir, "env.selfhost"), envPath)).resolves.toEqual({ kept: [] });
    expect(await fs.readFile(envPath, "utf8")).toBe("TOKEN_SIGNING_SECRET=snapshot\n");
  });

  it("restores a missing current env without creating a replaced copy or changing snapshot contents", async () => {
    const snapshot = "# snapshot\r\nADMIN_API_KEY=snapshot-admin\r\n\r\n";
    const { snapshotDir, envPath } = await restoreFixture(snapshot, null);
    const { run, envSnapshots } = recordingRun(envPath);

    await restoreReleaseState(snapshotDir, { envPath, run });

    expect(await fs.readFile(envPath, "utf8")).toBe(snapshot);
    expect(envSnapshots[0]).toBe(snapshot);
    expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(snapshotDir)).toEqual(["env.selfhost", "runtime.json"]);
  });

  it.each([
    ["schema", { ...metadata, schema: 2 }],
    ["commit type", { ...metadata, repositoryCommit: 123 }],
    ["commit format", { ...metadata, repositoryCommit: "not-a-commit" }],
    ["environment filename", { ...metadata, environmentFile: "other.env" }],
  ])("rejects invalid snapshot %s before touching the env or running commands", async (_name, invalidMetadata) => {
    const { snapshotDir, envPath } = await restoreFixture();
    const metadataPath = path.join(snapshotDir, "runtime.json");
    await fs.writeFile(metadataPath, JSON.stringify(invalidMetadata));
    const { run, calls, envSnapshots } = recordingRun(envPath);

    await expect(restoreReleaseState(snapshotDir, { envPath, run })).rejects.toThrow(
      `Invalid release snapshot metadata: ${metadataPath}`,
    );

    expect(await fs.readFile(envPath, "utf8")).toBe(currentEnv);
    expect(calls).toEqual([]);
    expect(envSnapshots).toEqual([]);
    expect(await fs.readdir(snapshotDir)).toEqual(["env.selfhost", "runtime.json"]);
  });

  it("rejects malformed snapshot JSON before saving or replacing the current env", async () => {
    const { snapshotDir, envPath } = await restoreFixture();
    await fs.writeFile(path.join(snapshotDir, "runtime.json"), "{");
    const { run, calls } = recordingRun(envPath);

    await expect(restoreReleaseState(snapshotDir, { envPath, run })).rejects.toThrow(SyntaxError);

    expect(await fs.readFile(envPath, "utf8")).toBe(currentEnv);
    expect(calls).toEqual([]);
    expect(await fs.readdir(snapshotDir)).toEqual(["env.selfhost", "runtime.json"]);
  });
});
