const normal = [
  [0, 0, 0], [0, 0, 205], [205, 0, 0], [205, 0, 205],
  [0, 205, 0], [0, 205, 205], [205, 205, 0], [205, 205, 205],
];
const bright = [
  [0, 0, 0], [0, 0, 255], [255, 0, 0], [255, 0, 255],
  [0, 255, 0], [0, 255, 255], [255, 255, 0], [255, 255, 255],
];

const palette = [normal, bright];
const pixelLookup = new Uint32Array(2 * 256 * 256 * 8);
for (let flash = 0; flash < 2; flash++) {
  for (let attr = 0; attr < 256; attr++) {
    const colours = palette[(attr >> 6) & 1];
    const ink = attr & 7;
    const paper = (attr >> 3) & 7;
    const swap = flash && (attr & 0x80) !== 0;
    for (let bitmap = 0; bitmap < 256; bitmap++) {
      const base = (((flash * 256 + attr) * 256 + bitmap) * 8);
      for (let bit = 0; bit < 8; bit++) {
        const set = ((bitmap >> (7 - bit)) & 1) !== 0;
        const colour = colours[(set !== Boolean(swap)) ? ink : paper];
        pixelLookup[base + bit] = (255 << 24) | (colour[2] << 16) | (colour[1] << 8) | colour[0];
      }
    }
  }
}

const imageDataCache = new WeakMap<CanvasRenderingContext2D, ImageData>();

export function spectrumScreenHasFlash(screen: Uint8Array) {
  for (let i = 0x1800; i < 0x1b00; i++) if (screen[i] & 0x80) return true;
  return false;
}

export function paintSpectrumRoom(
  target: CanvasRenderingContext2D,
  room: number,
  screen: Uint8Array,
  flashPhase: boolean,
) {
  let image = imageDataCache.get(target);
  if (!image) {
    image = target.createImageData(256, 144);
    imageDataCache.set(target, image);
  }
  const out = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 4);
  let dest = 0;
  const flash = flashPhase ? 1 : 0;
  const roomBase = (((room / 16) | 0) * 144) * MAP_WIDTH + (room % 16) * 256;
  for (let y = 48; y < 192; y++) {
    const bitmapBase = ((y & 0xc0) << 5) | ((y & 0x38) << 2) | ((y & 7) << 8);
    const attrBase = 0x1800 + ((y >> 3) << 5);
    const rowBase = roomBase + (y - 48) * MAP_WIDTH;
    for (let byteX = 0; byteX < 32; byteX++) {
      const bitmap = screen[bitmapBase + byteX];
      const attr = screen[attrBase + byteX];
      const lookup = (((flash * 256 + attr) * 256 + bitmap) * 8);
      const x = rowBase + byteX * 8;
      for (let bit = 0; bit < 8; bit++) out[dest + bit] = pixelLookup[lookup + bit];
      dest += 8;
    }
  }
  target.putImageData(image, (room % 16) * 256, Math.floor(room / 16) * 144);
}

export const MAP_WIDTH = 16 * 256;
export const MAP_HEIGHT = 32 * 144;
