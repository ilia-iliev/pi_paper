import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

async function runUpdate(exitCode: number) {
  const work = await mkdtemp(join(tmpdir(), "pi-paper-update-test-"));
  const log = join(work, "commands");
  try {
    await writeFile(log, "");
    await writeFile(join(work, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> "$PI_PAPER_UPDATE_LOG"
echo 'npm progress'
echo 'npm warning' >&2
exit "$PI_PAPER_TEST_NPM_EXIT"
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ["--import", join(sourceRoot, "node_modules/tsx/dist/loader.mjs"), join(sourceRoot, "src/cli.ts"), "update"], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        PATH: `${work}:${process.env.PATH}`,
        PI_PAPER_UPDATE_LOG: log,
        PI_PAPER_TEST_NPM_EXIT: String(exitCode),
      },
      encoding: "utf8",
    });
    const commands = (await readFile(log, "utf8")).trim();
    return { ...result, commands: commands ? commands.split("\n") : [] };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function runPaper(args: string[], savedPaper?: string, searchFeed?: string) {
  const work = await mkdtemp(join(tmpdir(), "pi-paper-history-test-"));
  const historyPath = join(work, "pi-paper", "last-paper");
  const preload = join(work, "fetch.mjs");
  try {
    await writeFile(preload, `globalThis.fetch = async (url) => {
      if (new URL(url).pathname === "/api/query" && ${JSON.stringify(searchFeed)} !== undefined) {
        return new Response(${JSON.stringify(searchFeed)});
      }
      throw new Error(\`Requested \${url}\`);
    };`);
    if (savedPaper) {
      await mkdir(join(work, "pi-paper"));
      await writeFile(historyPath, savedPaper);
    }
    const result = spawnSync(process.execPath, [
      "--import", preload,
      "--import", join(sourceRoot, "node_modules/tsx/dist/loader.mjs"),
      join(sourceRoot, "src/cli.ts"), ...args,
    ], {
      cwd: tmpdir(),
      env: { ...process.env, XDG_STATE_HOME: work, TMPDIR: work },
      encoding: "utf8",
    });
    return { ...result, savedPaper: savedPaper ? await readFile(historyPath, "utf8") : undefined };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test("no paper on first launch opens Attention Is All You Need", async () => {
  const result = await runPaper([]);
  assert.match(result.stderr, /Requested https:\/\/arxiv.org\/pdf\/1706\.03762\.pdf/);
  assert.doesNotMatch(result.stdout, /Usage:/);
});

test("no paper reopens the last saved paper", async () => {
  const result = await runPaper([], "https://arxiv.org/pdf/2401.12345.pdf");
  assert.match(result.stderr, /Requested https:\/\/arxiv.org\/pdf\/2401\.12345\.pdf/);
});

test("an explicit paper overrides history and a failed download leaves history intact", async () => {
  const savedPaper = "https://arxiv.org/pdf/2401.12345.pdf";
  const result = await runPaper(["1706.03762"], savedPaper);
  assert.match(result.stderr, /Requested https:\/\/arxiv.org\/pdf\/1706\.03762\.pdf/);
  assert.equal(result.savedPaper, savedPaper);
});

test("a paper name resolves before downloading and shows the matched title and link", async () => {
  const savedPaper = "https://arxiv.org/pdf/2401.12345.pdf";
  const result = await runPaper(["DeepSeek-v4.1"], savedPaper,
    '<feed><entry><id>http://arxiv.org/abs/2501.00002v2</id><title>DeepSeek-V4.1 Technical Report</title></entry></feed>');
  assert.match(result.stderr, /Downloading DeepSeek-V4\.1 Technical Report.*https:\/\/arxiv\.org\/pdf\/2501\.00002v2\.pdf/);
  assert.match(result.stderr, /Requested https:\/\/arxiv\.org\/pdf\/2501\.00002v2\.pdf/);
  assert.equal(result.savedPaper, savedPaper);
});

test("help does not open a paper or change history", async () => {
  const savedPaper = "https://arxiv.org/pdf/2401.12345.pdf";
  const result = await runPaper(["--help"], savedPaper);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stderr, /Requested/);
  assert.equal(result.savedPaper, savedPaper);
});

test("pi-paper and pi_paper both point to the CLI", async () => {
  const pkg = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  assert.equal(pkg.bin["pi-paper"], "dist/cli.js");
  assert.equal(pkg.bin.pi_paper, "dist/cli.js");
});

test("update rebuilds and installs the local checkout from any directory", async () => {
  const result = await runUpdate(0);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands, [
    `--prefix ${sourceRoot} install --include=dev`,
    `--prefix ${sourceRoot} run build`,
    `install -g ${sourceRoot}`,
  ]);
  assert.match(result.stdout, /npm progress/);
  assert.match(result.stderr, /npm warning/);
  assert.match(result.stdout, /Update complete/);
});

test("update stops on failure and keeps npm errors visible", async () => {
  const result = await runUpdate(7);
  assert.equal(result.status, 1);
  assert.equal(result.commands.length, 1);
  assert.match(result.stderr, /npm warning/);
  assert.match(result.stderr, /npm.*7/);
  assert.doesNotMatch(result.stdout, /Update complete/);
});
