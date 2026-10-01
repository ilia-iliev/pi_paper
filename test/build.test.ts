import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

test("a clean build produces an executable CLI", async () => {
  const work = await mkdtemp(join(tmpdir(), "pi-paper-build-test-"));
  try {
    for (const path of ["package.json", "tsconfig.json", "src"]) {
      await cp(join(sourceRoot, path), join(work, path), { recursive: true });
    }
    await symlink(join(sourceRoot, "node_modules"), join(work, "node_modules"), "dir");
    const build = spawnSync("npm", ["run", "build"], { cwd: work, encoding: "utf8" });
    assert.equal(build.status, 0, build.stdout + build.stderr);

    const cli = join(work, "dist/cli.js");
    assert.notEqual((await stat(cli)).mode & 0o111, 0, "CLI must be executable");
    const help = spawnSync(cli, ["--help"], { cwd: work, encoding: "utf8" });
    assert.ifError(help.error);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: pi-paper/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
