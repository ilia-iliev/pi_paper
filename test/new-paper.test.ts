import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PaperLibrary } from "../src/paper.js";
import { PdfDocument, type RenderedSection } from "../src/pdf.js";
import { PaperUi } from "../src/ui.js";
import type { Input } from "@earendil-works/pi-tui";
import { PaperAgent } from "../src/agent.js";

interface Harness {
  submit(): Promise<void>;
  refreshImage(): Promise<void>;
  renderFull(): void;
  renderRight(): void;
  renderPrompt(): void;
  pdf: PdfDocument;
  title: string;
  agent: PaperAgent;
  agentReady: boolean;
  agentError?: string;
  input: Input;
  messages: { role: string; text: string }[];
  conversationOffset: number;
  image?: RenderedSection;
  imageCurrent: boolean;
  busy: boolean;
  stopped: boolean;
  terminal: { setTitle(title: string): void };
}

const image: RenderedSection = { sixel: "new", pngBase64: "new-image", width: 1, height: 1, leftCells: 0 };

function fixture(t: TestContext) {
  const oldPdf = new PdfDocument("old.pdf", { pages: 3, widthPoints: 600, heightPoints: 800 });
  oldPdf.page = 2;
  oldPdf.y = 200;
  oldPdf.zoom = 150;
  const pdf = new PdfDocument("new.pdf", { pages: 10, widthPoints: 600, heightPoints: 800 });
  const paper = { pdf, source: { label: "New Paper", url: "https://arxiv.org/pdf/1706.03762.pdf" } };
  const library = new PaperLibrary();
  const ui = new PaperUi(oldPdf, "Old Paper", library) as unknown as Harness;
  t.mock.method(ui, "renderFull", () => {});
  t.mock.method(ui, "renderRight", () => {});
  t.mock.method(ui, "renderPrompt", () => {});
  const setTitle = t.mock.method(ui.terminal, "setTitle", () => {});
  const open = t.mock.method(library, "open", async () => paper);
  const remember = t.mock.method(library, "remember", async () => {});
  const release = t.mock.method(library, "release", async () => {});
  const reset = t.mock.method(ui.agent, "reset", async () => {});
  const select = t.mock.method(ui.agent, "select", async () => "Configured");
  const ask = t.mock.method(ui.agent, "ask", async () => {});
  t.mock.method(pdf, "render", async () => image);
  ui.messages.push({ role: "You", text: "Old context" }, { role: "Agent", text: "Old answer" });
  ui.conversationOffset = 5;
  ui.agentReady = true;
  ui.image = { ...image, pngBase64: "old-image" };
  ui.imageCurrent = true;
  return { ui, library, oldPdf, paper, open, remember, release, reset, select, ask, setTitle };
}

for (const input of ['/new "Attention Is All You Need"', "/new Attention Is All You Need", "/new 'Attention Is All You Need'"]) {
  test(`${input} loads a fresh paper and clears context without asking the agent`, async (t) => {
    const f = fixture(t);
    f.ui.input.setValue(input);
    await f.ui.submit();
    assert.equal(f.open.mock.calls[0].arguments[0], "Attention Is All You Need");
    assert.equal(f.ui.pdf, f.paper.pdf);
    assert.equal(f.ui.title, "New Paper");
    assert.deepEqual([f.ui.pdf.page, f.ui.pdf.y, f.ui.pdf.zoom], [1, 0, 100]);
    assert.deepEqual(f.ui.messages, []);
    assert.equal(f.ui.input.getValue(), "");
    assert.equal(f.ui.conversationOffset, 0);
    assert.equal(f.ui.image?.pngBase64, "new-image");
    assert.equal(f.ui.imageCurrent, true);
    assert.equal(f.reset.mock.callCount(), 1);
    assert.equal(f.select.mock.callCount(), 0);
    assert.equal(f.ask.mock.callCount(), 0);
    assert.equal(f.remember.mock.calls[0].arguments[0], f.paper);
    assert.equal(f.release.mock.calls[0].arguments[0], f.oldPdf);
    assert.equal(f.setTitle.mock.calls[0].arguments[0], "pi paper — New Paper");
    assert.equal(f.ui.busy, false);
    assert.equal(f.ui.agentReady, true);
  });
}

for (const input of ["/new", '/new ""', '/new "unterminated']) {
  test(`${input} shows usage without touching the paper or context`, async (t) => {
    const f = fixture(t);
    f.ui.input.setValue(input);
    await f.ui.submit();
    assert.equal(f.open.mock.callCount(), 0);
    assert.equal(f.reset.mock.callCount(), 0);
    assert.equal(f.ui.pdf, f.oldPdf);
    assert.equal(f.ui.messages[0].text, "Old context");
    assert.match(f.ui.messages.at(-1)!.text, /Usage: \/new/);
  });
}

for (const failure of ["open", "render", "remember"] as const) {
  test(`failed ${failure} preserves the old paper, image, context and history`, async (t) => {
    const f = fixture(t);
    const fail = async () => { throw new Error(`Failed ${failure}`); };
    if (failure === "open") t.mock.method(f.library, "open", fail);
    if (failure === "render") t.mock.method(f.paper.pdf, "render", fail);
    if (failure === "remember") t.mock.method(f.library, "remember", fail);
    f.ui.input.setValue("/new missing");
    await f.ui.submit();
    assert.equal(f.ui.pdf, f.oldPdf);
    assert.equal(f.ui.title, "Old Paper");
    assert.equal(f.ui.image?.pngBase64, "old-image");
    assert.equal(f.ui.imageCurrent, true);
    assert.equal(f.ui.messages[0].text, "Old context");
    assert.match(f.ui.messages.at(-1)!.text, new RegExp(`Failed ${failure}`));
    assert.equal(f.reset.mock.callCount(), 0);
    assert.equal(f.ui.busy, false);
    if (failure === "render") assert.equal(f.remember.mock.callCount(), 0);
    if (failure !== "open") assert.equal(f.release.mock.calls[0].arguments[0], f.paper.pdf);
  });
}

test("agent restart failure still opens the paper with fresh context and permits recovery", async (t) => {
  const f = fixture(t);
  f.ui.agentReady = false;
  t.mock.method(f.ui.agent, "reset", async () => { throw new Error("No authentication"); });
  f.ui.input.setValue("/new 1706.03762");
  await f.ui.submit();
  assert.equal(f.ui.pdf, f.paper.pdf);
  assert.equal(f.ui.messages.length, 1);
  assert.match(f.ui.messages[0].text, /Agent unavailable: No authentication/);
  assert.equal(f.ui.agentReady, false);
  assert.equal(f.ui.busy, false);
  assert.equal(f.remember.mock.callCount(), 1);
});

test("a render from the previous paper cannot overwrite the new image", async (t) => {
  const f = fixture(t);
  let finish!: (value: RenderedSection) => void;
  t.mock.method(f.oldPdf, "render", () => new Promise<RenderedSection>((resolve) => { finish = resolve; }));
  const pending = f.ui.refreshImage();
  f.ui.input.setValue("/new new paper");
  await f.ui.submit();
  finish({ ...image, pngBase64: "stale-image" });
  await pending;
  assert.equal(f.ui.image?.pngBase64, "new-image");
});

test("closing during lookup releases the pending paper without changing history or restarting", async (t) => {
  const f = fixture(t);
  let finish!: (value: typeof f.paper) => void;
  t.mock.method(f.library, "open", () => new Promise<typeof f.paper>((resolve) => { finish = resolve; }));
  f.ui.input.setValue("/new new paper");
  const pending = f.ui.submit();
  f.ui.stopped = true;
  finish(f.paper);
  await pending;
  assert.equal(f.ui.pdf, f.oldPdf);
  assert.equal(f.reset.mock.callCount(), 0);
  assert.equal(f.remember.mock.callCount(), 0);
  assert.equal(f.release.mock.calls[0].arguments[0], f.paper.pdf);
});

test("the first question after /new uses only the new PDF image and location", async (t) => {
  const f = fixture(t);
  f.ui.input.setValue("/new new paper");
  await f.ui.submit();
  f.ui.input.setValue("Explain this figure");
  await f.ui.submit();
  assert.deepEqual(f.ask.mock.calls[0].arguments, [
    "Explain this figure", "new-image", "Visible section: page 1 of 10, about 0% down the page, zoom 100%.",
  ]);
  assert.equal(f.ui.messages[0].text, "Explain this figure");
  assert.equal(f.ui.messages.some(({ text }) => text.includes("Old context")), false);
});

test("/clear still resets context without replacing the paper", async (t) => {
  const f = fixture(t);
  f.ui.input.setValue("/clear");
  await f.ui.submit();
  assert.equal(f.ui.pdf, f.oldPdf);
  assert.equal(f.ui.image?.pngBase64, "old-image");
  assert.deepEqual(f.ui.messages, []);
  assert.equal(f.reset.mock.callCount(), 1);
  assert.equal(f.open.mock.callCount(), 0);
  assert.equal(f.ui.busy, false);
});

test("/new cannot start a second load while busy", async (t) => {
  const f = fixture(t);
  f.ui.busy = true;
  f.ui.input.setValue("/new new paper");
  await f.ui.submit();
  assert.equal(f.open.mock.callCount(), 0);
  assert.equal(f.reset.mock.callCount(), 0);
});
