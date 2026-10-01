import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { PaperAgent } from "../src/agent.js";
import { PaperSettings, type PaperDefaults } from "../src/settings.js";

async function agentFixture(t: TestContext, defaults: PaperDefaults = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-paper-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "models"),
    refreshOnCreate: false,
  });
  const vision = runtime.getModels("anthropic").find((model) => model.input.includes("image") && model.reasoning)!;
  const otherVision = runtime.getModels("openai").find((model) => model.input.includes("image"))!;
  const text = runtime.getModels().find((model) => !model.input.includes("image"))!;
  assert.ok(vision && otherVision && text);
  const global = SettingsManager.inMemory({
    defaultProvider: vision.provider,
    defaultModel: vision.id,
    defaultThinkingLevel: "medium",
    modelThinkingLevels: { [`${vision.provider}/${vision.id}`]: "high" },
  });
  const saved: PaperDefaults[] = [];
  t.mock.method(ModelRuntime, "create", async () => runtime);
  t.mock.method(runtime, "checkAuth", async () => ({ available: true }));
  t.mock.method(runtime, "getAvailable", async () => [vision, otherVision, text]);
  t.mock.method(SettingsManager, "create", () => global);
  t.mock.method(PaperSettings.prototype, "load", async () => defaults);
  t.mock.method(PaperSettings.prototype, "save", async (value: PaperDefaults) => { saved.push(value); });
  const agent = new PaperAgent({ onDelta() {} });
  t.after(() => agent.dispose());
  const harness = agent as unknown as { session: AgentSession; validateVision(model: unknown): void };
  return { agent, harness, vision, otherVision, text, global, saved, directory };
}

test("startup inherits Pi defaults but uses paper-specific thinking over Pi's per-model level", async (t) => {
  const { agent, harness, global } = await agentFixture(t, { defaultThinkingLevel: "low" });
  await agent.start();
  assert.equal(agent.ready, true);
  assert.equal(harness.session.thinkingLevel, "low");
  assert.equal(agent.summary, `${harness.session.model!.id} · low · $0.0000`);
  assert.equal(global.getModelThinkingLevel(harness.session.model!.provider, harness.session.model!.id), "high");
  assert.deepEqual(harness.session.getActiveToolNames(), []);
});

test("picker options include only vision models and supported thinking levels without saving", async (t) => {
  const { agent, harness, vision, text, saved } = await agentFixture(t);
  const models = await agent.getSelection("/model");
  assert.ok(models.items.some((item) => item.value === `${vision.provider}/${vision.id}`));
  assert.ok(!models.items.some((item) => item.value === `${text.provider}/${text.id}`));
  await assert.rejects(agent.getSelection("/thinking"), /Select a model/);
  await agent.start();
  const thinking = await agent.getSelection("/thinking");
  assert.equal(thinking.current, harness.session.thinkingLevel);
  assert.deepEqual(thinking.items.map((item) => item.value), harness.session.getAvailableThinkingLevels());
  assert.equal((await agent.getSelection("/model")).current, `${vision.provider}/${vision.id}`);
  assert.deepEqual(saved, []);
});

test("model selection is case-insensitive", async (t) => {
  const { agent, harness, otherVision, saved } = await agentFixture(t);
  await agent.start();
  await agent.select("/model", `${otherVision.provider}/${otherVision.id}`.toUpperCase());
  assert.equal(harness.session.model!.id, otherVision.id);
  assert.equal(saved.at(-1)?.defaultModel, otherVision.id);
});

test("model and thinking commands persist only paper defaults, preserving context", async (t) => {
  const { agent, harness, otherVision, global, saved } = await agentFixture(t);
  await agent.start();
  const originalGlobal = global.getGlobalSettings();
  const originalSession = harness.session;
  await agent.select("/model", `${otherVision.provider}/${otherVision.id}`);
  assert.equal(harness.session, originalSession);
  const level = harness.session.getAvailableThinkingLevels()[0];
  await agent.select("/thinking", level);
  assert.deepEqual(saved.at(-1), {
    defaultProvider: otherVision.provider,
    defaultModel: otherVision.id,
    defaultThinkingLevel: level,
  });
  assert.deepEqual(global.getGlobalSettings(), originalGlobal);
  await agent.reset();
  assert.equal(harness.session.model!.id, otherVision.id);
  assert.equal(harness.session.thinkingLevel, level);
});

test("unsupported selections do not change model, thinking, or saved defaults", async (t) => {
  const { agent, harness, text, saved } = await agentFixture(t);
  await agent.start();
  const model = harness.session.model;
  const level = harness.session.thinkingLevel;
  await assert.rejects(agent.select("/model", `${text.provider}/${text.id}`), /does not support images/);
  await assert.rejects(agent.select("/model", "missing/model"), /Model unavailable/);
  await assert.rejects(agent.select("/thinking", "impossible"), /Unsupported thinking level/);
  assert.equal(harness.session.model, model);
  assert.equal(harness.session.thinkingLevel, level);
  assert.deepEqual(saved, []);
});

test("text-only startup fails visibly and /model can recover", async (t) => {
  const { agent, vision, text, global } = await agentFixture(t);
  global.setDefaultModelAndProvider(text.provider, text.id);
  await assert.rejects(agent.start(), /does not support images/);
  assert.equal(agent.ready, false);
  await agent.select("/model", `${vision.provider}/${vision.id}`);
  assert.equal(agent.ready, true);
});

test("unknown saved model fails visibly and /model can recover without a session", async (t) => {
  const { agent, vision } = await agentFixture(t, { defaultProvider: "missing", defaultModel: "model" });
  await assert.rejects(agent.start(), /Unknown model missing\/model/);
  await agent.select("/model", `${vision.provider}/${vision.id}`);
  assert.equal(agent.ready, true);
});

test("blocked images fail at startup and before model selection", async (t) => {
  const { agent, global, vision } = await agentFixture(t);
  global.setBlockImages(true);
  await assert.rejects(agent.start(), /Images are blocked/);
  assert.equal(agent.ready, false);
  await assert.rejects(agent.select("/model", `${vision.provider}/${vision.id}`), /Images are blocked/);
});

test("cost includes SDK session totals and survives clearing the conversation", async (t) => {
  const { agent, harness } = await agentFixture(t);
  await agent.start();
  t.mock.method(harness.session, "getSessionStats", () => ({ cost: 0.1234 }));
  assert.match(agent.summary, / · \$0\.1234$/);
  await agent.reset();
  assert.match(agent.summary, / · \$0\.1234$/);
  t.mock.method(harness.session, "getSessionStats", () => ({ cost: 0.01 }));
  assert.match(agent.summary, / · \$0\.1334$/);
});

function answer(session: AgentSession, question: string, reply: string): void {
  const manager = session.sessionManager;
  const model = session.model!;
  manager.appendMessage({ role: "user", content: [{ type: "text", text: `Visible section: page 1.\n\nQuestion: ${question}` }], timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: reply }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  });
}

test("a paper session survives restarting and /clear deletes it", async (t) => {
  const { agent, harness, directory } = await agentFixture(t);
  const path = join(directory, "session.jsonl");
  await agent.open(path);
  answer(harness.session, "What is attention?", "A weighted average.");
  agent.dispose();

  const restored = new PaperAgent({ onDelta() {} });
  t.after(() => restored.dispose());
  await restored.open(path);
  assert.deepEqual(restored.history, [
    { role: "You", text: "What is attention?" },
    { role: "Agent", text: "A weighted average." },
  ]);
  assert.equal((restored as unknown as { session: AgentSession }).session.messages.length, 2);

  await restored.reset();
  assert.deepEqual(restored.history, []);
  assert.equal(existsSync(path), false);
});

test("an unchanged section is attached once until the conversation forgets it", async (t) => {
  const { agent, harness } = await agentFixture(t);
  await agent.start();
  // The SDK stores a resized copy of each prompt image.
  const prompt = t.mock.method(harness.session, "prompt", async (text: string, options: { images: { data: string }[] }) => {
    harness.session.messages.push({
      role: "user", timestamp: Date.now(),
      content: [{ type: "text", text }, ...options.images.map((image) => ({ ...image, data: `resized ${image.data}` }))],
    } as AgentSession["messages"][number]);
  });

  await agent.ask("What?", "same", "Visible section: page 1.");
  await agent.ask("Why?", "same", "Visible section: page 1.");
  await agent.ask("And this?", "other", "Visible section: page 2.");
  harness.session.messages.length = 0;
  await agent.ask("Again?", "other", "Visible section: page 2.");

  const calls = prompt.mock.calls.map((call) => call.arguments);
  assert.deepEqual(calls.map(([, options]) => options.images.map((image) => image.data)), [["same"], [], ["other"], ["other"]]);
  assert.equal(calls[1][0], "Visible section: page 1. Unchanged since the last attached image.\n\nQuestion: Why?");
});
