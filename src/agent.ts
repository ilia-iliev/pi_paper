import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { matchingItems, type SelectionCommand, type SelectionOptions } from "./selection.js";
import { PaperSettings, type ThinkingLevel } from "./settings.js";

const SYSTEM_PROMPT = `You are a patient research-paper reading companion. The user is looking at a cropped image of an arXiv paper and will ask questions about it.

Use the attached image and the supplied page/location metadata as the immediate context. Explain notation, figures, arguments, and significance clearly. Relate the visible section to earlier turns when useful. Do not claim to see content outside the attached section. Be concise by default, but show intermediate reasoning for mathematical explanations. You have no coding task and need no tools.`;

type PaperModel = NonNullable<AgentSession["model"]>;

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

function modelItem(model: PaperModel) {
  return { value: `${model.provider}/${model.id}`, label: model.id, description: `[${model.provider}] ${model.name}` };
}

interface AgentReplyEvents {
  onDelta(delta: string): void;
  onChange?(): void;
}

export class PaperAgent {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private settingsManager?: SettingsManager;
  private modelRuntime?: ModelRuntime;
  private previousCost = 0;
  private validated = false;
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
    const defaults = await this.settings.load();
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
    if (!model.input.includes("image")) {
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
      sessionManager: SessionManager.inMemory(),
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
        items: models.filter((model) => model.input.includes("image")).map(modelItem)
          .sort((a, b) => a.value.localeCompare(b.value)),
        current: this.session?.model ? modelItem(this.session.model).value : undefined,
      };
    }
    if (!this.session?.model) throw new Error("Select a model with /model first");
    return {
      items: this.session.getAvailableThinkingLevels().map(thinkingItem),
      current: this.session.thinkingLevel,
    };
  }

  async configure(command: string): Promise<string> {
    await this.initialize();
    const [name, ...args] = command.trim().split(/\s+/);
    const value = args.join(" ");
    if (name === "/model") {
      const models = await this.modelRuntime!.getAvailable();
      const exact = models.find((model) => modelItem(model).value.toLowerCase() === value.toLowerCase());
      const matches = matchingItems(models.filter((model) => model.input.includes("image")).map(modelItem), value);
      if (!exact && matches.length > 1) throw new Error(`Multiple models match: ${value}. Use /model to choose one.`);
      const model = exact ?? models.find((model) => modelItem(model).value === matches[0]?.value);
      if (!model) throw new Error(`Model unavailable: ${value}. Use /model to choose an authenticated vision model.`);
      this.validateVision(model);
      if (this.session) await this.session.setModel(model);
      else await this.createSession(model);
      this.validated = true;
    } else if (name === "/thinking") {
      if (!this.session?.model) throw new Error("Select a model with /model first");
      const levels = this.session.getAvailableThinkingLevels();
      const matches = matchingItems(levels.map(thinkingItem), value);
      if (matches.length !== 1) throw new Error(`Unsupported thinking level. Choose: ${levels.join(", ")}`);
      this.session.setThinkingLevel(matches[0].value as ThinkingLevel);
    } else {
      throw new Error("Unknown command. Use /help for commands and keybindings.");
    }
    await this.saveSelection();
    return "Saved pi-paper defaults.";
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
    await this.session.prompt(`${context}\n\nQuestion: ${question}`, {
      images: [{ type: "image", data: pngBase64, mimeType: "image/png" }],
      expandPromptTemplates: false,
    });
  }

  async reset(): Promise<void> {
    this.dispose();
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
