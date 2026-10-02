import { existsSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadPaper, type PaperSource } from "./paper-source.js";
import { PaperHistory, sourceKey } from "./history.js";
import type { PaperState } from "./paper-state.js";
import { inspectPdf, PdfDocument } from "./pdf.js";

export interface LoadedPaper {
  source: PaperSource;
  pdf: PdfDocument;
  state: PaperState;
}

async function validatePdf(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    const signature = Buffer.alloc(5);
    await file.read(signature, 0, 5, 0);
    if (signature.toString() !== "%PDF-") throw new Error("Downloaded file is not a PDF");
  } finally {
    await file.close();
  }
}

async function loadPdf(path: string): Promise<PdfDocument> {
  await validatePdf(path);
  return new PdfDocument(path, await inspectPdf(path));
}

/** Opens local PDFs in place and downloads arXiv PDFs once into a shared cache. */
export class PaperLibrary {
  constructor(
    private readonly history = new PaperHistory(),
    private readonly cacheDirectory = join(tmpdir(), "pi-paper-cache"),
  ) {}

  async open(argument?: string, onDownload?: (source: PaperSource) => void): Promise<LoadedPaper> {
    const source = await this.history.source(argument);
    const pdf = source.localPath ? await loadPdf(source.localPath) : await this.download(source, onDownload);
    const state = this.history.state(source);
    const position = await state.position();
    if (position) pdf.restore(position);
    return { source, pdf, state };
  }

  /** Only a downloaded file that opens as a PDF enters the cache. */
  private async download(source: PaperSource, onDownload?: (source: PaperSource) => void): Promise<PdfDocument> {
    const path = join(this.cacheDirectory, `${sourceKey(source)}.pdf`);
    if (existsSync(path)) return loadPdf(path);
    onDownload?.(source);
    await mkdir(this.cacheDirectory, { recursive: true });
    const partial = `${path}.${process.pid}.part`;
    try {
      await downloadPaper(source, partial);
      const { metadata } = await loadPdf(partial);
      await rename(partial, path);
      return new PdfDocument(path, metadata);
    } finally {
      await rm(partial, { force: true });
    }
  }

  async remember(paper: LoadedPaper): Promise<void> {
    await this.history.remember(paper.source);
  }
}
