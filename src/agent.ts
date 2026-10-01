import { rm } from "node:fs/promises";
import type { AgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ConversationMessage } from "./conversation.js";
import type { SelectionCommand, SelectionOptions } from "./selection.js";
import { PaperSettings, type ThinkingLevel } from "./settings.js";

const SYSTEM_PROMPT = `You are a patient research-paper reading companion. The user is looking at a cropped image of an arXiv paper and will ask questions about it.

Use the attached image and the supplied page/location metadata as the immediate context. Explain notation, figures, arguments, and significance clearly. Relate the visible section to earlier turns when useful. Do not claim to see content outside the attached section. Be concise by default, but show intermediate reasoning for mathematical explanations. You have no coding task and need no tools.`;

type PaperModel = NonNullable<AgentSession["model"]>;
type SessionMessage = AgentSession["messages"][number];

const QUESTION_MARKER = "\n\nQuestion: ";

/** The SDK takes most of startup to import; load it alongside the paper instead of before it. */
const loadSdk = () => import("@earendil-works/pi-coding-agent");

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning",
  low: "Light reasoning",
  medium: "Moderate reasoning",
  high: "Deep reasoning",
  xhigh: "Extra-high reasoning",
  max: "Maximum reasoning",
};

function thinkingItem(level: ThinkingLevel) {
  return { value: level, label: level, description: THINKING_DESCRIPTIONS[level] };
}

function isVisionModel(model: PaperModel): boolean {
  return model.input.includes("image");
}

function modelItem(model: PaperModel) {
  return { value: `${model.provider}/${model.id}`, label: model.id, description: `[${model.provider}] ${model.name}` };
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text : "").join("");
}

function lastImage(messages: readonly SessionMessage[]): string | undefined {
  for (const message of messages.toReversed()) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    const image = message.content.findLast((part) => part.type === "image");
    if (image) return image.data;
  }
}

function historyMessage(message: SessionMessage): ConversationMessage[] {
  if (message.role === "user") {
    const prompt = contentText(message.content);
    return [{ role: "You", text: prompt.slice(prompt.indexOf(QUESTION_MARKER) + QUESTION_MARKER.length) }];
  }
  if (message.role !== "assistant") return [];
  const text = contentText(message.content);
  const error = message.errorMessage ? `Error: ${message.errorMessage}` : "";
  return [{ role: "Agent", text: [text, error].filter(Boolean).join("\n\n") }];
}

interface AgentReplyEvents {
  onDelta(delta: string): void;
  onChange?(): void;
}

export class PaperAgent {
  private session?: AgentSession;
  private sessionPath?: string;
  private unsubscribe?: () => void;
  private settingsManager?: SettingsManager;
  private modelRuntime?: ModelRuntime;
  private previousCost = 0;
  private validated = false;
  /** The last attached PNG and the copy the session stored, which may be resized. */
  private sentImage?: { png: string; stored: string };
  private readonly settings = new PaperSettings();

  constructor(private readonly events: AgentReplyEvents) {}

  get summary(): string {
    const model = this.session?.model;
    const selection = model ? `${model.id} · ${this.session!.thinkingLevel}` : "No model";
    const cost = this.previousCost + (this.session?.getSessionStats().cost ?? 0);
    return `${selection} · $${cost.toFixed(4)}`;
  }

  private async initialize(): Promise<void> {
    if (this.settingsManager && this.modelRuntime) return;
    const [{ getAgentDir, ModelRuntime, SettingsManager }, defaults] = await Promise.all([loadSdk(), this.settings.load()]);
    const piSettings = SettingsManager.create(process.cwd(), getAgentDir());
    const errors = piSettings.drainErrors();
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("; "));
    this.settingsManager = SettingsManager.inMemory({
      ...piSettings.getGlobalSettings(),
      ...defaults,
      ...(defaults.defaultThinkingLevel ? { modelThinkingLevels: {} } : {}),
    });
    this.modelRuntime = await ModelRuntime.create();
  }

  private validateVision(model: PaperModel | undefined): void {
    if (this.settingsManager?.getSettings().images?.blockImages) {
      throw new Error("Images are blocked by Pi settings (images.blockImages); disable it in Pi before restarting pi-paper");
    }
    if (!model) throw new Error("No model available; authenticate with pi /login, then select a vision model with /model");
    if (!isVisionModel(model)) {
      throw new Error(`${model.provider}/${model.id} does not support images; select a vision model with /model`);
    }
  }

  async start(): Promise<void> {
    this.validated = false;
    await this.initialize();
    const provider = this.settingsManager!.getDefaultProvider();
    const id = this.settingsManager!.getDefaultModel();
    const model = provider && id ? this.modelRuntime!.getModel(provider, id) : undefined;
    if (provider && id && !model) throw new Error(`Unknown model ${provider}/${id}; select another with /model`);
    await this.createSession(model);
  }

  private async createSession(model?: PaperModel): Promise<void> {
    const { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } = await loadSdk();
    const cwd = process.cwd();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager: this.settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const result = await createAgentSession({
      cwd,
      model,
      modelRuntime: this.modelRuntime,
      settingsManager: this.settingsManager,
      resourceLoader: loader,
      sessionManager: this.sessionPath ? SessionManager.open(this.sessionPath) : SessionManager.inMemory(),
      noTools: "all",
    });
    this.session = result.session;
    this.unsubscribe = this.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.events.onDelta(event.assistantMessageEvent.delta);
      }
      this.events.onChange?.();
    });
    this.validateVision(this.session.model);
    if (!await this.modelRuntime!.checkAuth(this.session.model!.provider)) {
      throw new Error(`No authentication for ${this.session.model!.provider}; configure it with pi /login`);
    }
    this.validated = true;
  }

  async getSelection(command: SelectionCommand): Promise<SelectionOptions> {
    await this.initialize();
    if (command === "/model") {
      const models = await this.modelRuntime!.getAvailable();
      return {
        items: models.filter(isVisionModel).map(modelItem)
          .sort((a, b) => a.value.localeCompare(b.value)),
        current: this.session?.model ? modelItem(this.session.model).value : undefined,
      };
    }
    const session = this.modelSession;
    return {
      items: session.getAvailableThinkingLevels().map(thinkingItem),
      current: session.thinkingLevel,
    };
  }

  private get modelSession(): AgentSession {
    if (!this.session?.model) throw new Error("Select a model with /model first");
    return this.session;
  }

  async select(command: SelectionCommand, value: string): Promise<string> {
    await this.initialize();
    if (command === "/model") await this.selectModel(value);
    else this.selectThinking(value);
    await this.saveSelection();
    return "Saved pi-paper defaults.";
  }

  private async selectModel(value: string): Promise<void> {
    const models = await this.modelRuntime!.getAvailable();
    const model = models.find((model) => modelItem(model).value.toLowerCase() === value.toLowerCase());
    if (!model) throw new Error(`Model unavailable: ${value}. Use /model to choose an authenticated vision model.`);
    this.validateVision(model);
    if (this.session) await this.session.setModel(model);
    else await this.createSession(model);
    this.validated = true;
  }

  private selectThinking(value: string): void {
    const session = this.modelSession;
    const levels = session.getAvailableThinkingLevels();
    if (!levels.includes(value as ThinkingLevel)) throw new Error(`Unsupported thinking level. Choose: ${levels.join(", ")}`);
    session.setThinkingLevel(value as ThinkingLevel);
  }

  private async saveSelection(): Promise<void> {
    const { model, thinkingLevel } = this.session!;
    const defaults = {
      defaultProvider: model!.provider,
      defaultModel: model!.id,
      defaultThinkingLevel: thinkingLevel,
    };
    this.settingsManager!.applyOverrides({ ...defaults, modelThinkingLevels: { [`${model!.provider}/${model!.id}`]: thinkingLevel } });
    await this.settings.save(defaults);
    this.events.onChange?.();
  }

  get ready(): boolean {
    return this.validated;
  }

  async ask(question: string, pngBase64: string, context: string): Promise<void> {
    if (!this.session || !this.ready) throw new Error("Agent is not ready");
    this.validateVision(this.session.model);
    const unchanged = this.sentImage?.png === pngBase64 && this.sentImage.stored === lastImage(this.session.messages);
    const note = unchanged ? " Unchanged since the last attached image." : "";
    await this.session.prompt(`${context}${note}${QUESTION_MARKER}${question}`, {
      images: unchanged ? [] : [{ type: "image", data: pngBase64, mimeType: "image/png" }],
      expandPromptTemplates: false,
    });
    if (unchanged) return;
    const stored = lastImage(this.session.messages);
    this.sentImage = stored ? { png: pngBase64, stored } : undefined;
  }

  /** The conversation restored from the session file, as displayed. */
  get history(): ConversationMessage[] {
    return (this.session?.messages ?? []).flatMap(historyMessage);
  }

  /** Continues the paper's saved session, or starts one that is saved as it grows. */
  async open(sessionPath: string): Promise<void> {
    this.dispose();
    this.sessionPath = sessionPath;
    await this.start();
  }

  async reset(): Promise<void> {
    this.dispose();
    if (this.sessionPath) await rm(this.sessionPath, { force: true });
    await this.start();
  }

  abort(): void {
    void this.session?.abort();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.previousCost += this.session?.getSessionStats().cost ?? 0;
    this.session?.dispose();
    this.session = undefined;
    this.validated = false;
  }
}
