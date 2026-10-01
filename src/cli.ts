#!/usr/bin/env node
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

Keys:
  PageUp / PageDown        Scroll the paper by half a viewport
  Ctrl+PageUp / PageDown   Scroll the conversation
  Alt++ / Alt+-            Zoom from 50% to 250% (Alt+= also works)
  Enter                    Ask about the visible section
  /model                   Search authenticated vision models
  /model query             Select a match, or open a filtered picker
  /thinking                Pick a supported thinking level
  /thinking level          Change thinking; save the pi-paper default
  /new paper-name          Open another paper and clear the conversation
  /clear                   Start a fresh conversation
  Escape                   Cancel a picker or stop the current response
  Ctrl+C                   Cancel a picker, stop a response, or quit

Pickers: type to filter, ↑/↓ to navigate, Enter to select.`);
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
      if (!source.localPath) process.stderr.write(`Downloading ${source.label} (${source.url})…\n`);
    });
    ui = new PaperUi(paper.pdf, paper.source.label, papers);
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
