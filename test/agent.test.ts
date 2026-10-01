import assert from "node:assert/strict";
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
  return { agent, harness, vision, otherVision, text, global, saved };
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

test("model selection accepts a short case-insensitive query", async (t) => {
  const { agent, harness, otherVision, saved } = await agentFixture(t);
  await agent.start();
  await agent.configure(`/model ${otherVision.id.slice(-8).toUpperCase()}`);
  assert.equal(harness.session.model!.id, otherVision.id);
  assert.equal(saved.at(-1)?.defaultModel, otherVision.id);
});

test("ambiguous model queries do not silently select or save", async (t) => {
  const { agent, harness, saved } = await agentFixture(t);
  await agent.start();
  const model = harness.session.model;
  await assert.rejects(agent.configure("/model a"), /Multiple models match/);
  assert.equal(harness.session.model, model);
  assert.deepEqual(saved, []);
});

test("model and thinking commands persist only paper defaults, preserving context", async (t) => {
  const { agent, harness, otherVision, global, saved } = await agentFixture(t);
  await agent.start();
  const originalGlobal = global.getGlobalSettings();
  const originalSession = harness.session;
  await agent.configure(`/model ${otherVision.provider}/${otherVision.id}`);
  assert.equal(harness.session, originalSession);
  const level = harness.session.getAvailableThinkingLevels()[0];
  await agent.configure(`/thinking ${level}`);
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
  await assert.rejects(agent.configure(`/model ${text.provider}/${text.id}`), /does not support images/);
  await assert.rejects(agent.configure("/model missing/model"), /Model unavailable/);
  await assert.rejects(agent.configure("/thinking impossible"), /Unsupported thinking level/);
  assert.equal(harness.session.model, model);
  assert.equal(harness.session.thinkingLevel, level);
  assert.deepEqual(saved, []);
});

test("text-only startup fails visibly and /model can recover", async (t) => {
  const { agent, vision, text, global } = await agentFixture(t);
  global.setDefaultModelAndProvider(text.provider, text.id);
  await assert.rejects(agent.start(), /does not support images/);
  assert.equal(agent.ready, false);
  await agent.configure(`/model ${vision.provider}/${vision.id}`);
  assert.equal(agent.ready, true);
});

test("unknown saved model fails visibly and /model can recover without a session", async (t) => {
  const { agent, vision } = await agentFixture(t, { defaultProvider: "missing", defaultModel: "model" });
  await assert.rejects(agent.start(), /Unknown model missing\/model/);
  await agent.configure(`/model ${vision.provider}/${vision.id}`);
  assert.equal(agent.ready, true);
});

test("blocked images fail at startup and before model selection", async (t) => {
  const { agent, global, vision } = await agentFixture(t);
  global.setBlockImages(true);
  await assert.rejects(agent.start(), /Images are blocked/);
  assert.equal(agent.ready, false);
  await assert.rejects(agent.configure(`/model ${vision.provider}/${vision.id}`), /Images are blocked/);
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

test("unknown slash commands never save defaults", async (t) => {
  const { agent, saved } = await agentFixture(t);
  await agent.start();
  await assert.rejects(agent.configure("/unknown"), /Unknown command/);
  assert.deepEqual(saved, []);
});
