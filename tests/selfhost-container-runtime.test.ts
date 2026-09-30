import { readFileSync } from "node:fs";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  caddyConfigLoadCommands,
  composeArgs,
  scriptEnv,
} from "../scripts/selfhost-common.mjs";

type ComposeService = {
  image?: string;
  build?: { context?: string; dockerfile?: string };
  depends_on?: Record<string, { condition?: string }>;
  entrypoint?: string[];
  volumes?: string[];
};

type ComposeConfig = {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

const composeSource = readFileSync("docker-compose.selfhost.yml", "utf8");
const compose = parse(composeSource) as ComposeConfig;
const sourceOverrideSource = readFileSync(
  "docker-compose.selfhost.source.yml",
  "utf8",
);
const sourceOverride = parse(sourceOverrideSource) as ComposeConfig;
const analysisDockerfile = readFileSync(
  "workers/main/analysis-container.Dockerfile",
  "utf8",
);
const containerSmoke = readFileSync(
  "scripts/selfhost-container-smoke.mjs",
  "utf8",
);

describe("self-host Docker container runtime", () => {
  it("runs the app from an operator-selected immutable image", () => {
    const app = compose.services.app;
    expect(app.image).toContain("SELFHOST_APP_IMAGE");
    expect(app.build).toBeUndefined();
    expect(app.volumes).not.toContain(".:/workspace");
    expect(app.volumes).toContain(
      "${SELFHOST_DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock:rw",
    );
    expect(compose.volumes).not.toHaveProperty("app-node-modules");
    expect(compose.volumes).not.toHaveProperty("bun-cache");
  });

  it.each([
    [
      "project-build-image",
      "workers/main",
      "project-build-container.Dockerfile",
    ],
    ["analysis-image", "workers/main", "analysis-container.Dockerfile"],
    ["db-query-image", "workers/main", "db-query-container.Dockerfile"],
  ])("builds %s from the current Cloudflare container Dockerfile only in source mode", (
    serviceName,
    context,
    dockerfile,
  ) => {
    const service = compose.services[serviceName];
    expect(service.build).toBeUndefined();
    expect(service.image).toMatch(/SELFHOST_.*_IMAGE/);
    expect(sourceOverride.services[serviceName].build).toEqual({
      context,
      dockerfile,
    });
    expect(compose.services.app.depends_on?.[serviceName]?.condition).toBe(
      "service_completed_successfully",
    );
  });

  it("uses a prebuilt local-artifacts image in release mode", () => {
    expect(compose.services["local-artifacts"].image).toContain(
      "SELFHOST_LOCAL_ARTIFACTS_IMAGE",
    );
    expect(compose.services["local-artifacts"].build).toBeUndefined();
    expect(sourceOverride.services["local-artifacts"].build).toEqual({
      context: ".",
      dockerfile: "infra/selfhost/local-artifacts.Dockerfile",
    });
  });

  it("pulls the pinned container egress helper before starting workerd", () => {
    const service = compose.services["container-egress-image"];
    expect(service.image).toContain("SELFHOST_CONTAINER_EGRESS_IMAGE");
    expect(service.build).toBeUndefined();
    expect(service.entrypoint).toEqual(["/bin/true"]);
    expect(sourceOverride.services["container-egress-image"].build).toEqual({
      context: "workers/main/eval-egress-fix",
      dockerfile: "Dockerfile",
    });
    expect(
      compose.services.app.depends_on?.["container-egress-image"]?.condition,
    ).toBe("service_completed_successfully");
  });

  it("adds source builds only for explicit source deployments", () => {
    const releaseArgs = composeArgs(
      { SELFHOST_DEPLOYMENT_MODE: "release" },
      ["config"],
    );
    const sourceArgs = composeArgs(
      { SELFHOST_DEPLOYMENT_MODE: "source" },
      ["config"],
    );
    expect(releaseArgs.filter((arg) => arg.endsWith(".source.yml"))).toEqual([]);
    expect(sourceArgs.filter((arg) => arg.endsWith(".source.yml"))).toHaveLength(
      1,
    );
    expect(
      scriptEnv({ SELFHOST_DEPLOYMENT_MODE: "source" })
        .SELFHOST_CONTAINER_EGRESS_IMAGE,
    ).toBe("camelai-selfhost-container-egress:0.12.0");
  });

  it("ships and exercises safe ZIP handling in the self-host analysis image", () => {
    expect(analysisDockerfile).toContain(
      "COPY analysis-sandbox-assets/archive-tool.py /usr/local/bin/camelai-archive",
    );
    expect(containerSmoke).toContain('native: "analysis"');
    expect(containerSmoke).toContain("CAMELAI_ARCHIVE_PATH=/uploads/source.zip");
    expect(containerSmoke).toContain("camelai-analysis-archive-ok");
  });

  it("explicitly reloads bind-mounted Caddy configuration", () => {
    const [startArgs, reloadArgs] = caddyConfigLoadCommands(
      {
        SELFHOST_DEPLOYMENT_MODE: "release",
        SELFHOST_TLS_MODE: "external",
      },
    );
    expect(startArgs.slice(startArgs.indexOf("up"))).toEqual([
      "up",
      "--detach",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "60",
      "caddy",
    ]);
    expect(reloadArgs.slice(reloadArgs.indexOf("exec"))).toEqual([
      "exec",
      "-T",
      "caddy",
      "caddy",
      "reload",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ]);

    const [sourceStartArgs] = caddyConfigLoadCommands({
      SELFHOST_DEPLOYMENT_MODE: "source",
      SELFHOST_TLS_MODE: "external",
    }, { build: true });
    expect(sourceStartArgs).toContain("--build");
  });

  it("contains no retired project runtime bridge", () => {
    expect(compose.services).not.toHaveProperty("project-runtime");
    expect(composeSource).not.toMatch(
      /PROJECT_RUNTIME|PROJECT_RUNTIME_HOST|SANDBOX_HOST/,
    );
  });
});
