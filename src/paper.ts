import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePaper, type PaperSource } from "./paper-source.js";
import { PaperHistory } from "./history.js";
import { inspectPdf, PdfDocument } from "./pdf.js";

export interface LoadedPaper {
  source: PaperSource;
  pdf: PdfDocument;
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

  constructor(private readonly history = new PaperHistory()) {}

  async open(argument?: string, onDownload?: (source: PaperSource) => void): Promise<LoadedPaper> {
    const source = await this.history.source(argument);
    const directory = await mkdtemp(join(tmpdir(), "pi-paper-"));
    const path = join(directory, "paper.pdf");
    this.directories.set(path, directory);
    let loaded = false;
    try {
      onDownload?.(source);
      await acquirePaper(source, path);
      await validatePdf(path);
      const pdf = new PdfDocument(path, await inspectPdf(path));
      loaded = true;
      return { source, pdf };
    } finally {
      if (!loaded) await this.remove(path);
    }
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
