import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}
