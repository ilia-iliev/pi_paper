import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PaperSettings } from "../src/settings.js";

async function settingsFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-paper-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, settings: new PaperSettings(directory) };
}

test("missing paper settings inherit Pi defaults", async (t) => {
  const { settings } = await settingsFixture(t);
  assert.deepEqual(await settings.load(), {});
});

test("paper defaults persist across instances", async (t) => {
  const { directory, settings } = await settingsFixture(t);
  const defaults = { defaultProvider: "provider", defaultModel: "model/with/slashes", defaultThinkingLevel: "high" } as const;
  await settings.save(defaults);
  assert.deepEqual(await new PaperSettings(directory).load(), defaults);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")), defaults);
});

for (const value of [null, [], "bad", { defaultModel: "model" }, { defaultProvider: 1 }, { defaultProvider: "", defaultModel: "" }, { defaultThinkingLevel: "invalid" }]) {
  test(`invalid paper settings remain visible: ${JSON.stringify(value)}`, async (t) => {
    const { directory, settings } = await settingsFixture(t);
    await writeFile(join(directory, "settings.json"), JSON.stringify(value));
    await assert.rejects(settings.load(), /Invalid pi-paper settings/);
  });
}

test("paper settings cannot override unrelated inherited Pi settings", async (t) => {
  const { directory, settings } = await settingsFixture(t);
  await writeFile(join(directory, "settings.json"), JSON.stringify({
    defaultThinkingLevel: "low",
    images: { blockImages: false },
  }));
  assert.deepEqual(await settings.load(), { defaultThinkingLevel: "low" });
});

test("malformed JSON remains visible", async (t) => {
  const { directory, settings } = await settingsFixture(t);
  await writeFile(join(directory, "settings.json"), "{");
  await assert.rejects(settings.load(), SyntaxError);
});
