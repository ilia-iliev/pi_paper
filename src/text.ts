export function truncate(text: string, width: number): string {
  const characters = [...text];
  if (characters.length <= width) return text;
  if (width <= 1) return characters.slice(0, width).join("");
  return `${characters.slice(0, width - 1).join("")}…`;
}
