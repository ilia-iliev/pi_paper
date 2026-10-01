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
