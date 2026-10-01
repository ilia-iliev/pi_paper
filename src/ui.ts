import { decodeKittyPrintable, isKeyRelease, Key, matchesKey, parseKey, ProcessTerminal, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PaperAgent } from "./agent.js";
import { PdfDocument, type RenderedSection } from "./pdf.js";
import { PaperLibrary, type LoadedPaper } from "./paper.js";
import { matchingItems, SelectionPicker, type SelectionCommand, type SelectionOptions } from "./selection.js";
import { pad, truncate, wrapText } from "./text.js";

interface ConversationMessage {
  role: "You" | "Agent" | "App";
  text: string;
}

const HELP_TEXT = `Commands
/help — Show commands and keybindings
/new "paper name" — Open another paper and clear the conversation and agent context
/model [query] — Pick a vision model or select a unique match
/thinking [level] — Pick or set the thinking level
/clear — Clear the conversation and agent context
Model and thinking choices are saved for pi-paper.

Keybindings
PgUp / PgDn — Move through the PDF
Ctrl+PgUp / Ctrl+PgDn — Scroll the conversation
Alt++ / Alt+= / Alt+- — Zoom the PDF (50–250%)
Ctrl++ / Ctrl+= / Ctrl+- — Zoom aliases if the terminal passes them through
Enter — Submit a question or command
Esc — Stop the current response
Ctrl+C — Stop a response, or quit when idle
←/→ — Move the input cursor
Home / Ctrl+A — Start of input
End / Ctrl+E — End of input
Backspace / Delete — Delete before / after the cursor

Pickers
Type to filter · ↑/↓ to navigate
Enter — Select
Esc / Ctrl+C — Cancel`;

const ESC = "\x1b";
const PDF_ZOOM_IN_KEYS = new Set<string>([
  Key.alt("+"), Key.alt("="), Key.shiftAlt("+"), Key.shiftAlt("="),
  Key.ctrl("+"), Key.ctrl("="), Key.shiftCtrl("+"), Key.shiftCtrl("="),
]);
const PDF_ZOOM_OUT_KEYS = new Set<string>([Key.alt("-"), Key.ctrl("-")]);
const color = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  cyan: `${ESC}[36m`,
};

const plain = (text: string) => text;
const style = (open: number, close: number) => (text: string) => `${ESC}[${open}m${text}${ESC}[${close}m`;
const markdownTheme: MarkdownTheme = {
  heading: style(1, 22),
  link: style(36, 39),
  linkUrl: style(2, 22),
  code: style(36, 39),
  codeBlock: plain,
  codeBlockBorder: style(2, 22),
  quote: plain,
  quoteBorder: style(2, 22),
  hr: style(2, 22),
  listBullet: plain,
  bold: style(1, 22),
  italic: style(3, 23),
  strikethrough: style(9, 29),
  underline: style(4, 24),
};

export class PaperUi {
  private readonly terminal = new ProcessTerminal();
  private readonly agent: PaperAgent;
  private readonly messages: ConversationMessage[] = [];
  private readonly markdown = new WeakMap<ConversationMessage, { text: string; renderer: Markdown }>();
  private input: string[] = [];
  private cursor = 0;
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
  private status = "Starting agent…";
  private stopped = false;
  private resolveRun?: () => void;

  constructor(private pdf: PdfDocument, private title: string, private readonly papers = new PaperLibrary()) {
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
    if (agentResult.status === "fulfilled") {
      this.agentReady = true;
      this.status = "Ready";
    } else {
      this.agentError = `Agent unavailable: ${this.errorMessage(agentResult.reason)}`;
      this.status = this.agentError;
      this.messages.push({ role: "App", text: this.agentError });
    }
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
    const columns = this.terminal.columns;
    const rows = this.terminal.rows;
    const mainHeight = rows - 3;
    const leftWidth = Math.floor(columns * 0.64);
    return {
      columns,
      rows,
      mainHeight,
      leftWidth,
      leftInner: leftWidth - 2,
      rightInner: columns - leftWidth - 1,
      contentRows: mainHeight - 2,
    };
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
      if (this.busy) {
        this.agent.abort();
        this.status = "Stopping response…";
        this.renderPrompt();
      } else this.stop();
      return;
    }
    if (matchesKey(data, Key.escape) && this.busy) {
      this.agent.abort();
      this.status = "Stopping response…";
      this.renderPrompt();
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
    if (matchesKey(data, Key.left)) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.right)) this.cursor = Math.min(this.input.length, this.cursor + 1);
    else if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl("a"))) this.cursor = 0;
    else if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl("e"))) this.cursor = this.input.length;
    else if (matchesKey(data, Key.backspace)) {
      if (this.cursor > 0) this.input.splice(--this.cursor, 1);
    } else if (matchesKey(data, Key.delete)) {
      if (this.cursor < this.input.length) this.input.splice(this.cursor, 1);
    } else {
      const printable = decodeKittyPrintable(data) ?? (/^[^\x00-\x1f\x7f]+$/u.test(data) ? data : undefined);
      if (!printable) return;
      const characters = [...printable.replace(/[\r\n]/g, " ")];
      this.input.splice(this.cursor, 0, ...characters);
      this.cursor += characters.length;
    }
    this.renderPrompt();
  }

  private scrollPdf(direction: number): void {
    const amount = Math.max(1, Math.floor(this.dimensions.contentRows * this.cellHeight / 2));
    if (!this.pdf.scroll(direction * amount, this.dimensions.contentRows * this.cellHeight)) return;
    this.status = "Rendering…";
    this.imageCurrent = false;
    this.renderFull();
    void this.refreshImage();
  }

  private changeZoom(direction: number): void {
    if (!this.pdf.setZoom(direction, this.dimensions.contentRows * this.cellHeight)) return;
    this.status = "Rendering…";
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
      this.status = this.busy ? "Working…" : this.agentReady ? "Ready" : (this.agentError ?? "Starting agent…");
      this.renderFull();
    } catch (error) {
      if (generation !== this.renderGeneration || this.stopped) return;
      this.imageCurrent = false;
      this.status = this.errorMessage(error);
      this.messages.push({ role: "App", text: this.status });
      this.conversationOffset = 0;
      this.renderFull();
    }
  }

  private async submit(): Promise<void> {
    const question = this.input.join("").trim();
    if (!question || this.busy) return;
    this.input = [];
    this.cursor = 0;

    if (question === "/help") {
      this.messages.push({ role: "App", text: HELP_TEXT });
      this.conversationOffset = 0;
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
      this.status = "Clearing conversation…";
      try {
        await this.resetConversation();
      } finally {
        this.busy = false;
        this.renderFull();
      }
      return;
    }

    if (!this.agentReady) {
      this.status = this.agentError ?? "Agent unavailable; use /model or authenticate with pi /login";
      this.messages.push({ role: "App", text: this.status });
      this.conversationOffset = 0;
      this.renderRight();
      return;
    }
    if (!this.image || !this.imageCurrent) {
      this.status = "Wait for the PDF section to finish rendering";
      this.messages.push({ role: "App", text: this.status });
      this.conversationOffset = 0;
      this.renderRight();
      return;
    }

    this.messages.push({ role: "You", text: question }, { role: "Agent", text: "" });
    this.conversationOffset = 0;
    this.busy = true;
    this.status = "Agent is thinking…";
    this.renderRight();
    this.renderPrompt();
    const location = Math.round(100 * this.pdf.y / Math.max(1, this.pdf.pageHeight));
    const context = `Visible section: page ${this.pdf.page} of ${this.pdf.metadata.pages}, about ${location}% down the page, zoom ${this.pdf.zoom}%.`;
    try {
      await this.agent.ask(question, this.image.pngBase64, context);
      if (!this.messages.at(-1)?.text) this.messages.at(-1)!.text = "No response was returned.";
      this.status = "Ready";
    } catch (error) {
      const message = this.messages.at(-1);
      if (message) message.text += `${message.text ? "\n\n" : ""}Error: ${this.errorMessage(error)}`;
      this.status = "Ready";
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
      this.status = "Ready";
    } catch (error) {
      if (this.stopped) return;
      this.agentReady = false;
      this.agentError = `Agent unavailable: ${this.errorMessage(error)}`;
      this.status = this.agentError;
      this.messages.push({ role: "App", text: this.agentError });
    }
  }

  private async openNewPaper(input: string): Promise<void> {
    const quoted = /^["']/.test(input);
    const closed = input.length > 1 && input.at(-1) === input[0];
    const argument = (quoted && closed ? input.slice(1, -1) : input).trim();
    if (!argument || (quoted && !closed)) {
      this.messages.push({ role: "App", text: 'Usage: /new "paper name" (also accepts an arXiv link, ID, or local PDF path)' });
      this.conversationOffset = 0;
      this.renderRight();
      return;
    }

    this.busy = true;
    this.status = `Loading ${argument}…`;
    this.messages.push({ role: "App", text: this.status });
    this.conversationOffset = 0;
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
      this.status = "Starting agent…";
      await this.resetConversation();
      await this.papers.release(previousPdf);
    } catch (error) {
      if (this.stopped) return;
      this.status = this.errorMessage(error);
      this.messages.push({ role: "App", text: this.status });
      this.conversationOffset = 0;
    } finally {
      if (paper && !committed) await this.papers.release(paper.pdf);
      this.busy = false;
      this.renderFull();
    }
  }

  private async configureAgent(command: string): Promise<void> {
    this.busy = true;
    this.status = "Configuring agent…";
    this.renderPrompt();
    try {
      const [name, ...args] = command.trim().split(/\s+/);
      if (name === "/model" || name === "/thinking") {
        const options = await this.agent.getSelection(name);
        const query = args.join(" ");
        if (!options.items.length) throw new Error("No vision models available; authenticate with pi /login.");
        const matches = matchingItems(options.items, query);
        if (!query || matches.length > 1) {
          this.openPicker(name, options, query);
          return;
        }
        if (matches.length === 1) command = `${name} ${matches[0].value}`;
      }
      const response = await this.agent.configure(command);
      this.messages.push({ role: "App", text: response });
      this.status = this.agent.ready ? "Ready" : (this.agentError ?? "Select a vision model with /model");
    } catch (error) {
      this.status = this.errorMessage(error);
      this.messages.push({ role: "App", text: this.status });
    } finally {
      this.agentReady = this.agent.ready;
      if (this.agentReady) this.agentError = undefined;
      this.busy = false;
      if (!this.picker) this.conversationOffset = 0;
      this.renderRight();
    }
  }

  private openPicker(command: SelectionCommand, options: SelectionOptions, query: string): void {
    this.selectionCommand = command;
    const close = () => {
      this.picker = undefined;
      this.status = this.agent.ready ? "Ready" : (this.agentError ?? "Select a vision model with /model");
    };
    this.picker = new SelectionPicker(options, query, (value) => {
      close();
      void this.configureAgent(`${command} ${value}`);
    }, close);
  }

  private get rightTitle(): string {
    return this.picker ? (this.selectionCommand === "/model" ? "Model" : "Thinking Level") : "Conversation";
  }

  private rightLines(): string[] {
    const d = this.dimensions;
    return this.picker ? this.picker.render(d.rightInner - 1, d.contentRows) : this.visibleConversation();
  }

  private padRight(text: string): string {
    const width = this.dimensions.rightInner - 1;
    const clipped = truncateToWidth(text, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  private messageLines(message: ConversationMessage, width: number): string[] {
    const text = message.text || (message.role === "Agent" ? "…" : "");
    if (message.role !== "Agent") return wrapText(text, width);
    let cached = this.markdown.get(message);
    if (!cached) {
      cached = { text, renderer: new Markdown(text, 0, 0, markdownTheme) };
      this.markdown.set(message, cached);
    } else if (cached.text !== text) {
      cached.renderer.setText(text);
      cached.text = text;
    }
    return cached.renderer.render(width);
  }

  private conversationLines(): string[] {
    const width = Math.max(1, this.dimensions.rightInner - 2);
    const lines: string[] = [];
    for (const message of this.messages) {
      lines.push(`${message.role}:`);
      lines.push(...this.messageLines(message, width));
      lines.push("");
    }
    return lines;
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
    const leftTitle = `PDF · ${truncate(this.title, Math.max(4, d.leftInner - 28))} · ${this.pdf.zoom}% · ${this.pdf.page}/${this.pdf.metadata.pages}`;
    const output: string[] = [`${ESC}[?25l${ESC}[H`];
    output.push(`${color.dim}${this.border("┌", "┬", "┐", leftTitle, this.rightTitle)}${color.reset}`);
    const conversation = this.rightLines();
    for (let row = 0; row < d.contentRows; row++) {
      output.push(`\r\n${color.dim}│${" ".repeat(d.leftInner)}│${color.reset} ${this.padRight(conversation[row] ?? "")}${color.dim}│${color.reset}`);
    }
    output.push(`\r\n${color.dim}└${"─".repeat(d.leftInner)}┴${"─".repeat(d.rightInner)}┘${color.reset}`);
    this.terminal.write(output.join(""));
    this.renderPrompt();
    this.drawImage();
  }

  private renderRight(): void {
    if (this.stopped) return;
    const d = this.dimensions;
    const conversation = this.rightLines();
    let output = `${ESC}[?25l`;
    output += `${ESC}[1;${d.leftWidth}H${color.dim}┬${this.borderSection(this.rightTitle, d.rightInner)}┐${color.reset}`;
    for (let row = 0; row < d.contentRows; row++) {
      output += `${ESC}[${row + 2};${d.leftWidth}H${color.dim}│${color.reset} ${this.padRight(conversation[row] ?? "")}${color.dim}│${color.reset}`;
    }
    output += `${ESC}[${d.mainHeight};${d.leftWidth}H${color.dim}┴${"─".repeat(d.rightInner)}┘${color.reset}`;
    this.terminal.write(output);
    this.renderPrompt();
  }

  private renderPrompt(): void {
    if (this.stopped) return;
    const d = this.dimensions;
    const summary = truncate(this.agent.summary, Math.max(5, d.columns - 6));
    const available = Math.max(1, d.columns - 6);
    const start = Math.max(0, this.cursor - available + 1);
    const shown = this.input.slice(start, start + available);
    const beforeCursor = shown.slice(0, this.cursor - start).join("");
    const search = this.picker?.renderInput(d.columns - 5);
    const inputText = search?.text ?? pad(shown.join(""), d.columns - 5);
    const cursorColumn = search ? 5 + search.cursor : 5 + [...beforeCursor].length;
    let output = `${ESC}[${d.mainHeight + 1};1H${color.dim}┌${this.borderSection(summary, d.columns - 2)}┐${color.reset}`;
    output += `${ESC}[${d.mainHeight + 2};1H${color.dim}│${color.reset} ${color.cyan}>${color.reset} ${inputText}${color.dim}│${color.reset}`;
    output += `${ESC}[${d.mainHeight + 3};1H${color.dim}└${"─".repeat(d.columns - 2)}┘${color.reset}`;
    output += `${ESC}[${d.mainHeight + 2};${cursorColumn}H${ESC}[?25h`;
    this.terminal.write(output);
  }

  private drawImage(): void {
    if (!this.image) return;
    const column = 2 + this.image.leftCells;
    this.terminal.write(`${ESC}7${ESC}[2;${column}H${this.image.sixel}${ESC}8`);
    this.renderPrompt();
  }

  private border(left: string, middle: string, right: string, leftTitle: string, rightTitle: string): string {
    const d = this.dimensions;
    return `${left}${this.borderSection(leftTitle, d.leftInner)}${middle}${this.borderSection(rightTitle, d.rightInner)}${right}`;
  }

  private borderSection(title: string, width: number): string {
    if (width < 3) return "─".repeat(Math.max(0, width));
    const label = ` ${truncate(title, width - 2)} `;
    return label + "─".repeat(Math.max(0, width - [...label].length));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
