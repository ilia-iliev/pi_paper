import { Input, isKeyRelease, Key, matchesKey, parseKey, ProcessTerminal } from "@earendil-works/pi-tui";
import { PaperAgent } from "./agent.js";
import { ConversationRenderer, type ConversationMessage } from "./conversation.js";
import { ESC, fullFrame, layout, pdfTitle, promptFrame, rightFrame } from "./frame.js";
import { PdfDocument, type RenderedSection } from "./pdf.js";
import { PaperLibrary, type LoadedPaper } from "./paper.js";
import { matchingItems, renderInputLine, SelectionPicker, type SelectionCommand, type SelectionOptions } from "./selection.js";
import { HELP_TEXT } from "./help.js";

const PDF_ZOOM_IN_KEYS = new Set<string>([
  Key.alt("+"), Key.alt("="), Key.shiftAlt("+"), Key.shiftAlt("="),
  Key.ctrl("+"), Key.ctrl("="), Key.shiftCtrl("+"), Key.shiftCtrl("="),
]);
const PDF_ZOOM_OUT_KEYS = new Set<string>([Key.alt("-"), Key.ctrl("-")]);

export class PaperUi {
  private readonly terminal = new ProcessTerminal();
  private readonly agent: PaperAgent;
  private readonly messages: ConversationMessage[] = [];
  private readonly conversation = new ConversationRenderer();
  private readonly input = new Input();
  private picker?: SelectionPicker;
  private selectionCommand: SelectionCommand = "/model";
  private image?: RenderedSection;
  private imageCurrent = false;
  private renderGeneration = 0;
  private cellWidth = 8;
  private cellHeight = 16;
  private conversationOffset = 0;
  private busy = false;
  private agentReady = false;
  private agentError?: string;
  private stopped = false;
  private resolveRun?: () => void;

  constructor(private pdf: PdfDocument, private title: string, private readonly papers = new PaperLibrary()) {
    this.input.focused = true;
    this.agent = new PaperAgent({
      onDelta: (delta) => {
        const message = this.messages.at(-1);
        if (message?.role === "Agent") message.text += delta;
        this.conversationOffset = 0;
        this.renderRight();
      },
      onChange: () => this.renderPrompt(),
    });
  }

  async run(onOpen?: () => Promise<void>): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("pi_paper requires an interactive terminal");
    if (this.terminal.columns < 50 || this.terminal.rows < 12) throw new Error("Terminal must be at least 50 columns by 12 rows");
    await onOpen?.();

    const completion = new Promise<void>((resolve) => {
      this.resolveRun = resolve;
    });
    this.terminal.start((data) => this.handleInput(data), () => this.handleResize());
    this.terminal.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
    this.terminal.setTitle(`pi paper — ${this.title}`);
    this.queryCellSize();
    this.renderFull();

    this.busy = true;
    const [agentResult] = await Promise.allSettled([this.agent.start(), this.refreshImage()]);
    this.busy = false;
    if (this.stopped) return completion;
    if (agentResult.status === "fulfilled") this.agentReady = true;
    else this.agentFailed(agentResult.reason);
    this.renderFull();

    return completion;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.renderGeneration++;
    this.agent.dispose();
    this.terminal.write(`${ESC}[0m${ESC}[?25h${ESC}[?1049l`);
    this.terminal.stop();
    this.resolveRun?.();
  }

  private get dimensions() {
    return layout(this.terminal.columns, this.terminal.rows);
  }

  private queryCellSize(): void {
    this.terminal.write(`${ESC}[14t`);
  }

  private handleResize(): void {
    if (this.terminal.columns < 20 || this.terminal.rows < 8) return;
    this.image = undefined;
    this.imageCurrent = false;
    this.queryCellSize();
    this.renderFull();
    void this.refreshImage();
  }

  private handleInput(data: string): void {
    const pixelSize = data.match(/\x1b\[4;(\d+);(\d+)t/);
    if (pixelSize) {
      this.cellHeight = Math.max(1, Number(pixelSize[1]) / this.terminal.rows);
      this.cellWidth = Math.max(1, Number(pixelSize[2]) / this.terminal.columns);
      void this.refreshImage();
      return;
    }

    if (isKeyRelease(data)) return;

    if (this.picker) {
      this.picker.handleInput(data);
      this.renderRight();
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.busy) this.agent.abort();
      else this.stop();
      return;
    }
    if (matchesKey(data, Key.escape) && this.busy) {
      this.agent.abort();
      return;
    }
    if (matchesKey(data, Key.ctrl("pageUp"))) {
      this.scrollConversation(-1);
      return;
    }
    if (matchesKey(data, Key.ctrl("pageDown"))) {
      this.scrollConversation(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollPdf(-1);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollPdf(1);
      return;
    }
    // Some terminals still send ESC + printable Alt keys after Kitty negotiation.
    // parseKey ignores those in Kitty mode; these three sequences are unambiguous.
    // Compare key IDs because matchesKey cannot match the literal '+' key.
    const key = /^\x1b[+=-]$/.test(data) ? `alt+${data[1]}` : (parseKey(data) ?? "");
    if (PDF_ZOOM_IN_KEYS.has(key)) {
      this.changeZoom(1);
      return;
    }
    if (PDF_ZOOM_OUT_KEYS.has(key)) {
      this.changeZoom(-1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.submit();
      return;
    }
    this.input.handleInput(data);
    this.renderPrompt();
  }

  private scrollPdf(direction: number): void {
    const amount = Math.max(1, Math.floor(this.dimensions.contentRows * this.cellHeight / 2));
    if (this.pdf.scroll(direction * amount, this.dimensions.contentRows * this.cellHeight)) this.rerenderPdf();
  }

  private changeZoom(direction: number): void {
    if (this.pdf.setZoom(direction, this.dimensions.contentRows * this.cellHeight)) this.rerenderPdf();
  }

  private rerenderPdf(): void {
    this.imageCurrent = false;
    this.renderFull();
    void this.refreshImage();
  }

  private scrollConversation(direction: number): void {
    const height = this.dimensions.contentRows;
    const max = Math.max(0, this.conversationLines().length - height);
    this.conversationOffset = Math.max(0, Math.min(max, this.conversationOffset - direction * Math.floor(height / 2)));
    this.renderRight();
  }

  private renderPdf(pdf: PdfDocument): Promise<RenderedSection> {
    const { leftInner, contentRows } = this.dimensions;
    return pdf.render(
      Math.max(1, Math.floor(leftInner * this.cellWidth)),
      Math.max(1, Math.floor(contentRows * this.cellHeight)),
      this.cellWidth,
    );
  }

  private async refreshImage(): Promise<void> {
    const generation = ++this.renderGeneration;
    try {
      const image = await this.renderPdf(this.pdf);
      if (generation !== this.renderGeneration || this.stopped) return;
      this.image = image;
      this.imageCurrent = true;
      this.renderFull();
    } catch (error) {
      if (generation !== this.renderGeneration || this.stopped) return;
      this.imageCurrent = false;
      this.notify(this.errorMessage(error));
      this.renderFull();
    }
  }

  private async submit(): Promise<void> {
    const question = this.input.getValue().trim();
    if (!question || this.busy) return;
    this.input.setValue("");

    if (question === "/help") {
      this.notify(HELP_TEXT);
      this.renderRight();
      return;
    }

    if (/^\/new(?:\s|$)/u.test(question)) {
      await this.openNewPaper(question.slice(4).trim());
      return;
    }

    if (question.startsWith("/") && question !== "/clear") {
      await this.configureAgent(question);
      return;
    }

    if (question === "/clear") {
      this.busy = true;
      try {
        await this.resetConversation();
      } finally {
        this.busy = false;
        this.renderFull();
      }
      return;
    }

    if (!this.agentReady) {
      this.notify(this.agentError ?? "Agent unavailable; use /model or authenticate with pi /login");
      this.renderRight();
      return;
    }
    if (!this.image || !this.imageCurrent) {
      this.notify("Wait for the PDF section to finish rendering");
      this.renderRight();
      return;
    }

    this.messages.push({ role: "You", text: question }, { role: "Agent", text: "" });
    this.conversationOffset = 0;
    this.busy = true;
    this.renderRight();
    this.renderPrompt();
    const location = Math.round(100 * this.pdf.y / Math.max(1, this.pdf.pageHeight));
    const context = `Visible section: page ${this.pdf.page} of ${this.pdf.metadata.pages}, about ${location}% down the page, zoom ${this.pdf.zoom}%.`;
    try {
      await this.agent.ask(question, this.image.pngBase64, context);
      if (!this.messages.at(-1)?.text) this.messages.at(-1)!.text = "No response was returned.";
    } catch (error) {
      const message = this.messages.at(-1);
      if (message) message.text += `${message.text ? "\n\n" : ""}Error: ${this.errorMessage(error)}`;
    } finally {
      this.busy = false;
      this.renderRight();
      this.renderPrompt();
    }
  }

  private async resetConversation(): Promise<void> {
    this.messages.length = 0;
    this.conversationOffset = 0;
    this.renderFull();
    try {
      await this.agent.reset();
      if (this.stopped) {
        this.agent.dispose();
        return;
      }
      this.agentReady = true;
      this.agentError = undefined;
    } catch (error) {
      if (this.stopped) return;
      this.agentFailed(error);
    }
  }

  private async openNewPaper(input: string): Promise<void> {
    const quoted = /^["']/.test(input);
    const closed = input.length > 1 && input.at(-1) === input[0];
    const argument = (quoted && closed ? input.slice(1, -1) : input).trim();
    if (!argument || (quoted && !closed)) {
      this.notify('Usage: /new "paper name" (also accepts an arXiv link, ID, or local PDF path)');
      this.renderRight();
      return;
    }

    this.busy = true;
    this.notify(`Loading ${argument}…`);
    this.renderRight();
    let paper: LoadedPaper | undefined;
    let committed = false;
    try {
      paper = await this.papers.open(argument);
      if (this.stopped) return;
      const image = await this.renderPdf(paper.pdf);
      if (this.stopped) return;
      await this.papers.remember(paper);
      if (this.stopped) return;
      const previousPdf = this.pdf;
      this.renderGeneration++;
      this.pdf = paper.pdf;
      this.title = paper.source.label;
      this.image = image;
      this.imageCurrent = true;
      committed = true;
      this.terminal.setTitle(`pi paper — ${this.title}`);
      await this.resetConversation();
      await this.papers.release(previousPdf);
    } catch (error) {
      if (this.stopped) return;
      this.notify(this.errorMessage(error));
    } finally {
      if (paper && !committed) await this.papers.release(paper.pdf);
      this.busy = false;
      this.renderFull();
    }
  }

  private async configureAgent(command: string): Promise<void> {
    this.busy = true;
    this.renderPrompt();
    try {
      const [name, ...args] = command.trim().split(/\s+/);
      if (name !== "/model" && name !== "/thinking") throw new Error("Unknown command. Use /help for commands and keybindings.");
      const options = await this.agent.getSelection(name);
      const query = args.join(" ");
      if (!options.items.length) throw new Error("No vision models available; authenticate with pi /login.");
      const matches = matchingItems(options.items, query);
      if (!query || matches.length > 1) {
        this.openPicker(name, options, query);
        return;
      }
      this.notify(await this.agent.select(name, matches[0]?.value ?? query));
    } catch (error) {
      this.notify(this.errorMessage(error));
    } finally {
      this.agentReady = this.agent.ready;
      if (this.agentReady) this.agentError = undefined;
      this.busy = false;
      this.renderRight();
    }
  }

  private openPicker(command: SelectionCommand, options: SelectionOptions, query: string): void {
    this.selectionCommand = command;
    const close = () => {
      this.picker = undefined;
    };
    this.picker = new SelectionPicker(options, query, (value) => {
      close();
      void this.configureAgent(`${command} ${value}`);
    }, close);
  }

  private notify(text: string): void {
    this.messages.push({ role: "App", text });
    this.conversationOffset = 0;
  }

  private agentFailed(error: unknown): void {
    this.agentReady = false;
    this.agentError = `Agent unavailable: ${this.errorMessage(error)}`;
    this.notify(this.agentError);
  }

  private get rightTitle(): string {
    return this.picker ? (this.selectionCommand === "/model" ? "Model" : "Thinking Level") : "Conversation";
  }

  private rightLines(): string[] {
    const d = this.dimensions;
    return this.picker ? this.picker.render(d.rightInner - 1, d.contentRows) : this.visibleConversation();
  }

  private conversationLines(): string[] {
    return this.conversation.lines(this.messages, Math.max(1, this.dimensions.rightInner - 2));
  }

  private visibleConversation(): string[] {
    const height = this.dimensions.contentRows;
    const lines = this.conversationLines();
    const end = Math.max(0, lines.length - this.conversationOffset);
    const start = Math.max(0, end - height);
    return lines.slice(start, end);
  }

  private renderFull(): void {
    if (this.stopped) return;
    const d = this.dimensions;
    const title = pdfTitle(d, this.title, this.pdf.zoom, this.pdf.page, this.pdf.metadata.pages);
    this.terminal.write(fullFrame(d, title, this.rightTitle, this.rightLines()));
    this.renderPrompt();
    this.drawImage();
  }

  private renderRight(): void {
    if (this.stopped) return;
    this.terminal.write(rightFrame(this.dimensions, this.rightTitle, this.rightLines()));
    this.renderPrompt();
  }

  private renderPrompt(): void {
    if (this.stopped) return;
    const d = this.dimensions;
    this.terminal.write(promptFrame(d, this.agent.summary, renderInputLine(this.picker?.input ?? this.input, d.columns - 5)));
  }

  private drawImage(): void {
    if (!this.image) return;
    const column = 2 + this.image.leftCells;
    this.terminal.write(`${ESC}7${ESC}[2;${column}H${this.image.sixel}${ESC}8`);
    this.renderPrompt();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
