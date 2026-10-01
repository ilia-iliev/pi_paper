import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function runNpm(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(" ")} failed: ${signal ?? `exit ${code}`}`));
    });
  });
}

export async function update(): Promise<void> {
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  if (!existsSync(join(sourceRoot, "src/cli.ts"))) {
    throw new Error("Update requires a local source checkout. Install it with: npm install -g /path/to/pi_paper");
  }
  console.log(`Updating from ${sourceRoot}…`);
  await runNpm(["--prefix", sourceRoot, "install", "--include=dev"]);
  await runNpm(["--prefix", sourceRoot, "run", "build"]);
  await runNpm(["install", "-g", sourceRoot]);
  console.log("Update complete. Run pi-paper to open a paper.");
}
