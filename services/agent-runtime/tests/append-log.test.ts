import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAppendLog } from "../shared/append-log.ts";
import { Transcript, readTranscript, type TranscriptRecord } from "../src/transcript.ts";

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "append-log-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("appends are buffered until flushed and survive reopening", async t => {
  const path = join(await directory(t), "log.jsonl");
  const log = fileAppendLog<{ n: number }>(path);
  log.append({ n: 1 }); log.append({ n: 2 });
  assert.deepEqual(await fileAppendLog(path).read(), []);
  await log.flush(true);
  log.append({ n: 3 });
  await log.flush();
  await log.close();
  assert.deepEqual(await fileAppendLog(path).read(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("a torn final record from a crash is dropped, but corruption elsewhere is an error", async t => {
  const path = join(await directory(t), "log.jsonl");
  await appendFile(path, '{"n":1}\n{"n":2}\n{"n":');
  assert.deepEqual(await fileAppendLog(path).read(), [{ n: 1 }, { n: 2 }]);
  await appendFile(path, '\n{"n":4}\n');
  await assert.rejects(fileAppendLog(path).read(), /Corrupt append log record 3/);
});

test("rewrite folds the log from a snapshot taken inside the write sequence", async t => {
  const path = join(await directory(t), "log.jsonl");
  const log = fileAppendLog<{ n: number }>(path);
  const state: number[] = [];
  const add = (n: number) => { state.push(n); log.append({ n }); };
  add(1); add(2);
  const folding = log.rewrite(() => state.map(n => ({ n })));
  add(3); // Appended after the fold was requested, before it ran: the snapshot includes it.
  await folding;
  add(4);
  await log.flush();
  assert.equal(log.appendedSinceRewrite, 1);
  assert.deepEqual(await fileAppendLog(path).read(), [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
});

test("transcript appends one record per message and imports a legacy snapshot once", async t => {
  const root = await directory(t);
  await appendFile(join(root, "session.json"), JSON.stringify({ version: 1, active: true, messages: [{ role: "user", content: "legacy", timestamp: 1 }] }));
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(join(root, "transcript.jsonl")));
  await transcript.load(join(root, "session.json"));
  assert.equal(transcript.active, true);
  assert.equal(transcript.messages.length, 1);
  await transcript.setActive(false);
  await transcript.push({ role: "user", content: "next", timestamp: 2 });
  await transcript.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "503", timestamp: 3 } as any);
  await transcript.retract();
  const lines = (await readFile(join(root, "transcript.jsonl"), "utf8")).trim().split("\n");
  assert.deepEqual(lines.map(line => JSON.parse(line).t), ["reset", "turn", "turn", "message", "message", "retract"]);
  assert.deepEqual((await readTranscript(root)).map(m => (m as { content: unknown }).content), ["legacy", "next"]);
  await assert.rejects(readFile(join(root, "session.json")), /ENOENT/);
});
