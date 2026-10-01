import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { isKittyProtocolActive, setKittyProtocolActive, visibleWidth, type Input } from "@earendil-works/pi-tui";
import { PaperAgent } from "../src/agent.js";
import { PdfDocument, type PdfPosition } from "../src/pdf.js";
import type { PaperState } from "../src/paper-state.js";
import { PaperUi } from "../src/ui.js";
import { renderInputLine, type SelectionPicker } from "../src/selection.js";

interface UiHarness {
  handleInput(data: string): void;
  renderFull(): void;
  renderRight(): void;
  renderPrompt(): void;
  conversationLines(): string[];
  refreshImage(): Promise<void>;
  input: Input;
  picker?: SelectionPicker;
  submit(): Promise<void>;
  agent: PaperAgent;
  agentReady: boolean;
  busy: boolean;
  messages: { role: string; text: string }[];
  conversationOffset: number;
  terminal: { columns: number; rows: number; write(data: string): void };
  state: PaperState;
}

function paperUi(pdf: PdfDocument) {
  const state = { sessionPath: "unused", savePosition: async () => {} } as unknown as PaperState;
  return new PaperUi({ source: { label: "Paper" }, pdf, state });
}

const zoomShortcuts = [
  ["legacy Alt", "\x1b+", "\x1b-"],
  ["legacy Alt equals", "\x1b=", "\x1b-"],
  ["Kitty Alt", "\x1b[43;3u", "\x1b[45;3u"],
  ["Kitty Alt+Shift", "\x1b[43;4u", "\x1b[45;3u"],
  ["Kitty Alt equals", "\x1b[61;3u", "\x1b[45;3u"],
  ["Kitty Alt+Shift equals", "\x1b[61;4u", "\x1b[45;3u"],
  ["Kitty Ctrl alias", "\x1b[43;5u", "\x1b[45;5u"],
  ["Kitty Ctrl+Shift alias", "\x1b[43;6u", "\x1b[45;5u"],
  ["xterm Alt", "\x1b[27;3;43~", "\x1b[27;3;45~"],
] as const;

for (const kittyActive of [false, true]) {
  for (const [name, increase, decrease] of zoomShortcuts) {
    test(`${name} shortcuts zoom only the PDF (Kitty mode ${kittyActive})`, (t) => {
      const previousMode = isKittyProtocolActive();
      t.after(() => setKittyProtocolActive(previousMode));
      setKittyProtocolActive(kittyActive);
      const pdf = new PdfDocument("unused", { pages: 2, widthPoints: 600, heightPoints: 800 });
      const ui = paperUi(pdf) as unknown as UiHarness;
      const renderedZooms: number[] = [];
      t.mock.method(ui.terminal, "write", () => {});
      t.mock.method(ui, "renderPrompt", () => {});
      t.mock.method(ui, "refreshImage", async () => { renderedZooms.push(pdf.zoom); });

      ui.handleInput(increase);
      assert.equal(pdf.zoom, 125);
      assert.equal(pdf.pageWidth, 750);
      ui.handleInput(decrease);
      assert.equal(pdf.zoom, 100);
      assert.deepEqual(renderedZooms, [125, 100]);
      assert.equal(ui.input.getValue(), "");
    });
  }
}

test("scrolling and zooming save the paper position", (t) => {
  const pdf = new PdfDocument("unused", { pages: 2, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  t.mock.method(ui.terminal, "write", () => {});
  t.mock.method(ui, "refreshImage", async () => {});
  const save = t.mock.method(ui.state, "savePosition", async () => {});
  ui.handleInput("\x1b[6~");
  ui.handleInput("\x1b+");
  const [scrolled, zoomed] = save.mock.calls.map((call) => call.arguments[0] as PdfPosition);
  assert.equal(save.mock.callCount(), 2);
  assert.ok(scrolled!.y > 0 && scrolled!.zoom === 100);
  assert.deepEqual(zoomed, pdf.position);
  assert.equal(zoomed!.zoom, 125);
});

test("zoom ignores Kitty key releases but accepts repeats", (t) => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  t.mock.method(ui.terminal, "write", () => {});
  t.mock.method(ui, "refreshImage", async () => {});
  ui.handleInput("\x1b[43;3:1u");
  assert.equal(pdf.zoom, 125);
  ui.handleInput("\x1b[43;3:3u");
  assert.equal(pdf.zoom, 125);
  ui.handleInput("\x1b[43;3:2u");
  assert.equal(pdf.zoom, 150);
  ui.handleInput("\x1b[45;3:1u");
  assert.equal(pdf.zoom, 125);
  ui.handleInput("\x1b[45;3:3u");
  assert.equal(pdf.zoom, 125);
});

test("question input has no prompt of its own beside the frame's marker", () => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  ui.input.setValue("hi");
  assert.equal(stripVTControlCharacters(renderInputLine(ui.input, 20).text).trimEnd(), "hi");
});

test("unmodified plus and minus remain available in questions", (t) => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  t.mock.method(ui, "renderPrompt", () => {});
  ui.handleInput("+");
  ui.handleInput("-");
  assert.equal(pdf.zoom, 100);
  assert.equal(ui.input.getValue(), "+-");
});

for (const command of ["/model provider/model", "/thinking high"]) {
  test(`${command} is handled locally without requiring a rendered PDF`, async (t) => {
    const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
    const ui = paperUi(pdf) as unknown as UiHarness;
    t.mock.method(ui, "renderPrompt", () => {});
    t.mock.method(ui, "renderRight", () => {});
    t.mock.method(ui.agent, "getSelection", async () => ({ items: [{ value: command.split(" ")[1], label: command.split(" ")[1] }] }));
    const select = t.mock.method(ui.agent, "select", async () => "Configured");
    const ask = t.mock.method(ui.agent, "ask", async () => {});
    t.mock.getter(ui.agent, "ready", () => true);
    ui.input.setValue(command);
    await ui.submit();
    assert.deepEqual(select.mock.calls[0].arguments, command.split(" "));
    assert.equal(ask.mock.callCount(), 0);
    assert.equal(ui.agentReady, true);
    assert.equal(ui.busy, false);
    assert.deepEqual(ui.messages, [{ role: "App", text: "Configured" }]);
  });
}

test("configuration errors are visible and the next command remains usable", async (t) => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  t.mock.method(ui, "renderPrompt", () => {});
  t.mock.method(ui, "renderRight", () => {});
  t.mock.method(ui.agent, "getSelection", async () => ({ items: [{ value: "high", label: "high" }] }));
  t.mock.method(ui.agent, "select", async () => { throw new Error("Unsupported thinking level"); });
  ui.input.setValue("/thinking invalid");
  await ui.submit();
  assert.equal(ui.busy, false);
  assert.equal(ui.messages.at(-1)?.text, "Unsupported thinking level");
});

test("unknown slash commands are reported without reaching the agent", async (t) => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  t.mock.method(ui, "renderPrompt", () => {});
  t.mock.method(ui, "renderRight", () => {});
  const select = t.mock.method(ui.agent, "select", async () => "Configured");
  ui.input.setValue("/unknown");
  await ui.submit();
  assert.equal(select.mock.callCount(), 0);
  assert.match(ui.messages.at(-1)!.text, /Unknown command/);
});

for (const command of ["/model", "/thinking", "/model sol"]) {
  test(`${command} opens a searchable picker without changing settings or chat`, async (t) => {
    const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
    const ui = paperUi(pdf) as unknown as UiHarness;
    t.mock.method(ui, "renderPrompt", () => {});
    t.mock.method(ui, "renderRight", () => {});
    const items = command.startsWith("/model")
      ? [{ value: "provider/gpt-6-sol", label: "gpt-6-sol" }, { value: "provider/gpt-6.1-sol", label: "gpt-6.1-sol" }]
      : [{ value: "low", label: "low" }, { value: "high", label: "high" }];
    t.mock.method(ui.agent, "getSelection", async () => ({ items, current: items[0].value }));
    const select = t.mock.method(ui.agent, "select", async () => "Configured");
    const ask = t.mock.method(ui.agent, "ask", async () => {});
    ui.messages.push({ role: "You", text: "Keep this" });
    ui.conversationOffset = 5;
    ui.input.setValue(command);
    await ui.submit();
    assert.ok(ui.picker);
    assert.equal(ui.busy, false);
    assert.equal(select.mock.callCount(), 0);
    assert.equal(ask.mock.callCount(), 0);
    assert.equal(ui.conversationOffset, 5);
    assert.deepEqual(ui.messages, [{ role: "You", text: "Keep this" }]);
    ui.handleInput("\x1b[B");
    ui.handleInput("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.picker, undefined);
    assert.deepEqual(select.mock.calls[0].arguments, [command.split(" ")[0], items[1].value]);
  });
}

for (const cancel of ["\x1b", "\x03"]) {
  test("picker cancellation restores conversation without saving or quitting", async (t) => {
    const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
    const ui = paperUi(pdf) as unknown as UiHarness;
    t.mock.method(ui, "renderPrompt", () => {});
    t.mock.method(ui, "renderRight", () => {});
    t.mock.method(ui.agent, "getSelection", async () => ({ items: [{ value: "high", label: "high" }] }));
    const select = t.mock.method(ui.agent, "select", async () => "Configured");
    ui.input.setValue("/thinking");
    await ui.submit();
    ui.handleInput(cancel);
    assert.equal(ui.picker, undefined);
    assert.equal(select.mock.callCount(), 0);
    assert.deepEqual(ui.messages, []);
  });
}

test("picker renders in the conversation pane, survives full redraws, and restores chat on cancel", async (t) => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  let output = "";
  Object.defineProperties(ui.terminal, { columns: { value: 140 }, rows: { value: 30 } });
  t.mock.method(ui.terminal, "write", (data: string) => { output += data; });
  t.mock.method(ui.agent, "getSelection", async () => ({ items: [
    { value: "provider/gpt-6-sol", label: "gpt-6-sol" },
    { value: "provider/gpt-6.1-sol", label: "gpt-6.1-sol" },
  ] }));
  ui.messages.push({ role: "You", text: "Previous question" });
  ui.input.setValue("/model");
  await ui.submit();
  output = "";
  ui.renderFull();
  assert.ok(output.includes("Model"));
  assert.ok(!output.includes("↑/↓ navigate"));
  assert.ok(!output.includes("saved for pi-paper"));
  assert.ok(output.includes("gpt-6.1-sol"));
  assert.ok(!output.includes("Previous question"));
  ui.handleInput("6.1-sol");
  ui.handleInput("\x1b");
  assert.equal(ui.picker, undefined);
  assert.ok(output.includes("Conversation"));
  assert.ok(output.includes("Previous question"));
});

test("prompt bar shows only model, thinking level, and cost, with no footer hints", (t) => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  let output = "";
  Object.defineProperties(ui.terminal, { columns: { value: 140 }, rows: { value: 30 } });
  t.mock.method(ui.terminal, "write", (data: string) => { output += data; });
  t.mock.getter(ui.agent, "summary", () => "model · high · $0.1234");
  ui.renderPrompt();
  assert.ok(output.includes("model · high · $0.1234"));
  for (const hidden of ["provider/", "tokens", "PgUp", "/model", "quit"]) {
    assert.ok(!output.includes(hidden), `Unexpected text: ${hidden}`);
  }
  assert.ok(output.includes(`└${"─".repeat(138)}┘`));
});

test("/help lists commands and keybindings locally without an agent or rendered PDF", async (t) => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  const render = t.mock.method(ui, "renderRight", () => {});
  t.mock.method(ui, "renderPrompt", () => {});
  const select = t.mock.method(ui.agent, "select", async () => "Configured");
  const ask = t.mock.method(ui.agent, "ask", async () => {});
  ui.messages.push({ role: "You", text: "Keep this" });
  ui.conversationOffset = 5;
  ui.input.setValue("/help");
  await ui.submit();
  assert.equal(select.mock.callCount(), 0);
  assert.equal(ask.mock.callCount(), 0);
  assert.equal(ui.busy, false);
  assert.equal(ui.input.getValue(), "");
  assert.equal(ui.conversationOffset, 0);
  assert.equal(ui.messages[0].text, "Keep this");
  assert.equal(ui.messages.at(-1)?.role, "App");
  const help = ui.messages.at(-1)!.text;
  for (const entry of ["/help", "/new", "/model", "/thinking", "/clear", "PgUp", "PgDn", "Ctrl+PgUp", "Ctrl+PgDn", "Alt", "Ctrl", "Enter", "Esc", "Ctrl+C", "Home", "End", "Ctrl+A", "Ctrl+E", "Backspace", "Delete", "↑/↓", "←/→"]) {
    assert.ok(help.includes(entry), `Missing help entry: ${entry}`);
  }
  assert.equal(render.mock.callCount(), 1);
});

test("agent responses render Markdown and inline/display formulas instead of raw syntax", () => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  Object.defineProperties(ui.terminal, { columns: { value: 220 }, rows: { value: 40 } });
  const source = String.raw`**Embed each token:** use \(d_{\text{model}}=512\).

\[
x_i=e_i+p_i,
\]

Also $\alpha^2 \leq \beta$ and

$$\frac{1}{2}$$`;
  ui.messages.push({ role: "Agent", text: source });
  const lines = ui.conversationLines();
  const text = lines.map(stripVTControlCharacters).join("\n");
  assert.ok(text.includes("Embed each token:"));
  assert.ok(!text.includes("**"));
  assert.ok(text.includes("d_model = 512"));
  assert.ok(text.includes("xᵢ = eᵢ+pᵢ,"));
  assert.ok(text.includes("α² ≤ β"));
  assert.ok(text.includes("─"), "display fractions should have a fraction bar");
  assert.ok(!text.includes("\\("));
  assert.ok(!text.includes("\\["));
  assert.ok(!text.includes("\\frac"));
  assert.ok(lines.every((line) => visibleWidth(line) <= 77));
  assert.equal(ui.messages[0].text, source, "formatting must not change conversation source");
});

test("display formulas directly after a paragraph line render as math, not setext headings", () => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  Object.defineProperties(ui.terminal, { columns: { value: 220 }, rows: { value: 40 } });
  ui.messages.push({ role: "Agent", text: String.raw`The mask allows only positions t-1,t, so:
\[
a_t
=
\alpha_{t,t}
+
\alpha_{t,t-1}.
\]

Then
$$
\frac{1}{2}
=
\beta
$$` });
  const text = ui.conversationLines().map(stripVTControlCharacters).join("\n");
  assert.ok(!text.includes("\\["));
  assert.ok(!text.includes("\\alpha"));
  assert.ok(text.includes("α"));
  assert.ok(text.includes("β"));
  assert.ok(!text.includes("$$"));
});

test("tables align cells and wrap within the conversation pane after resize", () => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  let columns = 220;
  Object.defineProperties(ui.terminal, { columns: { get: () => columns }, rows: { value: 40 } });
  ui.messages.push({ role: "Agent", text: String.raw`| Position \(i\) | Token | Token ID | Embedding \(e_i\) | Positional encoding \(p_i\) | Encoder input \(x_i=e_i+p_i\) |
|---|---|---|---|---|---|
| 0 | The | 17 | \([0.2, 0.5, -0.1]\) | \([0.0, 1.0, 0.0]\) | \([0.2, 1.5, -0.1]\) |
| 1 | cat | 42 | \([0.8, -0.3, 0.4]\) | \([0.8, 0.5, 0.1]\) | \([1.6, 0.2, 0.5]\) |` });
  for (columns of [220, 140, 220]) {
    const width = columns - Math.floor(columns * 0.64) - 3;
    const lines = ui.conversationLines().map(stripVTControlCharacters);
    assert.ok(lines.some((line) => line.startsWith("┌")), "expected a table border");
    assert.ok(lines.some((line) => line.startsWith("└")));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(!lines.join("\n").includes("|---"));
    assert.ok(!lines.join("\n").includes("\\("));
    const rows = lines.filter((line) => line.startsWith("│"));
    const positions = rows.map((line) => [...line.matchAll(/│/g)].map((match) => visibleWidth(line.slice(0, match.index))));
    assert.ok(positions[0].length === 7);
    for (const position of positions) assert.deepEqual(position, positions[0]);
    assert.ok(rows.join("\n").includes("cat"));
  }
});

test("streamed responses re-render when math and table syntax becomes complete", () => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  Object.defineProperties(ui.terminal, { columns: { value: 180 }, rows: { value: 40 } });
  const message = { role: "Agent", text: String.raw`Input \(x_i` };
  ui.messages.push(message);
  assert.ok(ui.conversationLines().join("\n").includes("Input"));
  message.text += String.raw`=e_i+p_i\)

| Token | Input |
|---|---|
| cat | \(x_i\) |`;
  const complete = ui.conversationLines().map(stripVTControlCharacters).join("\n");
  assert.ok(complete.includes("xᵢ = eᵢ+pᵢ"));
  assert.ok(complete.includes("┌"));
  assert.ok(complete.includes("cat"));
});

test("questions and app messages remain literal text, and code is not interpreted as math", () => {
  const pdf = new PdfDocument("unused", { pages: 1, widthPoints: 600, heightPoints: 800 });
  const ui = paperUi(pdf) as unknown as UiHarness;
  Object.defineProperties(ui.terminal, { columns: { value: 220 }, rows: { value: 40 } });
  ui.messages.push(
    { role: "You", text: String.raw`Explain **this** and \(x_i\)` },
    { role: "App", text: "An error with **literal** markers" },
    { role: "Agent", text: "`\\(x_i\\)`\n\n```text\n\\[x_i\\]\n```" },
  );
  const text = ui.conversationLines().map(stripVTControlCharacters).join("\n");
  assert.ok(text.includes(String.raw`Explain **this** and \(x_i\)`));
  assert.ok(text.includes("An error with **literal** markers"));
  assert.ok(text.includes(String.raw`\[x_i\]`));
  assert.ok(!text.includes("xᵢ"));
});
