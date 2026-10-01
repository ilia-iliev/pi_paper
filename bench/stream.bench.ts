import { performance } from "node:perf_hooks";
import { ConversationRenderer, type ConversationMessage } from "../src/conversation.js";
import { layout, rightFrame } from "../src/frame.js";

const paragraph = "The **attention** function maps a query and key-value pairs to an output, $\\text{softmax}(QK^T/\\sqrt{d_k})V$, where `d_k` is the key dimension. ";
const reply = Array.from({ length: 12 }, (_, i) => `### Step ${i}\n\n${paragraph.repeat(3)}\n\n| a | b |\n|---|---|\n| ${i} | x |\n`).join("\n");
const tokens = reply.match(/.{1,4}/gs)!;
const d = layout(200, 60, 1);
const renderer = new ConversationRenderer();
const messages: ConversationMessage[] = [{ role: "You", text: "Explain" }, { role: "Agent", text: "" }];
const start = performance.now();
for (const token of tokens) {
  messages[1]!.text += token;
  const lines = renderer.lines(messages, d.rightInner - 2);
  rightFrame(d, "Conversation", lines.slice(-d.contentRows));
}
const total = performance.now() - start;
console.log(`${tokens.length} deltas, ${reply.length} chars: ${total.toFixed(0)} ms total, ${(total / tokens.length).toFixed(2)} ms/delta, last ${(() => { const s = performance.now(); renderer.lines(messages, d.rightInner - 2); messages[1]!.text += "x"; renderer.lines(messages, d.rightInner - 2); return (performance.now() - s).toFixed(1); })()} ms`);
