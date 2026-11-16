export type GraphicsStyle = 'c64' | 'spectrum';

const normal = [
  [0, 0, 0], [0, 0, 205], [205, 0, 0], [205, 0, 205],
  [0, 205, 0], [0, 205, 205], [205, 205, 0], [205, 205, 205],
];
const bright = [
  [0, 0, 0], [0, 0, 255], [255, 0, 0], [255, 0, 255],
  [0, 255, 0], [0, 255, 255], [255, 255, 0], [255, 255, 255],
];
const palette = [normal, bright];

// Authentic Pepto/Colodore C64 VIC-II 16-color palette
const C64 = {
  BLACK:       [0, 0, 0],
  WHITE:       [246, 246, 240],
  RED:         [142, 59, 52],
  CYAN:        [116, 178, 190],
  PURPLE:      [134, 62, 146],
  GREEN:       [98, 168, 86],
  BLUE:        [62, 50, 156],
  YELLOW:      [218, 224, 128],
  ORANGE:      [146, 88, 46],
  BROWN:       [96, 62, 24],
  LIGHT_RED:   [174, 102, 90],
  DARK_GREY:   [74, 74, 74],
  MID_GREY:    [118, 118, 118],
  LIGHT_GREEN: [154, 214, 134],
  LIGHT_BLUE:  [118, 108, 214],
  LIGHT_GREY:  [176, 176, 170],
} as const;

function abgr(c: readonly [number, number, number]): number {
  return (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
}

function mapC64Playfield(isBright: number, col: number): readonly [readonly [number, number, number], readonly [number, number, number]] {
  switch (col) {
    case 0: return [C64.BLACK, C64.BLACK];
    case 1: return [C64.LIGHT_BLUE, C64.BLUE];
    case 2: return [C64.LIGHT_RED, C64.RED];
    case 3: return [C64.LIGHT_BLUE, C64.BLUE];
    case 4: return [C64.LIGHT_GREEN, C64.GREEN];
    case 5: return [C64.CYAN, C64.BLUE];
    case 6: return isBright ? [C64.YELLOW, C64.ORANGE] : [C64.LIGHT_BLUE, C64.BLUE];
    default: return isBright ? [C64.WHITE, C64.LIGHT_RED] : [C64.LIGHT_GREY, C64.DARK_GREY];
  }
}

function mapC64Hud(isBorder: number, col: number): readonly [number, number, number] {
  if (isBorder) {
    switch (col) {
      case 0: return C64.BLACK;
      case 1: return C64.BROWN;
      case 2: return C64.LIGHT_RED;
      case 3: return C64.RED;
      case 4: return C64.ORANGE;
      case 5: return C64.CYAN;
      case 6: return C64.LIGHT_RED;
      default: return C64.WHITE;
    }
  }
  switch (col) {
    case 0: return C64.BLACK;
    case 1: return C64.DARK_GREY;
    case 2: return C64.LIGHT_RED;
    case 3: return C64.PURPLE;
    case 4: return C64.LIGHT_GREEN;
    case 5: return C64.CYAN;
    case 6: return C64.YELLOW;
    default: return C64.WHITE;
  }
}

const pixelLookup = new Uint32Array(2 * 256 * 256 * 8);
const c64PlayfieldLookup = new Uint32Array(2 * 256 * 256 * 8);
const c64HudLookup = new Uint32Array(2 * 256 * 256 * 8);

for (let flash = 0; flash < 2; flash++) {
  for (let attr = 0; attr < 256; attr++) {
    const isBright = (attr >> 6) & 1;
    const colours = palette[isBright];
    const ink = attr & 7;
    const paper = (attr >> 3) & 7;
    const swap = flash && (attr & 0x80) !== 0;

    const [pfInkMain, pfInkShade] = mapC64Playfield(isBright, swap ? paper : ink);
    const [pfPaperMain] = mapC64Playfield(isBright, swap ? ink : paper);
    const pfInkMainPx = abgr(pfInkMain);
    const pfInkShadePx = abgr(pfInkShade);
    const pfPaperPx = abgr(pfPaperMain);

    const hudInkPx = abgr(mapC64Hud(flash, ink));
    const hudPaperPx = abgr(mapC64Hud(flash, paper));

    for (let bitmap = 0; bitmap < 256; bitmap++) {
      const base = (flash * 256 + attr) * 256 + bitmap;
      const pixelBase = base * 8;

      for (let bit = 0; bit < 8; bit++) {
        const set = ((bitmap >> (7 - bit)) & 1) !== 0;
        const colour = colours[set !== Boolean(swap) ? ink : paper];
        pixelLookup[pixelBase + bit] = (255 << 24) | (colour[2] << 16) | (colour[1] << 8) | colour[0];
        c64HudLookup[pixelBase + bit] = set ? hudInkPx : hudPaperPx;
      }

      // 2-bit horizontal pixel pairs give C64 160x200 multicolor shading on the playfield
      for (let pair = 0; pair < 4; pair++) {
        const b0 = (bitmap >> (7 - pair * 2)) & 1;
        const b1 = (bitmap >> (6 - pair * 2)) & 1;
        const bits = (b0 << 1) | b1;
        const px = bits === 0 ? pfPaperPx : bits === 3 ? pfInkMainPx : pfInkShadePx;
        c64PlayfieldLookup[pixelBase + pair * 2] = px;
        c64PlayfieldLookup[pixelBase + pair * 2 + 1] = px;
      }
    }
  }
}

const imageDataCache = new WeakMap<CanvasRenderingContext2D, ImageData>();
const hudImageDataCache = new WeakMap<CanvasRenderingContext2D, ImageData>();

export function spectrumScreenHasFlash(screen: Uint8Array) {
  for (let i = 0x1800; i < 0x1b00; i++) if (screen[i] & 0x80) return true;
  return false;
}

export function paintSpectrumRoom(
  target: CanvasRenderingContext2D,
  room: number,
  screen: Uint8Array,
  flashPhase: boolean,
  style: GraphicsStyle = 'c64',
) {
  let image = imageDataCache.get(target);
  if (!image) {
    image = target.createImageData(256, 144);
    imageDataCache.set(target, image);
  }
  const out = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 4);
  const table = style === 'c64' ? c64PlayfieldLookup : pixelLookup;
  let dest = 0;
  const flash = flashPhase ? 1 : 0;
  for (let y = 48; y < 192; y++) {
    const bitmapBase = ((y & 0xc0) << 5) | ((y & 0x38) << 2) | ((y & 7) << 8);
    const attrBase = 0x1800 + ((y >> 3) << 5);
    for (let byteX = 0; byteX < 32; byteX++) {
      const bitmap = screen[bitmapBase + byteX];
      const attr = screen[attrBase + byteX];
      const lookup = ((flash * 256 + attr) * 256 + bitmap) * 8;
      for (let bit = 0; bit < 8; bit++) out[dest + bit] = table[lookup + bit];
      dest += 8;
    }
  }
  target.putImageData(image, (room % 16) * 256, Math.floor(room / 16) * 144);
}

export function paintSpectrumHud(
  target: CanvasRenderingContext2D,
  screen: Uint8Array,
  style: GraphicsStyle = 'c64',
) {
  let image = hudImageDataCache.get(target);
  if (!image) {
    image = target.createImageData(256, 48);
    hudImageDataCache.set(target, image);
  }
  const out = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 4);
  let dest = 0;
  for (let y = 0; y < 48; y++) {
    const bitmapBase = ((y & 0xc0) << 5) | ((y & 0x38) << 2) | ((y & 7) << 8);
    const attrBase = 0x1800 + ((y >> 3) << 5);
    const rowBorder = y < 8 || y >= 40;
    for (let byteX = 0; byteX < 32; byteX++) {
      const bitmap = screen[bitmapBase + byteX];
      const attr = screen[attrBase + byteX];
      if (style === 'c64') {
        const isBorder = rowBorder || byteX < 2 || byteX >= 30 ? 1 : 0;
        const pixelBase = ((isBorder * 256 + attr) * 256 + bitmap) * 8;
        for (let bit = 0; bit < 8; bit++) out[dest + bit] = c64HudLookup[pixelBase + bit];
      } else {
        const lookup = (((attr >> 6) & 1) * 256 + attr) * 256 + bitmap;
        const pixelBase = lookup * 8;
        for (let bit = 0; bit < 8; bit++) out[dest + bit] = pixelLookup[pixelBase + bit];
      }
      dest += 8;
    }
  }
  target.putImageData(image, 0, 0);
}

export const MAP_WIDTH = 16 * 256;
export const MAP_HEIGHT = 32 * 144;
