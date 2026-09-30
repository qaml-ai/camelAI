/**
 * import_file: copy a runtime thread's scratch file (/workspace/...) into the
 * camelAI workspace. The runtime fills the `source` of a `{"$file": path}`
 * argument with a signed link to that file; the tool reads only such links.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_MODE_TOOL_DEFINITIONS, CodeModeToolsBinding } from "../src/code-mode-tools";
import { agentMcpTools } from "../src/routes/agent-mcp";

const RUNTIME = "https://agents.test";
const PROPS = { orgId: "org1", workspaceId: "ws1", threadId: "thread1", userId: "user1" };
type Method = (this: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const methods = CodeModeToolsBinding.prototype as unknown as Record<string, Method>;

function binding(props: Record<string, unknown> = PROPS) {
  const instance = Object.create(CodeModeToolsBinding.prototype) as Record<string, unknown>;
  const writes: Array<{ destination: unknown; path: string; bytes: string; contentType?: string }> = [];
  Object.assign(instance, { ctx: { props }, env: { AGENT_RUNTIME_URL: RUNTIME } });
  Object.defineProperty(instance, "writeMoveDestinationFile", {
    value: async (destination: { location: string }, path: string, bytes: Uint8Array, contentType?: string) => {
      writes.push({ destination, path, bytes: new TextDecoder().decode(bytes), contentType });
      return { path, bytes: bytes.byteLength };
    },
  });
  return { instance, writes };
}

afterEach(() => vi.restoreAllMocks());

function serveLink(body: string, headers: Record<string, string> = { "Content-Type": "text/csv" }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === RUNTIME && url.pathname.startsWith("/v1/links/")) return new Response(body, { headers });
    return new Response("unexpected", { status: 500 });
  });
}

describe("import_file", () => {
  it("is offered to the runtime with a URL source, so the runtime fills it from {\"$file\"}", () => {
    const definition = CODE_MODE_TOOL_DEFINITIONS.find((tool) => tool.name === "import_file")!;
    const schema = JSON.parse(JSON.stringify(definition.parameters)) as { properties: { source: { format?: string } }; required: string[] };
    expect(schema.properties.source.format).toBe("uri");
    expect(schema.required).toEqual(expect.arrayContaining(["source", "destination"]));
    expect(agentMcpTools().some((tool) => tool.name === "import_file")).toBe(true);
  });

  it("copies the linked scratch file into the workspace", async () => {
    const fetch = serveLink("a,b\n1,2\n");
    const { instance, writes } = binding();
    const result = await methods.importFile.call(instance, {
      source: `${RUNTIME}/v1/links/tok123/data.csv`,
      destination: { location: "r2", path: "outputs/data.csv" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([{ destination: expect.objectContaining({ location: "r2", path: "outputs/data.csv" }), path: "outputs/data.csv", bytes: "a,b\n1,2\n", contentType: "text/csv" }]);
    expect(result).toMatchObject({ details: { destination: { location: "r2", path: "outputs/data.csv" }, bytes: 8 } });
  });

  it("reads only the runtime's signed links", async () => {
    const fetch = serveLink("x");
    const { instance, writes } = binding();
    for (const source of ["https://evil.test/v1/links/tok/x", `${RUNTIME}/v1/agents/a/history`, "/workspace/x.csv", "file:///etc/passwd"]) {
      await expect(methods.importFile.call(instance, { source, destination: { location: "r2", path: "outputs/x" } }))
        .rejects.toThrow(/scratch file/);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("reads the hosted runtime's links at either of its names through AGENT_RUNTIME_URL", async () => {
    const hosted = "https://agents.camelai.dev";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.origin === hosted && url.pathname.startsWith("/v1/links/") ? new Response("csv", { headers: { "Content-Type": "text/csv" } }) : new Response("unexpected", { status: 500 });
    });
    const { instance, writes } = binding();
    Object.assign(instance, { env: { AGENT_RUNTIME_URL: hosted } });
    for (const origin of ["https://run.camelai.com", hosted]) {
      await methods.importFile.call(instance, { source: `${origin}/v1/links/tok.mac/data.csv`, destination: { location: "r2", path: "outputs/data.csv" } });
    }
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([`${hosted}/v1/links/tok.mac/data.csv`, `${hosted}/v1/links/tok.mac/data.csv`]);
    expect(writes).toHaveLength(2);
    await expect(methods.importFile.call(instance, { source: "https://run.camelai.dev/v1/links/tok/x", destination: { location: "r2", path: "outputs/x" } }))
      .rejects.toThrow(/scratch file/);
  });

  it("refuses files larger than it copies", async () => {
    serveLink("x", { "Content-Type": "text/plain", "Content-Length": String(65 * 1024 * 1024) });
    const { instance, writes } = binding();
    await expect(methods.importFile.call(instance, { source: `${RUNTIME}/v1/links/tok/big.bin`, destination: { location: "r2", path: "outputs/big.bin" } }))
      .rejects.toThrow(/too large/);
    expect(writes).toHaveLength(0);
  });
});
