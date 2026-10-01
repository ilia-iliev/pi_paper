# pi-paper

Read an arXiv paper beside a Pi conversation in a terminal. The visible PDF section is attached to each question, so the agent can explain the exact figure, equation, or paragraph on screen.

## Requirements

- Node.js 22.19+
- `pdfinfo` and `pdftoppm` (Poppler)
- A sixel-capable terminal; the primary target is [foot](https://codeberg.org/dnkl/foot)
- A vision-capable model configured in Pi (`pi` → `/login`)

## Install

```sh
npm install
npm run build
npm link
```

Then open a paper by name, abstract URL, PDF URL, arXiv identifier, or local PDF:

```sh
pi-paper DeepSeek-v4.1
pi-paper "Attention Is All You Need"
pi-paper "https://arxiv.org/abs/1706.03762"
pi-paper 1706.03762
pi-paper ./paper.pdf
pi-paper
```

Names search arXiv's public API and rank the top 50 results by title similarity—no agent, API key, or LLM cost. Matching ignores case, punctuation, and spacing, and tolerates minor title typos when arXiv returns a candidate. Model version numbers must match exactly. The matched title and PDF link are printed before downloading; weak matches fail with a request for a fuller title or explicit link. This searches arXiv titles, not Google, so arbitrary nicknames and unpublished reports may not resolve. Quote names containing spaces.

With no argument, reopen the last paper. On first launch, open *Attention Is All You Need* (`1706.03762`). The last paper is saved under `${XDG_STATE_HOME:-~/.local/state}/pi-paper/last-paper`; local PDFs use absolute paths.

Each paper keeps one history: its position (page, scroll, zoom) and conversation are saved as you go under `pi-paper/papers/`, so reopening the same paper—after quitting or an accidental `Ctrl+C`—resumes where you left off. `/clear` deletes that paper's conversation.

`pi_paper` remains an alias. To update after changing the local source:

```sh
pi-paper update
```

This installs dependencies, rebuilds, and reinstalls the checkout the command points to. It works from any directory; it does not pull Git changes or use an npm registry release. Keep the source checkout on disk.

## Keys

| Key | Action |
|---|---|
| `PageUp` / `PageDown` | Move through the PDF by half a viewport |
| `Ctrl+PageUp` / `Ctrl+PageDown` | Scroll the conversation |
| `Alt++` (or `Alt+=`) / `Alt+-` | Change PDF zoom in 25% steps (50–250%) |
| `Enter` | Ask about the visible section |
| `/model` | Open a searchable picker of authenticated vision models |
| `/model query` | Select a unique match, or open a filtered picker |
| `/thinking` | Open a picker of supported thinking levels |
| `/thinking level` | Change thinking level and save the pi-paper default |
| `/new "paper name"` | Open another paper and clear the conversation and agent context |
| `/clear` | Clear the conversation and agent context, including its saved history |
| `/help` | Show all commands and keybindings |
| `Escape` | Stop the current response |
| `Ctrl+C` | Stop a response, or quit |

## Model configuration

Pi credentials and provider definitions are shared. Until you choose a model or thinking level in pi-paper, the app inherits Pi's user-level defaults. Paper-specific choices are saved to `${XDG_CONFIG_HOME:-~/.config}/pi-paper/settings.json`; they never change Pi's coding defaults. Project `.pi/settings.json` is not used.

Use `/model` or `/thinking` to open a picker. Type to fuzzy-filter, use ↑/↓ to navigate, Enter to select, and Esc or Ctrl+C to cancel. The current choice is marked ✓. Short queries work: `/model 6.1-sol` selects a unique match; `/model sol` opens a filtered picker if several models match. Full `provider/model-id` values still work, as does `/thinking high`.

Use `/new "DeepSeek-v4.1"` to switch papers without leaving the app. It accepts the same names, arXiv links/IDs, and local PDFs as the CLI; quotes are optional. The new paper resumes its saved position and conversation, or starts at page 1 and 100% zoom with fresh agent context. Failed lookups or PDF loads leave the current paper and context intact. Successful switches update the last-paper history; model/thinking settings and the session's cumulative cost are preserved.

Selections save the pi-paper default, preserve the conversation, and take effect on the next question. Commands are available while idle, including after model startup fails.

The status bar shows model (without provider), thinking level, and estimated cost in USD. Use `/help` for commands and keybindings. Cost uses Pi's catalog pricing, includes SDK-accounted usage such as compaction, and accumulates until you exit—even across `/clear`. It is not a billing statement; subscription or unknown-price models may show zero.

Text-only models and Pi's `images.blockImages: true` setting produce explicit errors rather than silently omitting the PDF image. Conversations are saved per paper by pi-paper, not added to Pi's normal session history.

## Terminal notes

Agent replies render Markdown, aligned tables with wrapped cells, and supported LaTeX formulas as Unicode math (including stacked display fractions). Unsupported formulas remain visible as source text.

Run directly in foot with sixel support enabled. Use `Alt++` / `Alt+-` to zoom the paper: foot reserves `Ctrl++` / `Ctrl+-` for terminal font size, which changes the UI text but not the PDF. Ctrl shortcuts also work if your terminal passes them through.

Multiplexers must support and pass through sixel DCS sequences; if images do not appear, test outside the multiplexer first.
