import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { writePrivateFile } from "./files.js";

export type ThinkingLevel = AgentSession["thinkingLevel"];
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface PaperDefaults {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
}

export class PaperSettings {
  constructor(private readonly directory = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "pi-paper",
  )) {}

  private get path(): string {
    return join(this.directory, "settings.json");
  }

  async load(): Promise<PaperDefaults> {
    if (!existsSync(this.path)) return {};
    const value = JSON.parse(await readFile(this.path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value.defaultProvider !== undefined && (typeof value.defaultProvider !== "string" || !value.defaultProvider.trim()))
      || (value.defaultModel !== undefined && (typeof value.defaultModel !== "string" || !value.defaultModel.trim()))
      || (Boolean(value.defaultProvider) !== Boolean(value.defaultModel))
      || (value.defaultThinkingLevel !== undefined && !THINKING_LEVELS.includes(value.defaultThinkingLevel))) {
      throw new Error(`Invalid pi-paper settings: ${this.path}`);
    }
    return {
      ...(value.defaultProvider ? { defaultProvider: value.defaultProvider, defaultModel: value.defaultModel } : {}),
      ...(value.defaultThinkingLevel ? { defaultThinkingLevel: value.defaultThinkingLevel } : {}),
    };
  }

  async save(defaults: PaperDefaults): Promise<void> {
    await writePrivateFile(this.path, `${JSON.stringify(defaults, null, 2)}\n`);
  }
}
