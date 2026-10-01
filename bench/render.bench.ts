// Usage: npm run bench -- paper.pdf
import { performance } from "node:perf_hooks";
import { encodePng } from "../src/png.js";
import { inspectPdf, PdfDocument } from "../src/pdf.js";
import { parsePpm } from "../src/ppm.js";
import { run } from "../src/process.js";
import { encodeSixel } from "../src/sixel.js";

const path = process.argv[2];
if (!path) throw new Error("Usage: npm run bench -- paper.pdf");
const PAGE = "3";
const VIEWPORT = { width: 1600, height: 1300, cell: 10 };
const RUNS = 10;

async function time(label: string, task: () => unknown): Promise<void> {
  await task();
  const start = performance.now();
  for (let i = 0; i < RUNS; i++) await task();
  console.log(`${label.padEnd(30)} ${((performance.now() - start) / RUNS).toFixed(1).padStart(7)} ms`);
}

const pdf = new PdfDocument(path, await inspectPdf(path));
pdf.page = Number(PAGE);
for (const zoom of [100, 175]) {
  pdf.zoom = zoom;
  const rasterize = () => run("pdftoppm", ["-f", PAGE, "-l", PAGE, "-singlefile", "-r", String(72 * zoom / 100),
    "-W", String(VIEWPORT.width), "-H", String(VIEWPORT.height), path]);
  const raster = parsePpm(await rasterize());
  console.log(`-- page ${PAGE}, zoom ${zoom}%, ${raster.width}x${raster.height}`);
  await time("pdftoppm", rasterize);
  await time("encodeSixel", () => encodeSixel(raster));
  await time("encodePng (per question)", () => encodePng(raster).toString("base64"));
  await time("PdfDocument.render", () => pdf.render(VIEWPORT.width, VIEWPORT.height, VIEWPORT.cell));
}
