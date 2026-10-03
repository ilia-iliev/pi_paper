import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WrappedInput } from "./selection.js";

export const ESC = "\x1b";
const color = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  cyan: `${ESC}[36m`,
  white: `${ESC}[97m`,
};

/** The selected panel is outlined in white; the divider always belongs to it. */
function border(selected: boolean): string {
  return selected ? color.white : color.dim;
}

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

function rightCell(d: Layout, text: string, selected: boolean): string {
  return `${color.white}│${color.reset} ${fit(text, d.rightInner - 1)}${border(selected)}│${color.reset}`;
}

function leftTop(d: Layout, title: string, selected: boolean): string {
  return `${border(selected)}┌${borderSection(title, d.leftInner)}`;
}

function rightTop(d: Layout, title: string, selected: boolean): string {
  return `${color.white}┬${border(selected)}${borderSection(title, d.rightInner)}┐${color.reset}`;
}

function leftBottom(d: Layout, selected: boolean): string {
  return `${border(selected)}└${"─".repeat(d.leftInner)}`;
}

function rightBottom(d: Layout, selected: boolean): string {
  return `${color.white}┴${border(selected)}${"─".repeat(d.rightInner)}┘${color.reset}`;
}

export function pdfTitle(d: Layout, title: string, zoom: number, page: number, pages: number): string {
  return `PDF · ${truncate(title, Math.max(4, d.leftInner - 28))} · ${zoom}% · ${page}/${pages}`;
}

/** Redraws the PDF panel's border without touching the image inside it. */
export function leftFrame(d: Layout, title: string, selected: boolean): string {
  let output = `${ESC}[?25l${ESC}[H${leftTop(d, title, selected)}`;
  for (let row = 0; row < d.contentRows; row++) output += `${ESC}[${row + 2};1H│`;
  return `${output}${ESC}[${d.mainHeight};1H${leftBottom(d, selected)}${color.reset}`;
}

export function fullFrame(d: Layout, leftTitle: string, rightTitle: string, right: string[], conversationSelected: boolean): string {
  const left = border(!conversationSelected);
  const output: string[] = [`${ESC}[?25l${ESC}[H`];
  output.push(leftTop(d, leftTitle, !conversationSelected) + rightTop(d, rightTitle, conversationSelected));
  for (let row = 0; row < d.contentRows; row++) {
    output.push(`\r\n${left}│${color.reset}${" ".repeat(d.leftInner)}${rightCell(d, right[row] ?? "", conversationSelected)}`);
  }
  output.push(`\r\n${leftBottom(d, !conversationSelected)}${rightBottom(d, conversationSelected)}`);
  return output.join("");
}

export function rightFrame(d: Layout, rightTitle: string, right: string[], selected: boolean): string {
  let output = `${ESC}[?25l`;
  output += `${ESC}[1;${d.leftWidth}H${rightTop(d, rightTitle, selected)}`;
  for (let row = 0; row < d.contentRows; row++) {
    output += `${ESC}[${row + 2};${d.leftWidth}H${rightCell(d, right[row] ?? "", selected)}`;
  }
  output += `${ESC}[${d.mainHeight};${d.leftWidth}H${rightBottom(d, selected)}`;
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
