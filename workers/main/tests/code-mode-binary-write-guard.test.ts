import { describe, expect, it } from "vitest";

import { assertNotBase64IntoBinaryFile } from "../src/code-mode-tools";

// The `write` tool stores content verbatim and has no encoding parameter, so
// base64 written to a binary filename produces a file that downloads but will
// not open. In production this happened silently: 9,556 characters of base64
// were written to outputs/…​.xlsx twice, both calls reported success, and the
// user got a broken download.
describe("base64-into-binary write guard", () => {
  const base64Payload = "UEsDBBQAAAAIAAig+FxGx01IlQAAAM0AAAAQAAAAZG9jUHJvcHMv".repeat(20);

  it("rejects base64 text written to a binary filename", () => {
    expect(() =>
      assertNotBase64IntoBinaryFile("outputs/Arichlinie_Resource_Breakdown.xlsx", base64Payload),
    ).toThrow(/corrupt \.xlsx/i);
  });

  it("points at the outputs mount that actually carries bytes", () => {
    let message = "";
    try {
      assertNotBase64IntoBinaryFile("outputs/report.xlsx", base64Payload);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("/outputs");
    expect(message).toContain("report.xlsx");
  });

  it("covers the binary formats agents actually generate", () => {
    for (const path of ["outputs/a.pdf", "outputs/b.zip", "outputs/c.png", "outputs/d.docx"]) {
      expect(() => assertNotBase64IntoBinaryFile(path, base64Payload)).toThrow();
    }
  });

  it("leaves ordinary text writes alone", () => {
    // Text formats are a perfectly good delivery path and must not be blocked —
    // falling back to CSV is the right move when a spreadsheet is not possible.
    expect(() => assertNotBase64IntoBinaryFile("outputs/report.csv", base64Payload)).not.toThrow();
    expect(() => assertNotBase64IntoBinaryFile("outputs/report.md", base64Payload)).not.toThrow();
    expect(() =>
      assertNotBase64IntoBinaryFile("outputs/notes.xlsx", "item,total\ndam,14841\n"),
    ).not.toThrow();
  });

  it("does not fire on short strings that merely look base64-ish", () => {
    expect(() => assertNotBase64IntoBinaryFile("outputs/tiny.png", "abc123")).not.toThrow();
  });
});
