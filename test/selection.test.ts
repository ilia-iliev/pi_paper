import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, isKittyProtocolActive, setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import { matchingItems, renderInputLine, SelectionPicker } from "../src/selection.js";

const items = [
  { value: "openai-codex/gpt-6-sol", label: "gpt-6-sol", description: "[openai-codex] GPT 6 Sol" },
  { value: "openai-codex/gpt-6.1-sol", label: "gpt-6.1-sol", description: "[openai-codex] GPT 6.1 Sol" },
  { value: "anthropic/claude-sonnet", label: "claude-sonnet", description: "[anthropic] Claude Sonnet" },
];

test("matching accepts suffixes, fuzzy queries, names, providers, and exact IDs", () => {
  assert.equal(matchingItems(items, "6.1-SOL")[0].value, items[1].value);
  assert.equal(matchingItems(items, "codex sol").length, 2);
  assert.equal(matchingItems(items, "anthropic")[0].value, items[2].value);
  assert.equal(matchingItems(items, "gpt-6-sol").length, 1);
  assert.equal(matchingItems(items, "openai-codex/gpt-6-sol").length, 1);
  assert.equal(matchingItems(items, "nonexistent").length, 0);
});

test("picker preselects the current item and wraps arrow navigation", () => {
  const selected: string[] = [];
  const picker = new SelectionPicker({ items, current: items[1].value }, "", (value) => selected.push(value), () => {});
  assert.equal(renderInputLine(picker.input, 50).cursor, 0);
  picker.handleInput("\r");
  assert.deepEqual(selected, [items[1].value]);
  picker.handleInput("\x1b[B");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  assert.equal(selected.at(-1), items[0].value);
  picker.handleInput("\x1b[A");
  picker.handleInput("\r");
  assert.equal(selected.at(-1), items[2].value);
});

test("typing filters immediately and an empty result cannot select", () => {
  const selected: string[] = [];
  const picker = new SelectionPicker({ items }, "", (value) => selected.push(value), () => {});
  for (const character of "6.1-sol") picker.handleInput(character);
  picker.handleInput("\r");
  assert.deepEqual(selected, [items[1].value]);
  picker.handleInput("z");
  assert.ok(picker.render(50, 8)[0].includes("No matching choices"));
  picker.handleInput("\x1b[A");
  picker.handleInput("\r");
  assert.equal(selected.length, 1);
  picker.handleInput("\x7f");
  picker.handleInput("\r");
  assert.equal(selected.length, 2);
});

test("resize preserves selection and all rendered lines fit their viewport", () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ value: `model-${index}`, label: `模型-${index} 🔬`, description: "Provider" }));
  const selected: string[] = [];
  const picker = new SelectionPicker({ items: many, current: many[20].value }, "", (value) => selected.push(value), () => {});
  for (const [width, height] of [[24, 3], [80, 15], [12, 2]]) {
    const lines = picker.render(width, height);
    assert.ok(lines.length <= height);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    picker.handleInput("\r");
    assert.equal(selected.at(-1), many[20].value);
  }
  for (const character of "模型".repeat(30)) picker.handleInput(character);
  const input = renderInputLine(picker.input, 16);
  assert.equal(visibleWidth(input.text), 16);
  assert.ok(input.cursor >= 0 && input.cursor < 16);
  assert.ok(!input.text.includes(CURSOR_MARKER));
});

test("Kitty printable keys filter, repeats navigate, and releases do nothing", (t) => {
  const previous = isKittyProtocolActive();
  t.after(() => setKittyProtocolActive(previous));
  setKittyProtocolActive(true);
  const selected: string[] = [];
  const picker = new SelectionPicker({ items }, "sol", (value) => selected.push(value), () => {});
  picker.handleInput("\x1b[1;1:3B");
  picker.handleInput("\r");
  assert.equal(selected.at(-1), items[0].value);
  picker.handleInput("\x1b[1;1:2B");
  picker.handleInput("\r");
  assert.equal(selected.at(-1), items[1].value);
  const filtered = new SelectionPicker({ items }, "6.1-so", (value) => selected.push(value), () => {});
  filtered.handleInput("\x1b[108u");
  filtered.handleInput("\r");
  assert.equal(selected.at(-1), items[1].value);
});
