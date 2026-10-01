export interface Raster {
  width: number;
  height: number;
  rgb: Buffer;
}

export function parsePpm(data: Buffer): Raster {
  let offset = 0;
  const token = (): string => {
    while (offset < data.length) {
      if (data[offset] === 35) {
        while (offset < data.length && data[offset] !== 10) offset++;
      } else if (data[offset]! <= 32) offset++;
      else break;
    }
    const start = offset;
    while (offset < data.length && data[offset]! > 32 && data[offset] !== 35) offset++;
    return data.toString("ascii", start, offset);
  };

  if (token() !== "P6") throw new Error("pdftoppm returned an unsupported image");
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || max !== 255) {
    throw new Error("pdftoppm returned an invalid PPM image");
  }
  if (data[offset]! <= 32) offset++;
  const rgb = data.subarray(offset);
  if (rgb.length < width * height * 3) throw new Error("pdftoppm returned a truncated image");
  return { width, height, rgb: rgb.subarray(0, width * height * 3) };
}

function encodeRun(character: string, count: number): string {
  return count >= 4 ? `!${count}${character}` : character.repeat(count);
}

function encodeMasks(masks: Uint8Array, last: number): string {
  let result = "";
  let previous = masks[0]!;
  let count = 1;
  for (let x = 1; x <= last; x++) {
    const value = masks[x]!;
    if (value === previous) count++;
    else {
      result += encodeRun(String.fromCharCode(previous + 63), count);
      previous = value;
      count = 1;
    }
  }
  return result + encodeRun(String.fromCharCode(previous + 63), count);
}

/** Encode RGB pixels using a compact 64-color sixel palette. */
export function encodeSixel(raster: Raster): string {
  const { width, height, rgb } = raster;
  const indexed = new Uint8Array(width * height);
  const colors = new Set<number>();
  for (let pixel = 0, source = 0; pixel < indexed.length; pixel++, source += 3) {
    const red = Math.min(3, Math.round(rgb[source]! / 85));
    const green = Math.min(3, Math.round(rgb[source + 1]! / 85));
    const blue = Math.min(3, Math.round(rgb[source + 2]! / 85));
    const index = red * 16 + green * 4 + blue;
    indexed[pixel] = index;
    colors.add(index);
  }

  let output = `\x1bP0;1;0q"1;1;${width};${height}`;
  for (const color of [...colors].sort((a, b) => a - b)) {
    const red = Math.floor(color / 16);
    const green = Math.floor((color % 16) / 4);
    const blue = color % 4;
    output += `#${color};2;${Math.round(red * 100 / 3)};${Math.round(green * 100 / 3)};${Math.round(blue * 100 / 3)}`;
  }

  const masks = new Uint8Array(width);
  for (let top = 0; top < height; top += 6) {
    let firstColor = true;
    for (const color of colors) {
      masks.fill(0);
      let last = -1;
      for (let x = 0; x < width; x++) {
        let mask = 0;
        for (let bit = 0; bit < 6 && top + bit < height; bit++) {
          if (indexed[(top + bit) * width + x] === color) mask |= 1 << bit;
        }
        masks[x] = mask;
        if (mask) last = x;
      }
      if (last < 0) continue;
      if (!firstColor) output += "$";
      firstColor = false;
      output += `#${color}${encodeMasks(masks, last)}`;
    }
    if (top + 6 < height) output += "-";
  }
  return output + "\x1b\\";
}
