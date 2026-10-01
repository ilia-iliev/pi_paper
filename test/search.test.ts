import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePaperSource } from "../src/paper-source.js";

function feed(papers: { id: string; title: string }[]): string {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${papers.map(({ id, title }) =>
    `<entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title></entry>`).join("")}</feed>`;
}

const papers = [
  { id: "2501.00001", title: "Evaluating DeepSeek-V4.1 on Reasoning Tasks" },
  { id: "2501.00002v2", title: "DeepSeek-V4.1 Technical Report" },
  { id: "2501.00003", title: "DeepSeek-V4 Technical Report" },
  { id: "2501.00004", title: "DeepSeek-V4.10 Technical Report" },
];

test("paper names resolve through arXiv without an agent or API key", async (t) => {
  const requests: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, options: RequestInit) => {
    requests.push(new URL(input));
    assert.ok(options.signal);
    return new Response(feed(papers));
  });
  const source = await resolvePaperSource("DeepSeek-v4.1");
  assert.equal(source.url, "https://arxiv.org/pdf/2501.00002v2.pdf");
  assert.equal(source.label, "DeepSeek-V4.1 Technical Report");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].origin, "https://export.arxiv.org");
  assert.match(requests[0].searchParams.get("search_query")!, /ti:"deepseek"/);
});

test("title matching ignores case, punctuation and spacing", async (t) => {
  const queries: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    queries.push(new URL(input).searchParams.get("search_query")!);
    return new Response(feed(papers));
  });
  assert.equal((await resolvePaperSource("deepseek v4.1")).url, "https://arxiv.org/pdf/2501.00002v2.pdf");
  assert.equal((await resolvePaperSource("DeepSeekV4.1")).url, "https://arxiv.org/pdf/2501.00002v2.pdf");
  assert.equal(queries[0], queries[1]);
});

test("minor title typos match, and Atom titles are decoded", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(feed([
    { id: "1706.03762", title: "Attention Is All\n You Need" },
    { id: "1706.00001", title: "Attention for Machine Translation" },
  ])));
  assert.equal((await resolvePaperSource("Attention Is All You Ned")).url, "https://arxiv.org/pdf/1706.03762.pdf");
  t.mock.method(globalThis, "fetch", async () => new Response(feed([
    { id: "2501.00001", title: "Search &amp; Retrieval &#8212; A Report" },
  ])));
  assert.equal((await resolvePaperSource("Search Retrieval")).label, "Search & Retrieval — A Report");
});

test("different model versions and unrelated titles are not substituted", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(feed(papers.filter(({ id }) => id !== "2501.00002v2" && id !== "2501.00001"))));
  await assert.rejects(resolvePaperSource("DeepSeek-v4.1"), /No confident arXiv title match/);
  await assert.rejects(resolvePaperSource("Attention Is All You Need"), /No confident arXiv title match/);
});

test("no results and service failures remain visible", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(feed([])));
  await assert.rejects(resolvePaperSource("nonexistent paper"), /No confident arXiv title match/);
  t.mock.method(globalThis, "fetch", async () => new Response("busy", { status: 503 }));
  await assert.rejects(resolvePaperSource("DeepSeek"), /arXiv search.*HTTP 503/);
  t.mock.method(globalThis, "fetch", async () => new Response("<html>blocked</html>"));
  await assert.rejects(resolvePaperSource("DeepSeek"), /Invalid arXiv search response/);
});

test("links, identifiers and local PDFs bypass search; invalid references still fail", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected search"); });
  assert.equal((await resolvePaperSource("1706.03762")).url, "https://arxiv.org/pdf/1706.03762.pdf");
  assert.equal((await resolvePaperSource("https://arxiv.org/abs/1706.03762v2")).url, "https://arxiv.org/pdf/1706.03762v2.pdf");
  assert.equal((await resolvePaperSource("hep-th/9901001")).url, "https://arxiv.org/pdf/hep-th/9901001.pdf");
  await assert.rejects(resolvePaperSource("https://example.com/paper.pdf"), /Only arxiv/);
  await assert.rejects(resolvePaperSource("./missing.pdf"), /Invalid arXiv identifier/);
  await assert.rejects(resolvePaperSource("1706.invalid"), /Invalid arXiv identifier/);
  await assert.rejects(resolvePaperSource("  "), /Enter a paper name/);
  const directory = await mkdtemp(join(tmpdir(), "pi-paper-search-"));
  try {
    const path = join(directory, "paper.pdf");
    await writeFile(path, "%PDF-");
    assert.equal((await resolvePaperSource(path)).localPath, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
