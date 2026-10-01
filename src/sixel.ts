import type { Raster } from "./ppm.js";

const LEVEL = Uint8Array.from({ length: 256 }, (_, value) => Math.min(3, Math.round(value / 85)));
const SIXELS = Array.from({ length: 64 }, (_, mask) => String.fromCharCode(mask + 63));

function encodeRun(mask: number, count: number): string {
  return count >= 4 ? `!${count}${SIXELS[mask]}` : SIXELS[mask]!.repeat(count);
}

function encodeMasks(masks: Uint8Array, start: number, last: number): string {
  let result = "";
  let previous = masks[start]!;
  let count = 1;
  for (let x = start + 1; x <= last; x++) {
    const value = masks[x]!;
    if (value === previous) count++;
    else {
      result += encodeRun(previous, count);
      previous = value;
      count = 1;
    }
  }
  return result + encodeRun(previous, count);
}

function quantize({ width, height, rgb }: Raster): { indexed: Uint8Array; colors: number[] } {
  const indexed = new Uint8Array(width * height);
  const seen = new Uint8Array(64);
  const colors: number[] = [];
  for (let pixel = 0, source = 0; pixel < indexed.length; pixel++, source += 3) {
    const index = LEVEL[rgb[source]!]! * 16 + LEVEL[rgb[source + 1]!]! * 4 + LEVEL[rgb[source + 2]!]!;
    indexed[pixel] = index;
    if (!seen[index]) {
      seen[index] = 1;
      colors.push(index);
    }
  }
  return { indexed, colors };
}

/** Encode RGB pixels using a compact 64-color sixel palette. */
export function encodeSixel(raster: Raster): string {
  const { width, height } = raster;
  const { indexed, colors } = quantize(raster);
  let output = `\x1bP0;1;0q"1;1;${width};${height}`;
  for (const color of [...colors].sort((a, b) => a - b)) {
    const red = Math.floor(color / 16);
    const green = Math.floor((color % 16) / 4);
    const blue = color % 4;
    output += `#${color};2;${Math.round(red * 100 / 3)};${Math.round(green * 100 / 3)};${Math.round(blue * 100 / 3)}`;
  }

  // One pass per band fills a mask row for every color, instead of one pass per color.
  const masks = new Uint8Array(64 * width);
  const last = new Int32Array(64);
  for (let top = 0; top < height; top += 6) {
    last.fill(-1);
    const rows = Math.min(6, height - top);
    for (let bit = 0; bit < rows; bit++) {
      const row = (top + bit) * width;
      for (let x = 0; x < width; x++) {
        const color = indexed[row + x]!;
        masks[color * width + x]! |= 1 << bit;
        if (x > last[color]!) last[color] = x;
      }
    }
    let firstColor = true;
    for (const color of colors) {
      if (last[color]! < 0) continue;
      if (!firstColor) output += "$";
      firstColor = false;
      const start = color * width;
      output += `#${color}${encodeMasks(masks, start, start + last[color]!)}`;
      masks.fill(0, start, start + width);
    }
    if (top + 6 < height) output += "-";
  }
  return output + "\x1b\\";
}
