import { Markdown, type MarkdownTheme, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ESC } from "./frame.js";

export interface ConversationMessage {
  role: "You" | "Agent" | "App";
  text: string;
}

const plain = (text: string) => text;
const style = (open: number, close: number) => (text: string) => `${ESC}[${open}m${text}${ESC}[${close}m`;
const markdownTheme: MarkdownTheme = {
  heading: style(1, 22),
  link: style(36, 39),
  linkUrl: style(2, 22),
  code: style(36, 39),
  codeBlock: plain,
  codeBlockBorder: style(2, 22),
  quote: plain,
  quoteBorder: style(2, 22),
  hr: style(2, 22),
  listBullet: plain,
  bold: style(1, 22),
  italic: style(3, 23),
  strikethrough: style(9, 29),
  underline: style(4, 24),
};

/** Renders agent replies as Markdown, caching one renderer per message while it streams. */
export class ConversationRenderer {
  private readonly markdown = new WeakMap<ConversationMessage, { text: string; renderer: Markdown }>();

  lines(messages: ConversationMessage[], width: number): string[] {
    return messages.flatMap((message) => [`${message.role}:`, ...this.messageLines(message, width), ""]);
  }

  private messageLines(message: ConversationMessage, width: number): string[] {
    const text = message.text || (message.role === "Agent" ? "…" : "");
    if (message.role !== "Agent") return wrapTextWithAnsi(text, width);
    let cached = this.markdown.get(message);
    if (!cached) {
      cached = { text, renderer: new Markdown(text, 0, 0, markdownTheme) };
      this.markdown.set(message, cached);
    } else if (cached.text !== text) {
      cached.renderer.setText(text);
      cached.text = text;
    }
    return cached.renderer.render(width);
  }
}
