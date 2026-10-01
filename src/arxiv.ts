import { createWriteStream, existsSync } from "node:fs";
import { copyFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, resolve } from "node:path";
import { httpGet } from "./http.js";
import { searchArxiv } from "./paper-search.js";

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?$/i;
const MAX_PDF_BYTES = 100 * 1024 * 1024;

function tooLarge(): Error {
  return new Error("PDF exceeds the 100 MB limit");
}

export interface PaperSource {
  label: string;
  localPath?: string;
  url?: string;
}

export function parsePaperSource(input: string): PaperSource {
  const localPath = resolve(input);
  if (existsSync(localPath)) {
    return { label: basename(localPath), localPath };
  }

  let id = input.trim();
  if (id.startsWith("http://") || id.startsWith("https://")) {
    const url = new URL(id);
    if (!["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(url.hostname.toLowerCase())) {
      throw new Error("Only arxiv.org links and local PDF files are supported");
    }
    const match = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/i);
    if (!match) throw new Error("Expected an arXiv /abs/ or /pdf/ link");
    id = decodeURIComponent(match[1]);
  }

  id = id.replace(/\.pdf$/i, "");
  if (!ARXIV_ID.test(id)) throw new Error(`Invalid arXiv identifier: ${id}`);
  return { label: id, url: `https://arxiv.org/pdf/${id}.pdf` };
}

export async function resolvePaperSource(input: string): Promise<PaperSource> {
  const value = input.trim();
  if (!value) throw new Error("Enter a paper name, arXiv link or ID, or local PDF path");
  const isReference = existsSync(resolve(input)) || ARXIV_ID.test(value.replace(/\.pdf$/i, ""))
    || /^(?:https?:\/\/|\d{4}\.|\.{0,2}\/|~\/)|\.pdf$/i.test(value);
  if (isReference) return parsePaperSource(input);
  const result = await searchArxiv(value);
  return { ...parsePaperSource(result.url), label: result.title };
}

export async function acquirePaper(source: PaperSource, destination: string): Promise<void> {
  if (source.localPath) {
    const info = await stat(source.localPath);
    if (!info.isFile()) throw new Error("The local PDF path is not a file");
    if (info.size > MAX_PDF_BYTES) throw tooLarge();
    await copyFile(source.localPath, destination);
    return;
  }

  const response = await httpGet(source.url!);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download paper (HTTP ${response.status})`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > MAX_PDF_BYTES) throw tooLarge();

  let received = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_PDF_BYTES) throw tooLarge();
      controller.enqueue(chunk);
    },
  });
  await pipeline(response.body.pipeThrough(limiter), createWriteStream(destination));
}
