import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionOnlyLoader, methodNotAllowed } from "@/lib/method-not-allowed";

const API_ROUTES_DIR = join(__dirname, "../src/routes/api");

describe("methodNotAllowed", () => {
  it("answers 405 with the allowed methods in the Allow header", async () => {
    const response = methodNotAllowed(["POST", "PUT", "DELETE"]);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, PUT, DELETE");
    await expect(response.json()).resolves.toEqual({ error: "Method not allowed" });
  });

  it("actionOnlyLoader returns a loader producing that 405", () => {
    const response = actionOnlyLoader("POST")();
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("the upload route answers GET with 405 instead of a missing-loader error", async () => {
    const route = await import("@/routes/api/workspaces.$id.upload");
    const response = (route.loader as () => Response)();
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, PUT, DELETE");
  });
});

describe("api resource routes", () => {
  it("every route that exports an action also exports a loader", () => {
    const exportsFn = (source: string, name: string) =>
      new RegExp(`^export (async )?(function|const) ${name}\\b`, "m").test(source);
    const missing = readdirSync(API_ROUTES_DIR)
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => {
        const source = readFileSync(join(API_ROUTES_DIR, file), "utf8");
        return exportsFn(source, "action") && !exportsFn(source, "loader");
      });
    expect(missing).toEqual([]);
  });
});
