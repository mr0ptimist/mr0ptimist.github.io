// node scripts/test-export-texture.js
// export-texture.js 的编码器单测：验证 TGA 18 字节头 + BGRA 像素序 + bottom-up 行序
const assert = require('assert');
const { encodeTGA } = require('../static/js/export-texture.js');

// ── 32bit，2×2 ──
// 源像素 top-down RGBA：
//   row0: 红 (255,0,0,255)   绿 (0,255,0,255)
//   row1: 蓝 (0,0,255,255)   白 (255,255,255,255)
const px2 = new Uint8Array([
  255,0,0,255,  0,255,0,255,
  0,0,255,255,  255,255,255,255
]);
const t32 = encodeTGA(px2, 2, 2, 32);
// 头 18 字节：type=2、宽 2 LE、高 2 LE、bpp 32、descriptor 0x08
const head32 = [0,0,2, 0,0,0,0,0, 0,0,0,0, 2,0, 2,0, 32, 8];
// 像素区（bottom-up：先 y=1 行；BGRA）：
//   蓝 → B=255,G=0,R=0,A=255 → [255,0,0,255]
//   白 → [255,255,255,255]
//   红 → B=0,G=0,R=255,A=255 → [0,0,255,255]
//   绿 → B=0,G=255,R=0,A=255 → [0,255,0,255]
const px32 = [
  255,0,0,255,  255,255,255,255,
  0,0,255,255,  0,255,0,255
];
assert.strictEqual(t32.length, 18 + 2 * 2 * 4, '32bit 总长度');
assert.deepStrictEqual([...t32.slice(0, 18)], head32, '32bit 头');
assert.deepStrictEqual([...t32.slice(18)], px32, '32bit 像素区');

// ── 24bit，3×1 ──
// 单行（无行序翻转影响），RGBA：红 | 绿 | 蓝
const px3 = new Uint8Array([
  255,0,0,255,  0,255,0,255,  0,0,255,255
]);
const t24 = encodeTGA(px3, 3, 1, 24);
const head24 = [0,0,2, 0,0,0,0,0, 0,0,0,0, 3,0, 1,0, 24, 0];
// BGRA 每像素 3 字节：红 → [0,0,255]；绿 → [0,255,0]；蓝 → [255,0,0]
const px24 = [0,0,255,  0,255,0,  255,0,0];
assert.strictEqual(t24.length, 18 + 3 * 1 * 3, '24bit 总长度');
assert.deepStrictEqual([...t24.slice(0, 18)], head24, '24bit 头');
assert.deepStrictEqual([...t24.slice(18)], px24, '24bit 像素区');

// 非法 bpp 应钳到 24
assert.strictEqual(encodeTGA(px3, 3, 1, 16).length, 18 + 9, '非法 bpp 钳 24bit');

console.log('export-texture tests passed');
