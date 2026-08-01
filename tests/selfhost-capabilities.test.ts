import { describe, expect, it } from "vitest";

import { CONNECTIONS_BINDING_DISABLED_MESSAGE } from "@/lib/connections-binding";
import {
  getSelfhostCapabilityContract,
  SELFHOST_CAPABILITY_CONTRACT_VERSION,
} from "@/lib/selfhost-capabilities";

describe("self-host capability contract", () => {
  it("reports configured compute without claiming runtime verification", () => {
    const contract = getSelfhostCapabilityContract({
      projectBuild: true,
      analysis: true,
      databaseQuery: true,
    });

    expect(contract.version).toBe(SELFHOST_CAPABILITY_CONTRACT_VERSION);
    for (const name of [
      "project_builds",
      "project_deploys",
      "notebooks",
      "sql",
    ] as const) {
      expect(contract.features[name]).toMatchObject({
        state: "configured",
        available: null,
        configured: true,
        implementation: "workerd-local-docker",
        verification: {
          status: "not_checked",
        },
      });
    }
    expect(contract.features.project_builds.verification?.command).toBe(
      "bun run selfhost:container:smoke:project",
    );
    expect(contract.features.notebooks.verification?.command).toBe(
      "bun run selfhost:container:smoke:analysis",
    );
    expect(contract.features.sql.verification?.command).toBe(
      "bun run selfhost:container:smoke:db-query",
    );
    expect(contract.features.connections_binding).toMatchObject({
      state: "configured",
      available: true,
      configured: true,
      implementation: "ConnectionsService",
    });
    expect(contract.features.outbound_email).toMatchObject({
      state: "disabled",
      available: false,
    });
    expect(contract.features.smtp).toMatchObject({
      state: "disabled",
      available: false,
    });
  });

  it("reports connections_binding disabled when the kill switch is off", () => {
    const contract = getSelfhostCapabilityContract({
      projectBuild: true,
      analysis: true,
      databaseQuery: true,
      CONNECTIONS_BINDING_ENABLED: "false",
    });

    expect(contract.features.connections_binding).toMatchObject({
      state: "disabled",
      available: false,
      configured: false,
      reason: CONNECTIONS_BINDING_DISABLED_MESSAGE,
    });
  });

  it("does not claim compute parity when a sandbox binding is missing", () => {
    const contract = getSelfhostCapabilityContract({
      projectBuild: false,
      analysis: true,
      databaseQuery: false,
    });

    expect(contract.features.project_builds).toMatchObject({
      state: "unavailable",
      available: false,
      reason: "PROJECT_BUILD_SANDBOX is not configured.",
    });
    expect(contract.features.project_deploys.available).toBe(false);
    expect(contract.features.notebooks).toMatchObject({
      state: "configured",
      available: null,
      configured: true,
    });
    expect(contract.features.sql).toMatchObject({
      state: "unavailable",
      available: false,
      reason: "DB_QUERY_SANDBOX is not configured.",
    });
  });
});
