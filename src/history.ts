import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "./files.js";
import { parsePaperSource, resolvePaperSource, type PaperSource } from "./paper-source.js";
import { PaperState } from "./paper-state.js";

const DEFAULT_PAPER = "1706.03762";

function location(source: PaperSource): string {
  return source.localPath ?? source.url!;
}

export function sourceKey(source: PaperSource): string {
  return createHash("sha256").update(location(source)).digest("hex").slice(0, 16);
}

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
    await writePrivateFile(this.path, `${location(source)}\n`);
  }

  state(source: PaperSource): PaperState {
    return new PaperState(join(this.directory, "papers", sourceKey(source)));
  }
}
