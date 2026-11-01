const normal = [
  [0, 0, 0], [0, 0, 205], [205, 0, 0], [205, 0, 205],
  [0, 205, 0], [0, 205, 205], [205, 205, 0], [205, 205, 205],
];
const bright = [
  [0, 0, 0], [0, 0, 255], [255, 0, 0], [255, 0, 255],
  [0, 255, 0], [0, 255, 255], [255, 255, 0], [255, 255, 255],
];

export function paintSpectrumRoom(
  target: CanvasRenderingContext2D,
  room: number,
  screen: Uint8Array,
  flashPhase: boolean,
) {
  const image = target.createImageData(256, 144);
  const out = image.data;
  for (let y = 48; y < 192; y++) {
    const bitmapBase = ((y & 0xc0) << 5) | ((y & 0x38) << 2) | ((y & 7) << 8);
    const attrBase = 0x1800 + ((y >> 3) << 5);
    const destY = y - 48;
    for (let x = 0; x < 256; x++) {
      const byte = screen[bitmapBase + (x >> 3)];
      const bit = (byte >> (7 - (x & 7))) & 1;
      const attr = screen[attrBase + (x >> 3)];
      const ink = attr & 7;
      const paper = (attr >> 3) & 7;
      const isFlash = (attr & 0x80) !== 0 && flashPhase;
      const colourIndex = (bit ^ (isFlash ? 1 : 0)) ? ink : paper;
      const palette = (attr & 0x40) ? bright : normal;
      const colour = palette[colourIndex];
      const i = (destY * 256 + x) * 4;
      out[i] = colour[0];
      out[i + 1] = colour[1];
      out[i + 2] = colour[2];
      out[i + 3] = 255;
    }
  }
  target.putImageData(image, (room % 16) * 256, Math.floor(room / 16) * 144);
}

export const MAP_WIDTH = 16 * 256;
export const MAP_HEIGHT = 32 * 144;
