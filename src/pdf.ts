import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "./png.js";
import { run } from "./process.js";
import { parsePpm } from "./ppm.js";
import { encodeSixel } from "./sixel.js";

const ZOOM_LEVELS = [50, 75, 100, 125, 150, 175, 200, 225, 250] as const;

interface PdfMetadata {
  pages: number;
  widthPoints: number;
  heightPoints: number;
}

export interface RenderedSection {
  sixel: string;
  pngBase64: string;
  width: number;
  height: number;
  leftCells: number;
}

export async function inspectPdf(path: string): Promise<PdfMetadata> {
  const output = (await run("pdfinfo", [path], { LC_ALL: "C" })).toString();
  const pages = Number(output.match(/^Pages:\s+(\d+)/m)?.[1]);
  const size = output.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
  if (!Number.isInteger(pages) || pages < 1 || !size) throw new Error("Could not read PDF metadata");
  return { pages, widthPoints: Number(size[1]), heightPoints: Number(size[2]) };
}

export class PdfDocument {
  page = 1;
  y = 0;
  zoom = 100;

  constructor(readonly path: string, readonly metadata: PdfMetadata) {}

  get pageWidth(): number {
    return Math.ceil(this.metadata.widthPoints * this.zoom / 100);
  }

  get pageHeight(): number {
    return Math.ceil(this.metadata.heightPoints * this.zoom / 100);
  }

  setZoom(direction: number, viewportHeight: number): boolean {
    const current = ZOOM_LEVELS.indexOf(this.zoom as (typeof ZOOM_LEVELS)[number]);
    const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, current + direction));
    if (next === current) return false;
    const relativeY = this.pageHeight <= viewportHeight ? 0 : this.y / (this.pageHeight - viewportHeight);
    this.zoom = ZOOM_LEVELS[next]!;
    this.y = Math.round(relativeY * Math.max(0, this.pageHeight - viewportHeight));
    return true;
  }

  scroll(delta: number, viewportHeight: number): boolean {
    const maxY = Math.max(0, this.pageHeight - viewportHeight);
    if (delta > 0) {
      if (this.y < maxY) this.y = Math.min(maxY, this.y + delta);
      else if (this.page < this.metadata.pages) {
        this.page++;
        this.y = 0;
      } else return false;
    } else if (this.y > 0) this.y = Math.max(0, this.y + delta);
    else if (this.page > 1) {
      this.page--;
      this.y = Math.max(0, this.pageHeight - viewportHeight);
    } else return false;
    return true;
  }

  async render(viewportWidth: number, viewportHeight: number, cellWidth: number): Promise<RenderedSection> {
    const pageWidth = this.pageWidth;
    const pageHeight = this.pageHeight;
    this.y = Math.max(0, Math.min(this.y, Math.max(0, pageHeight - viewportHeight)));
    const cropWidth = Math.max(1, Math.min(pageWidth, viewportWidth));
    const cropHeight = Math.max(1, Math.min(pageHeight - this.y, viewportHeight));
    const cropX = Math.max(0, Math.floor((pageWidth - cropWidth) / 2));
    const work = await mkdtemp(join(tmpdir(), "pi-paper-render-"));
    const prefix = join(work, "section");
    try {
      await run("pdftoppm", [
        "-f", String(this.page), "-l", String(this.page), "-singlefile",
        "-r", String(72 * this.zoom / 100),
        "-x", String(cropX), "-y", String(this.y),
        "-W", String(cropWidth), "-H", String(cropHeight),
        this.path, prefix,
      ]);
      const raster = parsePpm(await readFile(`${prefix}.ppm`));
      const png = encodePng(raster);
      return {
        sixel: encodeSixel(raster),
        pngBase64: png.toString("base64"),
        width: raster.width,
        height: raster.height,
        leftCells: Math.max(0, Math.floor((viewportWidth - raster.width) / (2 * cellWidth))),
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
