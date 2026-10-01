import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePaper, type PaperSource } from "./paper-source.js";
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

export class PaperLibrary {
  private readonly directories = new Map<string, string>();

  constructor(
    private readonly history = new PaperHistory(),
    private readonly cacheDirectory = join(tmpdir(), "pi-paper-cache"),
  ) {}

  async open(argument?: string, onDownload?: (source: PaperSource) => void): Promise<LoadedPaper> {
    const source = await this.history.source(argument);
    const directory = await mkdtemp(join(tmpdir(), "pi-paper-"));
    const path = join(directory, "paper.pdf");
    this.directories.set(path, directory);
    let loaded = false;
    try {
      await this.acquire(source, path, onDownload);
      await validatePdf(path);
      const pdf = new PdfDocument(path, await inspectPdf(path));
      if (source.url) await this.cache(source, path);
      const state = this.history.state(source);
      const position = await state.position();
      if (position) pdf.restore(position);
      loaded = true;
      return { source, pdf, state };
    } finally {
      if (!loaded) await this.remove(path);
    }
  }

  private cached(source: PaperSource): string {
    return join(this.cacheDirectory, `${sourceKey(source)}.pdf`);
  }

  private async acquire(source: PaperSource, path: string, onDownload?: (source: PaperSource) => void): Promise<void> {
    if (source.url && existsSync(this.cached(source))) return copyFile(this.cached(source), path);
    if (source.url) onDownload?.(source);
    await acquirePaper(source, path);
  }

  private async cache(source: PaperSource, path: string): Promise<void> {
    if (existsSync(this.cached(source))) return;
    await mkdir(this.cacheDirectory, { recursive: true });
    await copyFile(path, this.cached(source));
  }

  async remember(paper: LoadedPaper): Promise<void> {
    await this.history.remember(paper.source);
  }

  async release(pdf: PdfDocument): Promise<void> {
    await this.remove(pdf.path);
  }

  private async remove(path: string): Promise<void> {
    const directory = this.directories.get(path);
    if (!directory) return;
    await rm(directory, { recursive: true, force: true });
    this.directories.delete(path);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.directories.keys()].map((path) => this.remove(path)));
  }
}
