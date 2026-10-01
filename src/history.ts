import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePaperSource, resolvePaperSource, type PaperSource } from "./arxiv.js";

const DEFAULT_PAPER = "1706.03762";

export class PaperHistory {
  constructor(private readonly directory = join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "pi-paper",
  )) {}

  private get path(): string {
    return join(this.directory, "last-paper");
  }

  async source(argument?: string): Promise<PaperSource> {
    if (argument !== undefined) return resolvePaperSource(argument);
    const saved = existsSync(this.path) ? (await readFile(this.path, "utf8")).trimEnd() : DEFAULT_PAPER;
    return parsePaperSource(saved);
  }

  async remember(source: PaperSource): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${source.localPath ?? source.url}\n`, { mode: 0o600 });
  }
}
