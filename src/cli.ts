#!/usr/bin/env node
import { HELP_TEXT } from "./help.js";
import { PaperLibrary } from "./paper.js";
import { PaperUi } from "./ui.js";
import { update } from "./update.js";

function usage(): void {
  console.log(`Usage: pi-paper [paper-name|arxiv-link|arxiv-id|local.pdf]
       pi-paper update

Read a paper in a sixel-capable terminal and ask Pi about the visible section.
Names search arXiv titles without an agent; quote names containing spaces.
With no paper, reopen the last one (first run: Attention Is All You Need).
Use update to rebuild and reinstall your local source checkout.

${HELP_TEXT}`);
}

async function main(): Promise<void> {
  const argument = process.argv[2];
  if (argument === "--help" || argument === "-h") {
    usage();
    return;
  }
  if (process.argv.length > 3) throw new Error("Expected one paper name, link, path, or update (quote names with spaces)");
  if (argument === "update") {
    await update();
    return;
  }

  const papers = new PaperLibrary();
  let ui: PaperUi | undefined;
  try {
    const paper = await papers.open(argument, (source) => {
      process.stderr.write(`Downloading ${source.label} (${source.url})…\n`);
    });
    ui = new PaperUi(paper, papers);
    const stop = () => ui?.stop();
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    await ui.run(() => papers.remember(paper));
  } finally {
    ui?.stop();
    await papers.dispose();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`pi-paper: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
