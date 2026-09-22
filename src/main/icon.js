'use strict';

/**
 * Programmatic PNG generation for the tray icon (a small rounded gauge on a
 * transparent background). Encoding a PNG from raw RGBA pixels with zlib
 * keeps the repo free of binary assets and makes the icon deterministic.
 */
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode raw RGBA pixels (w*h*4) into a PNG buffer. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** Draw the tray icon: a circular gauge, filled by `fill` (0..1). */
function drawGauge(size, fill, { ring = [200, 200, 205], bar = [70, 130, 240], alpha = 255 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.42;
  const cx = size / 2;
  const cy = size / 2;
  const thickness = Math.max(2, Math.round(size * 0.14));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      if (dist < r - thickness * 0.2 || dist > r + thickness * 0.2) continue;
      // angle from top, clockwise
      let ang = Math.atan2(dx, -dy);
      if (ang < 0) ang += 2 * Math.PI;
      const inBar = ang <= 2 * Math.PI * Math.max(0, Math.min(1, fill));
      const color = inBar ? bar : ring;
      px[idx] = color[0];
      px[idx + 1] = color[1];
      px[idx + 2] = color[2];
      px[idx + 3] = alpha;
    }
  }
  return encodePng(size, size, px);
}

module.exports = { encodePng, drawGauge, crc32 };
