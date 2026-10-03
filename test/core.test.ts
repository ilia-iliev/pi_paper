import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { layout, rightFrame } from "../src/frame.js";
import { parsePaperSource } from "../src/paper-source.js";
import { encodePng } from "../src/png.js";
import { PdfDocument } from "../src/pdf.js";
import { parsePpm } from "../src/ppm.js";
import { encodeSixel } from "../src/sixel.js";

test("normalizes arXiv abstract and PDF links", () => {
  assert.equal(parsePaperSource("https://arxiv.org/abs/2401.12345v2").url, "https://arxiv.org/pdf/2401.12345v2.pdf");
  assert.equal(parsePaperSource("https://export.arxiv.org/pdf/hep-th/9901001.pdf").url, "https://arxiv.org/pdf/hep-th/9901001.pdf");
  assert.equal(parsePaperSource("2401.12345").url, "https://arxiv.org/pdf/2401.12345.pdf");
  assert.throws(() => parsePaperSource("https://example.com/paper.pdf"), /Only arxiv/);
});

test("parses PPM and encodes PNG and sixel", () => {
  const ppm = Buffer.concat([Buffer.from("P6\n# sample\n2 1\n255\n"), Buffer.from([255, 0, 0, 0, 255, 0])]);
  const raster = parsePpm(ppm);
  assert.deepEqual({ width: raster.width, height: raster.height }, { width: 2, height: 1 });
  assert.equal(encodePng(raster).subarray(1, 4).toString(), "PNG");
  const sixel = encodeSixel(raster);
  assert.ok(sixel.startsWith("\x1bP0;1;0q"));
  assert.ok(sixel.endsWith("\x1b\\"));
});

test("paper scrolling crosses pages and zoom stays in presets", () => {
  const pdf = new PdfDocument("unused", { pages: 2, widthPoints: 600, heightPoints: 800 });
  assert.equal(pdf.scroll(10_000, 400), true);
  assert.equal(pdf.y, 400);
  assert.equal(pdf.scroll(1, 400), true);
  assert.equal(pdf.page, 2);
  assert.equal(pdf.y, 0);
  assert.equal(pdf.setZoom(1, 400), true);
  assert.equal(pdf.zoom, 125);
});

function linkedPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /Link /Rect [20 20 80 80] /Border [0 0 4] /C [0 1 0] /A << /S /URI /URI (https://arxiv.org) >> >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

test("link annotation borders are not drawn on the page", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "pi-paper-")), "linked.pdf");
  await writeFile(path, linkedPdf());
  const pdf = new PdfDocument(path, { pages: 1, widthPoints: 100, heightPoints: 100 });
  const { sixel } = await pdf.render(100, 100, 10);
  assert.ok(!sixel.includes("#12;2;0;100;0"));
});

test("conversation rows are padded to the panel and overlong rows are cut at its border", () => {
  const d = layout(100, 20, 1);
  const width = d.rightInner - 1;
  const rows = rightFrame(d, "Conversation", ["short", "\x1b[1mbold\x1b[22m", "x".repeat(width + 10)], true)
    .split(/\x1b\[\d+;\d+H/).slice(2, 5).map((row) => stripVTControlCharacters(row));
  assert.deepEqual(rows, [`│ ${"short".padEnd(width)}│`, `│ ${"bold".padEnd(width)}│`, `│ ${"x".repeat(width)}│`]);
});
