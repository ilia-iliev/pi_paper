import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "./files.js";
import type { PdfPosition } from "./pdf.js";

/** One paper's latest reading position and agent session; a single history per paper. */
export class PaperState {
  private saving = Promise.resolve();

  constructor(private readonly directory: string) {}

  get sessionPath(): string {
    return join(this.directory, "session.jsonl");
  }

  private get positionPath(): string {
    return join(this.directory, "position.json");
  }

  async position(): Promise<PdfPosition | undefined> {
    if (!existsSync(this.positionPath)) return undefined;
    return JSON.parse(await readFile(this.positionPath, "utf8"));
  }

  /** Serializes writes so rapid scrolling cannot interleave them. */
  savePosition(position: PdfPosition): Promise<void> {
    this.saving = this.saving.then(() => writePrivateFile(this.positionPath, `${JSON.stringify(position)}\n`));
    return this.saving;
  }
}
