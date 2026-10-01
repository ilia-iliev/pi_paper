export function truncate(text: string, width: number): string {
  const characters = [...text];
  if (characters.length <= width) return text;
  if (width <= 1) return characters.slice(0, width).join("");
  return `${characters.slice(0, width - 1).join("")}…`;
}

export function pad(text: string, width: number): string {
  const clipped = truncate(text, width);
  return clipped + " ".repeat(Math.max(0, width - [...clipped].length));
}

export function wrapText(text: string, width: number): string[] {
  if (width < 1) return [];
  const result: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    if (!paragraph) {
      result.push("");
      continue;
    }
    let remaining = paragraph;
    while ([...remaining].length > width) {
      const characters = [...remaining];
      let split = characters.slice(0, width + 1).lastIndexOf(" ");
      if (split < Math.floor(width / 3)) split = width;
      result.push(characters.slice(0, split).join("").trimEnd());
      remaining = characters.slice(split).join("").trimStart();
    }
    result.push(remaining);
  }
  return result;
}
