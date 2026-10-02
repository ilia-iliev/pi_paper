import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WrappedInput } from "./selection.js";

export const ESC = "\x1b";
const color = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  cyan: `${ESC}[36m`,
};

interface Layout {
  columns: number;
  mainHeight: number;
  leftWidth: number;
  leftInner: number;
  rightInner: number;
  contentRows: number;
}

export function layout(columns: number, rows: number, promptRows: number): Layout {
  const mainHeight = rows - 2 - promptRows;
  const leftWidth = Math.floor(columns * 0.64);
  return {
    columns,
    mainHeight,
    leftWidth,
    leftInner: leftWidth - 2,
    rightInner: columns - leftWidth - 1,
    contentRows: mainHeight - 2,
  };
}

function truncate(text: string, width: number): string {
  const characters = [...text];
  if (characters.length <= width) return text;
  if (width <= 1) return characters.slice(0, width).join("");
  return `${characters.slice(0, width - 1).join("")}…`;
}

function borderSection(title: string, width: number): string {
  if (width < 3) return "─".repeat(Math.max(0, width));
  const label = ` ${truncate(title, width - 2)} `;
  return label + "─".repeat(Math.max(0, width - [...label].length));
}

/** Pads `text` to `width`; truncateToWidth is ~50x slower than measuring, so only overlong lines pay for it. */
function fit(text: string, width: number): string {
  const visible = visibleWidth(text);
  return visible > width ? truncateToWidth(text, width, "", true) : text + " ".repeat(width - visible);
}

function rightCell(d: Layout, text: string): string {
  return `${color.dim}│${color.reset} ${fit(text, d.rightInner - 1)}${color.dim}│${color.reset}`;
}

export function pdfTitle(d: Layout, title: string, zoom: number, page: number, pages: number): string {
  return `PDF · ${truncate(title, Math.max(4, d.leftInner - 28))} · ${zoom}% · ${page}/${pages}`;
}

export function leftTitleFrame(d: Layout, title: string): string {
  return `${ESC}[?25l${ESC}[H${color.dim}┌${borderSection(title, d.leftInner)}${color.reset}`;
}

export function fullFrame(d: Layout, leftTitle: string, rightTitle: string, right: string[]): string {
  const output: string[] = [`${ESC}[?25l${ESC}[H`];
  output.push(`${color.dim}┌${borderSection(leftTitle, d.leftInner)}┬${borderSection(rightTitle, d.rightInner)}┐${color.reset}`);
  for (let row = 0; row < d.contentRows; row++) {
    output.push(`\r\n${color.dim}│${" ".repeat(d.leftInner)}${rightCell(d, right[row] ?? "")}`);
  }
  output.push(`\r\n${color.dim}└${"─".repeat(d.leftInner)}┴${"─".repeat(d.rightInner)}┘${color.reset}`);
  return output.join("");
}

export function rightFrame(d: Layout, rightTitle: string, right: string[]): string {
  let output = `${ESC}[?25l`;
  output += `${ESC}[1;${d.leftWidth}H${color.dim}┬${borderSection(rightTitle, d.rightInner)}┐${color.reset}`;
  for (let row = 0; row < d.contentRows; row++) {
    output += `${ESC}[${row + 2};${d.leftWidth}H${rightCell(d, right[row] ?? "")}`;
  }
  output += `${ESC}[${d.mainHeight};${d.leftWidth}H${color.dim}┴${"─".repeat(d.rightInner)}┘${color.reset}`;
  return output;
}

export function promptFrame(d: Layout, summary: string, input: WrappedInput): string {
  const title = truncate(summary, Math.max(5, d.columns - 6));
  const width = d.columns - 5;
  let output = `${ESC}[${d.mainHeight + 1};1H${color.dim}┌${borderSection(title, d.columns - 2)}┐${color.reset}`;
  input.lines.forEach((line, row) => {
    const marker = row === 0 ? `${color.cyan}>${color.reset}` : " ";
    const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
    output += `${ESC}[${d.mainHeight + 2 + row};1H${color.dim}│${color.reset} ${marker} ${line}${padding}${color.dim}│${color.reset}`;
  });
  output += `${ESC}[${d.mainHeight + 2 + input.lines.length};1H${color.dim}└${"─".repeat(d.columns - 2)}┘${color.reset}`;
  output += `${ESC}[${d.mainHeight + 2 + input.row};${5 + input.col}H${ESC}[?25h`;
  return output;
}
