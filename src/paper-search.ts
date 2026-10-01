import { XMLParser, XMLValidator } from "fast-xml-parser";

interface SearchResult {
  title: string;
  url: string;
}

const STOP_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "is", "of", "on", "or", "the", "to", "with", "you"]);

function tokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase()
    .replace(/(\p{L})([vr])(?=\d)/gu, "$1 $2")
    .match(/[\p{L}]+|\d+(?:\.\d+)*/gu) ?? [];
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  // Model versions and short words must match exactly.
  if (/\d/.test(left + right) || Math.min(left.length, right.length) < 3) return 0;
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(left[i - 1] !== right[j - 1]));
    }
    row = next;
  }
  return 1 - row[right.length] / Math.max(left.length, right.length);
}

function titleScore(query: string[], title: string): number {
  const words = tokens(title);
  if (!words.length) return 0;
  const matches = query.map((word) => Math.max(...words.map((candidate) => similarity(word, candidate))));
  if (matches.some((match) => match < 0.7)) return 0;
  const coverage = matches.reduce((sum, match) => sum + match, 0) / matches.length;
  if (coverage < 0.85) return 0;
  const compact = words.join("");
  const phrase = query.join("");
  return coverage + Number(compact.includes(phrase)) * 0.2 + Number(compact.startsWith(phrase)) * 0.1;
}

function parseResults(xml: string): SearchResult[] {
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid arXiv search response");
  const data = new XMLParser({ parseTagValue: false, htmlEntities: true, isArray: (name) => name === "entry" }).parse(xml);
  if (data.feed === "") return [];
  if (!data.feed || typeof data.feed !== "object") throw new Error("Invalid arXiv search response");
  return (data.feed.entry ?? []).map((entry: { id?: unknown; title?: unknown }) => {
    if (typeof entry.id !== "string" || typeof entry.title !== "string") {
      throw new Error("Invalid arXiv search response");
    }
    return { title: entry.title.replace(/\s+/g, " ").trim(), url: entry.id };
  });
}

export async function searchArxiv(input: string): Promise<SearchResult> {
  const query = tokens(input);
  const terms = [...new Set(query.filter((word) => word.length > 1 && !STOP_WORDS.has(word) && !/^\d/.test(word)))];
  if (!terms.length) throw new Error("Enter a paper name with at least one searchable word");
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", terms.map((word) => `ti:"${word}"`).join(" OR "));
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "50");
  url.searchParams.set("sortBy", "relevance");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { "user-agent": "pi-paper/0.1" },
  });
  if (!response.ok) throw new Error(`arXiv search failed (HTTP ${response.status})`);
  const ranked = parseResults(await response.text())
    .map((paper) => ({ paper, score: titleScore(query, paper.title) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.paper.title.length - b.paper.title.length);
  if (!ranked.length) {
    throw new Error(`No confident arXiv title match for "${input}". Try a fuller title or provide an arXiv link or ID.`);
  }
  return ranked[0].paper;
}
