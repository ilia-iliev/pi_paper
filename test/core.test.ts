import assert from "node:assert/strict";
import test from "node:test";
import { parsePaperSource } from "../src/arxiv.js";
import { encodePng } from "../src/png.js";
import { PdfDocument } from "../src/pdf.js";
import { encodeSixel, parsePpm } from "../src/sixel.js";
import { wrapText } from "../src/text.js";

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
  assert.equal(encodePng(2, 1, raster.rgb).subarray(1, 4).toString(), "PNG");
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

test("wraps conversation text without losing words", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("abcdefgh", 4), ["abcd", "efgh"]);
});
