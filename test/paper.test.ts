import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PaperHistory } from "../src/history.js";
import { PaperLibrary } from "../src/paper.js";

function minimalPdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${pdf}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-paper-library-test-"));
  const history = new PaperHistory(join(directory, "state"));
  const library = new PaperLibrary(history, join(directory, "cache"));
  t.after(async () => {
    await library.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, history, library };
}

test("shared loader validates local PDFs, resets position and cleans up on release", async (t) => {
  const { directory, library } = await fixture(t);
  const path = join(directory, "local.pdf");
  await writeFile(path, minimalPdf());
  const paper = await library.open(path);
  assert.notEqual(paper.pdf.path, path);
  assert.equal(await readFile(paper.pdf.path, "utf8"), minimalPdf());
  assert.deepEqual(paper.pdf.metadata, { pages: 1, widthPoints: 600, heightPoints: 800 });
  assert.deepEqual([paper.pdf.page, paper.pdf.y, paper.pdf.zoom], [1, 0, 100]);
  await library.release(paper.pdf);
  assert.equal(existsSync(paper.pdf.path), false);
  assert.equal(existsSync(path), true);
});

test("title lookup and downloading use the same loader; history changes only when remembered", async (t) => {
  const { history, library } = await fixture(t);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (new URL(url).pathname === "/api/query") {
      return new Response('<feed><entry><id>http://arxiv.org/abs/2501.00002v2</id><title>DeepSeek-V4.1 Technical Report</title></entry></feed>');
    }
    return new Response(minimalPdf());
  });
  const paper = await library.open("DeepSeek-v4.1");
  assert.equal(requests.length, 2);
  assert.equal(requests[1], "https://arxiv.org/pdf/2501.00002v2.pdf");
  assert.equal(paper.source.label, "DeepSeek-V4.1 Technical Report");
  assert.equal((await history.source()).label, "1706.03762");
  await library.remember(paper);
  assert.equal((await history.source()).url, paper.source.url);
  await library.dispose();
  assert.equal(existsSync(paper.pdf.path), false);
});

test("downloaded PDFs are cached and reused; a missing cache downloads again", async (t) => {
  const { directory, history } = await fixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(minimalPdf()));
  const downloads: string[] = [];
  const onDownload = (source: { label: string }) => downloads.push(source.label);
  const library = new PaperLibrary(history, join(directory, "cache"));
  await library.open("2401.12345", onDownload);
  await library.open("2401.12345", onDownload);
  await library.dispose();
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(downloads, ["2401.12345"]);
  const restarted = new PaperLibrary(history, join(directory, "empty-cache"));
  const paper = await restarted.open("2401.12345", onDownload);
  await restarted.dispose();
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(downloads, ["2401.12345", "2401.12345"]);
  assert.equal(existsSync(paper.pdf.path), false);
});

for (const body of ["<html>not a PDF</html>", "%PDF-invalid"]) {
  test(`invalid download does not change history and releases its temporary directory: ${body}`, async (t) => {
    const { history, library } = await fixture(t);
    const old = await history.source();
    await history.remember(old);
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    const release = t.mock.method(library as unknown as { remove(path: string): Promise<void> }, "remove");
    await assert.rejects(library.open("2401.12345"));
    assert.equal(release.mock.callCount(), 1);
    assert.equal(existsSync(release.mock.calls[0].arguments[0]), false);
    assert.deepEqual(await history.source(), old);
  });
}

test("each paper reopens at its last saved position", async (t) => {
  const { directory, library } = await fixture(t);
  const path = join(directory, "local.pdf");
  const other = join(directory, "other.pdf");
  await writeFile(path, minimalPdf());
  await writeFile(other, minimalPdf());
  const paper = await library.open(path);
  paper.pdf.y = 120;
  paper.pdf.zoom = 150;
  await paper.state.savePosition(paper.pdf.position);
  const reopened = await library.open(path);
  assert.deepEqual(reopened.pdf.position, { page: 1, y: 120, zoom: 150 });
  assert.equal(reopened.state.sessionPath, paper.state.sessionPath);
  const fresh = await library.open(other);
  assert.deepEqual(fresh.pdf.position, { page: 1, y: 0, zoom: 100 });
  assert.notEqual(fresh.state.sessionPath, paper.state.sessionPath);
});

test("a saved page beyond the end clamps and an invalid position fails visibly", async (t) => {
  const { directory, library } = await fixture(t);
  const path = join(directory, "local.pdf");
  await writeFile(path, minimalPdf());
  const paper = await library.open(path);
  await paper.state.savePosition({ page: 9, y: 0, zoom: 100 });
  assert.equal((await library.open(path)).pdf.page, 1);
  await paper.state.savePosition({ page: 1, y: 0, zoom: 333 });
  await assert.rejects(library.open(path), /Invalid saved position/);
});
