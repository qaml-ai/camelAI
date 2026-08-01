import { describe, expect, it } from "vitest";

import {
  CONNECTIONS_BINDING_DISABLED_CODE,
  CONNECTIONS_BINDING_DISABLED_MESSAGE,
  assertConnectionsBindingEnabled,
  connectionsBindingEnabled,
} from "@/lib/connections-binding";

describe("connectionsBindingEnabled", () => {
  it("defaults to enabled when unset", () => {
    expect(connectionsBindingEnabled(undefined)).toBe(true);
    expect(connectionsBindingEnabled({})).toBe(true);
    expect(connectionsBindingEnabled({ CONNECTIONS_BINDING_ENABLED: "" })).toBe(
      true,
    );
    expect(
      connectionsBindingEnabled({ CONNECTIONS_BINDING_ENABLED: " true " }),
    ).toBe(true);
  });

  it("treats explicit falsey values as disabled", () => {
    for (const value of ["false", "FALSE", "0", "off", "no", "disabled"]) {
      expect(
        connectionsBindingEnabled({ CONNECTIONS_BINDING_ENABLED: value }),
        value,
      ).toBe(false);
    }
  });

  it("fails closed with a stable error when disabled", () => {
    expect(() =>
      assertConnectionsBindingEnabled({
        CONNECTIONS_BINDING_ENABLED: "false",
      }),
    ).toThrowError(
      expect.objectContaining({
        message: CONNECTIONS_BINDING_DISABLED_MESSAGE,
        status: 503,
        code: CONNECTIONS_BINDING_DISABLED_CODE,
      }),
    );
    expect(() => assertConnectionsBindingEnabled({})).not.toThrow();
  });
});
