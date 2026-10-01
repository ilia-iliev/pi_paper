import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { parsePaperSource } from "../src/paper-source.js";
import { PaperHistory } from "../src/history.js";

async function historyFixture(t: TestContext) {
  const work = await mkdtemp(join(tmpdir(), "pi-paper-history-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const directory = join(work, "state");
  return { work, directory, history: new PaperHistory(directory) };
}

test("history defaults to Attention Is All You Need", async (t) => {
  const { history } = await historyFixture(t);
  assert.deepEqual(await history.source(), parsePaperSource("1706.03762"));
});

test("history remembers a canonical arXiv URL across instances", async (t) => {
  const { directory, history } = await historyFixture(t);
  const source = parsePaperSource("https://arxiv.org/abs/2401.12345v2");
  await history.remember(source);
  assert.deepEqual(await new PaperHistory(directory).source(), source);
  assert.equal(await readFile(join(directory, "last-paper"), "utf8"), `${source.url}\n`);
});

test("history stores relative local PDFs as absolute paths", async (t) => {
  const { work, directory, history } = await historyFixture(t);
  const pdfPath = join(work, "paper.pdf");
  await writeFile(pdfPath, "%PDF-1.4\n");
  const source = parsePaperSource(relative(process.cwd(), pdfPath));
  await history.remember(source);
  assert.equal(await readFile(join(directory, "last-paper"), "utf8"), `${pdfPath}\n`);
  assert.equal((await new PaperHistory(directory).source()).localPath, pdfPath);
});

test("explicit selection does not overwrite history until remembered", async (t) => {
  const { history } = await historyFixture(t);
  const oldSource = parsePaperSource("2401.12345");
  await history.remember(oldSource);
  assert.deepEqual(await history.source("1706.03762"), parsePaperSource("1706.03762"));
  await assert.rejects(history.source("https://arxiv.org/abs/not-a-paper"), /Invalid arXiv identifier/);
  assert.deepEqual(await history.source(), oldSource);
});

test("title lookup saves the resolved URL so reopening needs no search", async (t) => {
  const { directory, history } = await historyFixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response(
    '<feed><entry><id>https://arxiv.org/abs/1706.03762</id><title>Attention Is All You Need</title></entry></feed>',
  ));
  const source = await history.source("Attention Is All You Need");
  await history.remember(source);
  assert.equal(await readFile(join(directory, "last-paper"), "utf8"), "https://arxiv.org/pdf/1706.03762.pdf\n");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected search"); });
  assert.equal((await history.source()).url, source.url);
});

test("invalid saved state remains visible rather than silently opening a different paper", async (t) => {
  const { directory, history } = await historyFixture(t);
  await history.remember(parsePaperSource("1706.03762"));
  await writeFile(join(directory, "last-paper"), "invalid");
  await assert.rejects(history.source(), /Invalid arXiv identifier/);
});
