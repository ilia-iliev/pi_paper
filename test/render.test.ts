import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { PdfDocument, type RenderedSection } from "../src/pdf.js";
import type { PaperState } from "../src/paper-state.js";
import { PaperUi } from "../src/ui.js";

interface Harness {
  handleInput(data: string): void;
  handleResize(): void;
  submit(): Promise<void>;
  input: { setValue(value: string): void };
  refreshImage(): Promise<void>;
  renderFull(): void;
  renderRight(): void;
  image?: RenderedSection;
  agent: { events: { onDelta(delta: string): void; onChange(): void }; reset(): Promise<void> };
  messages: { role: string; text: string }[];
  terminal: { write(data: string): void };
}

const image: RenderedSection = { sixel: "SIXEL", leftCells: 0, width: 1, height: 1, png: () => "" };

function fixture(t: TestContext) {
  const pdf = new PdfDocument("unused", { pages: 3, widthPoints: 600, heightPoints: 800 });
  const ui = new PaperUi({ pdf, source: { label: "Paper" }, state: { sessionPath: "unused", savePosition: async () => {} } as unknown as PaperState }) as unknown as Harness;
  const writes: string[] = [];
  t.mock.method(ui.terminal, "write", (data: string) => { writes.push(data); });
  return { pdf, ui, writes };
}

test("renders requested while one is running collapse into a single follow-up", async (t) => {
  const { pdf, ui } = fixture(t);
  const finishers: (() => void)[] = [];
  const render = t.mock.method(pdf, "render", () => new Promise<RenderedSection>((resolve) => finishers.push(() => resolve(image))));
  const done = ui.refreshImage();
  void ui.refreshImage();
  void ui.refreshImage();
  finishers[0]!();
  await sleep(0);
  finishers[1]!();
  await done;
  assert.equal(render.mock.callCount(), 2);
});

test("scrolling updates the title without resending the stale image", (t) => {
  const { ui, writes } = fixture(t);
  t.mock.method(ui, "refreshImage", async () => {});
  ui.image = image;
  ui.handleInput("\x1b[6~");
  assert.ok(writes.some((data) => data.includes("PDF ·")));
  assert.ok(!writes.some((data) => data.includes("SIXEL")));
});

test("a full redraw is a single terminal write", (t) => {
  const { ui, writes } = fixture(t);
  ui.image = image;
  ui.renderFull();
  assert.equal(writes.length, 1);
  assert.ok(writes[0]!.includes("SIXEL"));
});

test("resizing renders once, after the terminal reports its cell size", async (t) => {
  const { ui } = fixture(t);
  const refresh = t.mock.method(ui, "refreshImage", async () => {});
  ui.handleResize();
  await sleep(0);
  assert.equal(refresh.mock.callCount(), 0);
  ui.handleInput("\x1b[4;768;1600t");
  await sleep(0);
  assert.equal(refresh.mock.callCount(), 1);
});

test("streamed deltas redraw the conversation at most once per frame", async (t) => {
  const { ui } = fixture(t);
  const render = t.mock.method(ui, "renderRight", () => {});
  ui.messages.push({ role: "Agent", text: "" });
  for (let i = 0; i < 50; i++) {
    ui.agent.events.onDelta("token ");
    ui.agent.events.onChange();
  }
  await sleep(50);
  assert.equal(render.mock.callCount(), 1);
  assert.equal(ui.messages[0]!.text, "token ".repeat(50));
});

test("/clear redraws the conversation without resending the image", async (t) => {
  const { ui, writes } = fixture(t);
  t.mock.method(ui.agent, "reset", async () => {});
  ui.image = image;
  ui.input.setValue("/clear");
  await ui.submit();
  assert.ok(writes.length > 0);
  assert.ok(!writes.some((data) => data.includes("SIXEL")));
});
