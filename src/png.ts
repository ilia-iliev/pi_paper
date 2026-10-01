import { crc32, deflateSync } from "node:zlib";
import type { Raster } from "./ppm.js";

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.allocUnsafe(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(data, crc32(name)), data.length + 8);
  return result;
}

export function encodePng({ width, height, rgb }: Raster): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("Invalid RGB buffer size");
  const rows = Buffer.allocUnsafe(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    rows[rowStart] = 0;
    rgb.copy(rows, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
