import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "./files.js";
import { parsePaperSource, resolvePaperSource, type PaperSource } from "./paper-source.js";

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
    await writePrivateFile(this.path, `${source.localPath ?? source.url}\n`);
  }
}
