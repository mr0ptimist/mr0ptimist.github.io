#!/usr/bin/env node
'use strict';
/*
 * scripts/test-exr-codec.js — OpenEXR 解析器回归套件（无外部图片、无镜像解码器）
 *
 * 被测对象：static/js/exr-parser.js 的公开接口 EXR.parse(buf) / EXR.toRGBA8(exr)
 * 期望来源：OpenEXR File Layout 规范
 *           https://openexr.com/en/latest/OpenEXRFileLayout.html
 *           - magic 76 2F 31 01；version 低 8 位 = 2；bit9 tile / bit11 deep / bit12 multipart
 *           - header = (name\0 type\0 size:int32 value)* + 单个 0x00 终止
 *           - 属性：channels/chlist, compression/compression, dataWindow/box2i 等
 *           - chlist 项 = name\0 + pixelType:int32 + pLinear:u8 + 3B reserved + xSampling:int32 + ySampling:int32
 *           - pixelType 0=UINT(4B) 1=HALF(2B) 2=FLOAT(4B)
 *           - 扫描行文件在 header 之后是 offset table：每个 chunk 一个 uint64 偏移（相对文件起点）
 *           - chunk = y:int32 + dataSize:int32 + pixel data（NO_COMPRESSION 时每 chunk 恰 1 行）
 *           - 行内数据按 chlist 顺序逐通道排列，每通道 w 个样本
 * 夹具全部由本文件的构建器按上述布局手工拼字节，不使用任何外部素材，
 * 也不复用被测解析逻辑；期望值为规范推导值或夹具写入值。
 *
 * 用法：node scripts/test-exr-codec.js [--only=子串] [--skip=子串]
 * 退出码：0 = 全绿；1 = 有失败（或抛错）
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'static', 'js');

// ---------------------------------------------------------------- 加载被测模块
function loadExr() {
  const sandbox = { console: console };
  sandbox.self = sandbox;   // worker-shared.js 结尾 self.ImageCodecShared = S
  sandbox.window = sandbox; // exr-parser.js 注释声明 window.EXR
  vm.createContext(sandbox);
  for (const f of ['worker-shared.js', 'exr-parser.js']) {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  }
  if (!sandbox.EXR || typeof sandbox.EXR.parse !== 'function') throw new Error('EXR.parse 未暴露');
  if (typeof sandbox.EXR.toRGBA8 !== 'function') throw new Error('EXR.toRGBA8 未暴露');
  return sandbox.EXR;
}

const P = loadExr();

function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function srcHash(f) { return sha256(fs.readFileSync(path.join(JS_DIR, f))); }

// ---------------------------------------------------------------- 夹具构建器
const FIXTURES = new Map(); // name -> {sha256, len}

function f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; }
function i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0, 0); return b; }
function strz(s) { return Buffer.from(s + '\0', 'latin1'); }
function box2i(dw) { return Buffer.concat([i32(dw[0]), i32(dw[1]), i32(dw[2]), i32(dw[3])]); }

function f2h(v) { // float32 -> half16 bits（夹具写入用，测试值均为 2 的幂或简单分数）
  if (v === 0) return 0;
  const a = new Float32Array(1); a[0] = v;
  const x = new Uint32Array(a.buffer)[0];
  const sign = (x >>> 31) & 1, exp = (x >>> 23) & 0xff, man = x & 0x7fffff;
  if (exp === 0xff) return (sign << 15) | (man ? 0x7e00 : 0x7c00);
  let e = exp - 127 + 15;
  if (e >= 31) return (sign << 15) | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign << 15;
    return (sign << 15) | ((man | 0x800000) >> (14 - e + 13 - 13 + (1 - e)));
  }
  return (sign << 15) | (e << 10) | (man >> 13);
}

function chlistBytes(channels) {
  const parts = [];
  for (const c of channels) {
    const b = Buffer.alloc(16); // pixelType(4) pLinear(1) reserved(3) xSampling(4) ySampling(4)
    b.writeInt32LE(c.type, 0);
    b[4] = c.pLinear || 0;
    b.writeInt32LE(c.xSampling === undefined ? 1 : c.xSampling, 8);
    b.writeInt32LE(c.ySampling === undefined ? 1 : c.ySampling, 12);
    parts.push(strz(c.name), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function attr(name, type, value) {
  return Buffer.concat([strz(name), strz(type), i32(value.length), value]);
}

function packRow(channels, perChannel) { // perChannel[chIndex][x] = 数值
  const parts = [];
  for (let c = 0; c < channels.length; c++) {
    const t = channels[c].type, vals = perChannel[c];
    const b = Buffer.alloc(vals.length * (t === 1 ? 2 : 4));
    for (let x = 0; x < vals.length; x++) {
      if (t === 0) b.writeUInt32LE(vals[x] >>> 0, x * 4);
      else if (t === 1) b.writeUInt16LE(f2h(vals[x]), x * 2);
      else b.writeFloatLE(vals[x], x * 4);
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/*
 * buildExr(o) -> {buf, headerEnd, tableStart, tableEnd, chunkStart, w, h, rows}
 *   o.channels    [{name, type, xSampling?, ySampling?}]
 *   o.dataWindow  [xmin,ymin,xmax,ymax]
 *   o.rowBytes(y) -> Buffer（该行像素数据，长度须 = w * sum(bpp)）
 *   o.physicalOrder [y...] 物理落盘顺序（默认 y 递增）
 *   o.tableOrder    [y...] offset table 条目顺序（默认 y 递增）
 *   o.offsetFor(i,y,off) -> number 覆写 table 条目
 *   o.chunkYOverride(y) / o.chunkSizeOverride(y,size)
 *   o.chlistRaw / o.omitHeaderAttr(name) / o.extraAttrs([...])
 *   o.omitOffsetTable / o.truncate(n) / o.append(buf)
 */
function buildExr(o) {
  const channels = o.channels;
  const dw = o.dataWindow;
  const w = dw[2] - dw[0] + 1, h = dw[3] - dw[1] + 1;
  const bpp = channels.reduce((s, c) => s + (c.type === 1 ? 2 : 4), 0);
  const rowLen = w * bpp;

  const omit = o.omitHeaderAttr || [];
  const attrs = [];
  if (omit.indexOf('channels') < 0) attrs.push(attr('channels', 'chlist', o.chlistRaw !== undefined ? o.chlistRaw : chlistBytes(channels)));
  if (omit.indexOf('compression') < 0) attrs.push(attr('compression', 'compression', Buffer.from([o.compression === undefined ? 0 : (o.compression & 0xff)])));
  if (omit.indexOf('dataWindow') < 0) attrs.push(attr('dataWindow', 'box2i', box2i(o.dataWindowRaw || dw)));
  if (omit.indexOf('displayWindow') < 0) attrs.push(attr('displayWindow', 'box2i', box2i(o.displayWindow || dw)));
  if (omit.indexOf('lineOrder') < 0) attrs.push(attr('lineOrder', 'lineOrder', Buffer.from([o.lineOrder || 0])));
  if (omit.indexOf('pixelAspectRatio') < 0) attrs.push(attr('pixelAspectRatio', 'float', f32(1)));
  if (omit.indexOf('screenWindowCenter') < 0) attrs.push(attr('screenWindowCenter', 'v2f', Buffer.concat([f32(0), f32(0)])));
  if (omit.indexOf('screenWindowWidth') < 0) attrs.push(attr('screenWindowWidth', 'float', f32(1)));
  if (o.typeAttr) attrs.push(attr('type', 'string', strz(o.typeAttr)));
  if (o.extraAttrs) for (const a of o.extraAttrs) attrs.push(a);

  const header = Buffer.concat(attrs);
  const headerEnd = 8 + header.length + 1;
  const magic = Buffer.from([0x76, 0x2f, 0x31, 0x01]);
  const ver = Buffer.alloc(4);
  ver.writeUInt32LE(((o.version === undefined ? 2 : o.version) | (o.versionFlags || 0)) >>> 0, 0);

  const ys = [];
  for (let y = dw[1]; y <= dw[3]; y++) ys.push(y);
  const physical = o.physicalOrder ? o.physicalOrder.slice() : ys.slice();
  const table = o.tableOrder ? o.tableOrder.slice() : ys.slice();

  const rowOf = y => {
    if (o.rowBytes) { const r = o.rowBytes(y); if (r) return r; }
    return Buffer.alloc(rowLen);
  };

  const rows = new Map();
  let cursor = headerEnd + h * 8;
  for (const y of physical) {
    const data = rowOf(y);
    rows.set(y, { off: cursor, size: data.length });
    cursor += 8 + data.length;
  }

  const tableBuf = Buffer.alloc(h * 8);
  table.forEach((y, i) => {
    const r = rows.get(y);
    if (!r) throw new Error('buildExr: tableOrder 含未知 y=' + y);
    const v = o.offsetFor ? o.offsetFor(i, y, r.off) : r.off;
    tableBuf.writeBigUInt64LE(BigInt(Math.round(v)), i * 8);
  });

  const parts = [magic, ver, header, Buffer.from([0])];
  if (!o.omitOffsetTable) parts.push(tableBuf);
  for (const y of physical) {
    const r = rows.get(y);
    const data = rowOf(y);
    const head = Buffer.alloc(8);
    head.writeInt32LE(o.chunkYOverride ? o.chunkYOverride(y) : y, 0);
    head.writeInt32LE(o.chunkSizeOverride ? o.chunkSizeOverride(y, data.length) : data.length, 4);
    parts.push(head, data);
  }
  let buf = Buffer.concat(parts);
  if (o.append) buf = Buffer.concat([buf, o.append]);
  if (o.truncate) buf = buf.subarray(0, buf.length - o.truncate);
  if (o.name) FIXTURES.set(o.name, { sha256: sha256(buf), len: buf.length });
  return {
    buf, headerEnd, tableStart: headerEnd, tableEnd: headerEnd + h * 8,
    chunkStart: headerEnd + (o.omitOffsetTable ? 0 : h * 8), dataEnd: cursor, w, h, rows, rowLen,
  };
}

// ---------------------------------------------------------------- 断言 / harness
let passed = 0, failed = 0;
const failures = [];
const only = (process.argv.find(a => a.indexOf('--only=') === 0) || '').slice(7);
const skip = (process.argv.find(a => a.indexOf('--skip=') === 0) || '').slice(7);

function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(msg + ' — got ' + a + ', want ' + b); }
function close(a, b, eps, msg) {
  if (!(typeof a === 'number' && isFinite(a) && Math.abs(a - b) <= eps)) {
    throw new Error(msg + ' — got ' + a + ', want ' + b + ' (±' + eps + ')');
  }
}
function isNull(v, msg) {
  if (v !== null) throw new Error(msg + ' — 期望 null，实得 ' + (v && v.pixels ? 'result ' + v.w + 'x' + v.h : String(v)));
}
function px(exr, x, y) { const i = (y * exr.w + x) * 4; return [exr.pixels[i], exr.pixels[i + 1], exr.pixels[i + 2], exr.pixels[i + 3]]; }
function px8(exr, x, y) { const i = (y * exr.w + x) * 4; return [exr.pixels[i], exr.pixels[i + 1], exr.pixels[i + 2], exr.pixels[i + 3]]; }
function rgba8(exr, x, y) { const i = (y * exr.w + x) * 4; const p = P.toRGBA8(exr); return [p[i], p[i + 1], p[i + 2], p[i + 3]]; }

function test(name, fn) {
  if (only && name.indexOf(only) < 0) return;
  if (skip && name.indexOf(skip) >= 0) return;
  const t0 = process.hrtime.bigint();
  try {
    fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    passed++;
    console.log('PASS  ' + name + '  (' + ms.toFixed(2) + 'ms)');
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    failed++;
    const m = (e && e.message) || String(e);
    failures.push(name + ' :: ' + m);
    console.log('FAIL  ' + name + '  (' + ms.toFixed(2) + 'ms) — ' + m);
  }
}

function expectParse(f) { // 合法夹具：返回结果并做形状校验
  const r = P.parse(f.buf);
  ok(r !== null && r !== undefined, 'parse 返回空（lastError=' + P.lastError + '）');
  eq(r.pixels.length, r.w * r.h * 4, 'pixels 长度');
  return r;
}

function expectReject(name, buf, codePrefix) {
  const t0 = Date.now();
  let r = null, threw = null;
  try { r = P.parse(buf); } catch (e) { threw = e; }
  const ms = Date.now() - t0;
  ok(threw === null, name + '：parse 抛异常而非返回 null（' + threw + '）');
  ok(r === null, name + '：期望 null，实得 ' + (r && r.pixels ? 'result ' + r.w + 'x' + r.h : String(r)));
  ok(typeof P.lastError === 'string' && P.lastError.length > 0, name + '：未设置 EXR.lastError（错误信息不可诊断）');
  if (codePrefix) {
    ok(typeof P.lastCode === 'string' && P.lastCode.indexOf(codePrefix) === 0,
      name + '：lastCode=' + P.lastCode + '，期望前缀 ' + codePrefix + '（lastError=' + P.lastError + '）');
  }
  ok(ms < 250, name + '：拒绝耗时 ' + ms + 'ms，疑似卡死/巨量分配');
  return r;
}

// ================================================================ 合法文件
test('legal/1x1-rgb-float-offset-collision-ymin=321', () => {
  const chs = [{ name: 'B', type: 2 }, { name: 'G', type: 2 }, { name: 'R', type: 2 }];
  const f = buildExr({
    name: 'rgb-float-1x1-ymin321', channels: chs, dataWindow: [0, 321, 0, 321],
    rowBytes: () => packRow(chs, [[0.25], [0.5], [1.0]]),
  });
  ok(f.chunkStart === 321, '夹具自检：首个 chunk 偏移应为 321，实得 ' + f.chunkStart);
  const r = expectParse(f);
  eq(r.w, 1, 'w'); eq(r.h, 1, 'h'); eq(r.channels, 3, 'channels');
  const p = px(r, 0, 0);
  close(p[0], 1.0, 0, 'raw R'); close(p[1], 0.5, 0, 'raw G'); close(p[2], 0.25, 0, 'raw B'); close(p[3], 1.0, 0, 'raw A（无 A 通道默认 1）');
  const b = rgba8(r, 0, 0);
  eq(b[3], 255, 'A8（alpha 线性，不走 tone map）');
  eq(b[0], 186, 'R8');
  eq(b[1], 155, 'G8');
  eq(b[2], 123, 'B8');
});

test('legal/1x1-rgb-float-y0-control', () => {
  const chs = [{ name: 'B', type: 2 }, { name: 'G', type: 2 }, { name: 'R', type: 2 }];
  const f = buildExr({
    name: 'rgb-float-1x1-y0', channels: chs, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs, [[0.25], [0.5], [1.0]]),
  });
  const r = expectParse(f);
  const p = px(r, 0, 0);
  close(p[0], 1.0, 0, 'raw R'); close(p[1], 0.5, 0, 'raw G'); close(p[2], 0.25, 0, 'raw B'); close(p[3], 1.0, 0, 'raw A');
});

test('legal/2x2-negative-ymin-physical-shuffle', () => {
  const chs = [{ name: 'R', type: 1 }, { name: 'G', type: 1 }, { name: 'B', type: 1 }];
  const dw = [0, -2, 1, -1]; // w=2 h=2, y ∈ {-2,-1}
  const color = { '-2': [1, 0, 0], '-1': [0, 1, 0] }; // 半精度可精确表示
  const f = buildExr({
    name: 'rgb-half-2x2-neg-ymin-shuffled', channels: chs, dataWindow: dw,
    physicalOrder: [-1, -2], // 物理乱序
    rowBytes: y => packRow(chs, color[String(y)].map(v => [v, v])),
  });
  const r = expectParse(f);
  eq(r.w, 2, 'w'); eq(r.h, 2, 'h');
  close(px(r, 0, 0)[0], 1, 0, 'row0(y=-2) R'); close(px(r, 0, 0)[1], 0, 0, 'row0 G');
  close(px(r, 0, 1)[1], 1, 0, 'row1(y=-1) G'); close(px(r, 0, 1)[0], 0, 0, 'row1 R');
  eq(rgba8(r, 0, 0)[0], 186, 'row0 红');
  eq(rgba8(r, 0, 1)[1], 186, 'row1 绿');
});

test('legal/decreasing-lineorder-chunks-reversed', () => {
  const chs = [{ name: 'R', type: 2 }];
  const f = buildExr({
    name: 'gray-float-1x3-decreasing', channels: chs, dataWindow: [0, 0, 0, 2], lineOrder: 1,
    physicalOrder: [2, 1, 0], tableOrder: [2, 1, 0],
    rowBytes: y => packRow(chs, [[y / 2]]),
  });
  const r = expectParse(f);
  close(px(r, 0, 0)[0], 0, 0, 'y=0'); close(px(r, 0, 1)[0], 0.5, 0, 'y=1'); close(px(r, 0, 2)[0], 1, 0, 'y=2');
});

test('legal/chunk-pixel-bytes-look-like-chunk-header', () => {
  // 第 0 行前 8 字节恰好是 int32 0 / int32 12（若实现靠"盲扫 y/size"就会误判）
  const chs = [{ name: 'B', type: 2 }, { name: 'G', type: 2 }, { name: 'R', type: 2 }];
  const f = buildExr({
    name: 'rgb-float-1x2-header-like-pixels', channels: chs, dataWindow: [0, 0, 0, 1],
    rowBytes: y => (y === 0
      ? Buffer.concat([f32(0), Buffer.from([0x0c, 0x00, 0x00, 0x00]), f32(1)]) // 12B，前 8B 解释为 y=0,size=12
      : packRow(chs, [[0.5], [0.5], [0.5]])),
  });
  const r = expectParse(f);
  eq(r.h, 2, 'h');
  close(px(r, 0, 1)[0], 0.5, 0, 'row1 R');
});

test('legal/rgba-half-alpha-linear-coverage', () => {
  const chs = [{ name: 'R', type: 1 }, { name: 'G', type: 1 }, { name: 'B', type: 1 }, { name: 'A', type: 1 }];
  const f = buildExr({
    name: 'rgba-half-2x1-alpha', channels: chs, dataWindow: [0, 0, 1, 0],
    rowBytes: () => packRow(chs, [[1, 0.5], [1, 0.5], [1, 0.5], [1, 0.5]]),
  });
  const r = expectParse(f);
  eq(r.channels, 4, 'channels');
  close(px(r, 0, 0)[3], 1, 0, 'A0'); close(px(r, 1, 0)[3], 0.5, 0, 'A1');
  eq(rgba8(r, 0, 0)[3], 255, 'A8=1 -> 255');
  eq(rgba8(r, 1, 0)[3], 128, 'A8=0.5 -> 128（线性覆盖度，不做 gamma）');
  const sameRgb = P.toRGBA8({ w: 2, h: 1, pixels: new Float32Array([1, 0.5, 0.25, 1, 1, 0.5, 0.25, 0.5]) });
  eq(sameRgb[0], sameRgb[4], 'alpha 不影响 RGB（同 RGB、不同 alpha 同色）');
  eq(sameRgb[0], 186, 'R=1 -> 186'); eq(sameRgb[1], 155, 'G=0.5 -> 155'); eq(sameRgb[2], 123, 'B=0.25 -> 123');
});

test('legal/rgba-float-nonfinite-alpha-policy', () => {
  const chs = [{ name: 'R', type: 2 }, { name: 'G', type: 2 }, { name: 'B', type: 2 }, { name: 'A', type: 2 }];
  const cases = [[NaN, 1, 1, NaN], [0, 0, 0, Infinity], [0, 0, 0, -Infinity], [0, 0, 0, -0.25], [0, 0, 0, 2]];
  const f = buildExr({
    name: 'rgba-float-nonfinite', channels: chs, dataWindow: [0, 0, 4, 0],
    rowBytes: () => packRow(chs, [
      cases.map(c => c[0]), cases.map(c => c[1]), cases.map(c => c[2]), cases.map(c => c[3]),
    ]),
  });
  const r = expectParse(f);
  eq(rgba8(r, 0, 0)[3], 255, 'A=NaN -> 不透明 255');
  eq(rgba8(r, 1, 0)[3], 255, 'A=+Inf -> 255');
  eq(rgba8(r, 2, 0)[3], 0, 'A=-Inf -> 0');
  eq(rgba8(r, 3, 0)[3], 0, 'A=-0.25 -> 0');
  eq(rgba8(r, 4, 0)[3], 255, 'A=2 -> 255');
  const b0 = rgba8(r, 0, 0);
  eq(b0[0], 0, 'R=NaN -> 0'); eq(b0[1], 186, 'R=NaN 不影响 G'); eq(b0[2], 186, 'R=NaN 不影响 B');
});

test('legal/gray-single-channel-R-G-B-Y-visible', () => {
  const expectGray = (chName, v) => {
    const chs = [{ name: chName, type: 2 }];
    const f = buildExr({
      name: 'gray-single-' + chName, channels: chs, dataWindow: [0, 0, 0, 0],
      rowBytes: () => packRow(chs, [[v]]),
    });
    const r = expectParse(f);
    eq(r.channels, 1, chName + ' channels');
    const p = px(r, 0, 0);
    close(p[0], v, 0, chName + ' R'); close(p[1], v, 0, chName + ' G'); close(p[2], v, 0, chName + ' B'); close(p[3], 1, 0, chName + ' A');
    const b = rgba8(r, 0, 0);
    ok(b[0] > 0 && b[1] > 0 && b[2] > 0, chName + ' 单通道必须可见（非黑），实得 ' + b.join(','));
  };
  expectGray('R', 0.5); expectGray('G', 0.5); expectGray('B', 0.5); expectGray('Y', 0.5);
});

test('legal/unknown-scalar-channel-z-displayed-as-gray', () => {
  const chs = [{ name: 'Z', type: 2 }];
  const f = buildExr({
    name: 'gray-single-Z-scalar', channels: chs, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs, [[0.5]]),
  });
  const r = expectParse(f);
  eq(r.channels, 1, 'Z channels');
  const p = px(r, 0, 0);
  close(p[0], 0.5, 0, 'Z->R'); close(p[1], 0.5, 0, 'Z->G'); close(p[2], 0.5, 0, 'Z->B'); close(p[3], 1, 0, 'A');
  eq(rgba8(r, 0, 0)[0], 155, 'Z 单通道必须可见（灰），不能是纯黑');

  const chs2 = [{ name: 'depth.Z', type: 2 }, { name: 'R', type: 2 }];
  const f2 = buildExr({
    name: 'gray-z-plus-explicit-R', channels: chs2, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs2, [[0.25], [1.0]]),
  });
  const r2 = expectParse(f2);
  eq(r2.channels, 1, 'depth.Z + R channels');
  close(px(r2, 0, 0)[0], 1.0, 0, '显式 R 不被未知通道覆盖');
  close(px(r2, 0, 0)[1], 1.0, 0, 'R->G'); close(px(r2, 0, 0)[2], 1.0, 0, 'R->B');
});

test('legal/two-channel-Y-A-and-R-A', () => {
  const chs = [{ name: 'Y', type: 2 }, { name: 'A', type: 2 }];
  const f = buildExr({
    name: 'gray-ya-1x1', channels: chs, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs, [[0.25], [0.5]]),
  });
  const r = expectParse(f);
  const p = px(r, 0, 0);
  close(p[0], 0.25, 0, 'Y->R'); close(p[1], 0.25, 0, 'Y->G'); close(p[2], 0.25, 0, 'Y->B'); close(p[3], 0.5, 0, 'A');
  eq(rgba8(r, 0, 0)[3], 128, 'A8');

  const chs2 = [{ name: 'R', type: 2 }, { name: 'A', type: 2 }];
  const f2 = buildExr({
    name: 'ra-float-1x1', channels: chs2, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs2, [[0.75], [1.0]]),
  });
  const r2 = expectParse(f2);
  close(px(r2, 0, 0)[0], 0.75, 0, 'R'); close(px(r2, 0, 0)[1], 0.75, 0, 'R->G'); close(px(r2, 0, 0)[2], 0.75, 0, 'R->B');
  eq(rgba8(r2, 0, 0)[3], 255, 'A8');
});

test('legal/uint32-channels-and-mixed-types-alignment', () => {
  const chs = [{ name: 'R', type: 0 }, { name: 'G', type: 0 }, { name: 'B', type: 0 }];
  const f = buildExr({
    name: 'rgb-uint32-1x1', channels: chs, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs, [[1], [2], [3]]),
  });
  const r = expectParse(f);
  close(px(r, 0, 0)[0], 1, 0, 'UINT R'); close(px(r, 0, 0)[1], 2, 0, 'UINT G'); close(px(r, 0, 0)[2], 3, 0, 'UINT B');

  const mixed = [{ name: 'R', type: 1 }, { name: 'G', type: 2 }, { name: 'B', type: 0 }];
  const f2 = buildExr({
    name: 'rgb-mixed-half-float-uint', channels: mixed, dataWindow: [0, 0, 1, 0],
    rowBytes: () => packRow(mixed, [[0.5, 0.25], [0.75, 1.5], [7, 9]]),
  });
  const r2 = expectParse(f2);
  eq(r2.w, 2, 'w');
  close(px(r2, 1, 0)[0], 0.25, 0, 'HALF R@1'); close(px(r2, 1, 0)[1], 1.5, 0, 'FLOAT G@1'); close(px(r2, 1, 0)[2], 9, 0, 'UINT B@1');
});

test('legal/uint32-large-value-no-silent-truncation', () => {
  const chs = [{ name: 'R', type: 0 }];
  const f = buildExr({
    name: 'gray-uint32-max', channels: chs, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs, [[4294967295]]),
  });
  const r = expectParse(f);
  const v = px(r, 0, 0)[0];
  ok(v > 4.29e9 && v < 4.30e9, 'UINT32 最大值应约为 4.295e9，实得 ' + v);
});

test('legal/six-channels-extra-does-not-clobber-rgb', () => {
  const chs = [
    { name: 'Z', type: 2 }, { name: 'R', type: 2 }, { name: 'G', type: 2 }, { name: 'B', type: 2 },
    { name: 'A', type: 2 }, { name: 'mask', type: 2 },
  ];
  const vals = { Z: [9], R: [1], G: [0.5], B: [0.25], A: [0.5], mask: [0.125] };
  const f = buildExr({
    name: 'six-channel-zrgba-mask', channels: chs, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs, chs.map(c => vals[c.name])),
  });
  const r = expectParse(f);
  const p = px(r, 0, 0);
  close(p[0], 1, 0, 'R（不能被 Z 覆盖）'); close(p[1], 0.5, 0, 'G'); close(p[2], 0.25, 0, 'B'); close(p[3], 0.5, 0, 'A');
  eq(r.channels, 4, 'mapped channels');
});

test('legal/layer-prefixed-channel-names', () => {
  const chs = [
    { name: 'depth.Z', type: 2 }, { name: 'beauty.R', type: 2 }, { name: 'beauty.G', type: 2 }, { name: 'beauty.B', type: 2 },
  ];
  const vals = { 'depth.Z': [9], 'beauty.R': [1], 'beauty.G': [0.5], 'beauty.B': [0.25] };
  const f = buildExr({
    name: 'layered-rgb-depth', channels: chs, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs, chs.map(c => vals[c.name])),
  });
  const r = expectParse(f);
  const p = px(r, 0, 0);
  close(p[0], 1, 0, 'beauty.R'); close(p[1], 0.5, 0, 'beauty.G'); close(p[2], 0.25, 0, 'beauty.B');
  close(p[3], 1, 0, 'A 默认 1');
});

test('legal/long-names-version-flag-accepted', () => {
  const chs = [{ name: 'R', type: 2 }];
  const f = buildExr({
    name: 'gray-longnames-flag', channels: chs, dataWindow: [0, 0, 0, 0], versionFlags: 0x400,
    rowBytes: () => packRow(chs, [[1]]),
  });
  const r = expectParse(f);
  close(px(r, 0, 0)[0], 1, 0, 'R');
});

test('legal/trailing-bytes-after-last-chunk-ignored', () => {
  const chs = [{ name: 'R', type: 2 }];
  const f = buildExr({
    name: 'gray-trailing-junk', channels: chs, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs, [[0.5]]), append: Buffer.alloc(16, 0xab),
  });
  const r = expectParse(f);
  close(px(r, 0, 0)[0], 0.5, 0, 'R');
});

test('legal/nonzero-view-offset-typed-array-input', () => {
  const chs = [{ name: 'R', type: 2 }, { name: 'G', type: 2 }, { name: 'B', type: 2 }];
  const f = buildExr({
    name: 'rgb-float-view-offset', channels: chs, dataWindow: [0, 0, 0, 0],
    rowBytes: () => packRow(chs, [[1], [0.5], [0.25]]),
  });
  const big = Buffer.concat([Buffer.alloc(37, 0x5a), Buffer.from(f.buf), Buffer.alloc(11, 0x5a)]);
  const view = new Uint8Array(big.buffer, big.byteOffset + 37, f.buf.length);
  const r = P.parse(view);
  ok(r !== null, '带 byteOffset 的视图也应解析（lastError=' + P.lastError + '）');
  close(px(r, 0, 0)[0], 1, 0, 'R'); close(px(r, 0, 0)[2], 0.25, 0, 'B');
});

test('legal/input-buffer-not-mutated', () => {
  const chs = [{ name: 'R', type: 2 }];
  const f = buildExr({ name: 'gray-no-mutate', channels: chs, dataWindow: [0, 0, 0, 0], rowBytes: () => packRow(chs, [[1]]) });
  const before = sha256(f.buf);
  P.parse(f.buf);
  eq(sha256(f.buf), before, 'parse 不应修改输入字节');
});

// ================================================================ 明确拒绝（不支持特性）
test('reject/not-exr-magic-and-short-buffer', () => {
  expectReject('短缓冲', Buffer.from([0x76, 0x2f]), 'not-exr');
  expectReject('错 magic', Buffer.from('DDS ' + '\0'.repeat(20), 'latin1'), 'not-exr');
  expectReject('空缓冲', Buffer.alloc(0), 'not-exr');
});

test('reject/compression-not-none', () => {
  const chs = [{ name: 'R', type: 2 }];
  for (const c of [1, 2, 3, 4, 8]) {
    const f = buildExr({ channels: chs, dataWindow: [0, 0, 0, 0], compression: c, rowBytes: () => packRow(chs, [[1]]) });
    expectReject('compression=' + c, f.buf, 'unsupported-compression');
  }
});

test('reject/version-flags-tiled-deep-multipart', () => {
  const chs = [{ name: 'R', type: 2 }];
  const mk = flags => buildExr({ channels: chs, dataWindow: [0, 0, 0, 0], versionFlags: flags, rowBytes: () => packRow(chs, [[1]]) }).buf;
  expectReject('tiled(0x200)', mk(0x200), 'unsupported');
  expectReject('deep(0x800)', mk(0x800), 'unsupported');
  expectReject('multipart(0x1000)', mk(0x1000), 'unsupported');
  expectReject('unknown-version-1', buildExr({ channels: chs, dataWindow: [0, 0, 0, 0], version: 1, rowBytes: () => packRow(chs, [[1]]) }).buf, 'unsupported');
});

test('reject/type-attribute-tiled-without-flag', () => {
  const chs = [{ name: 'R', type: 2 }];
  const f = buildExr({ channels: chs, dataWindow: [0, 0, 0, 0], typeAttr: 'tiledimage', rowBytes: () => packRow(chs, [[1]]) });
  expectReject('type=tiledimage', f.buf, 'unsupported');
});

test('reject/sampling-not-1', () => {
  const x2 = [{ name: 'R', type: 2, xSampling: 2 }];
  const y2 = [{ name: 'R', type: 2, ySampling: 2 }];
  expectReject('xSampling=2', buildExr({ channels: x2, dataWindow: [0, 0, 0, 0], rowBytes: () => packRow(x2, [[1]]) }).buf, 'unsupported-sampling');
  expectReject('ySampling=2', buildExr({ channels: y2, dataWindow: [0, 0, 0, 0], rowBytes: () => packRow(y2, [[1]]) }).buf, 'unsupported-sampling');
});

test('reject/unknown-pixel-type-not-silently-decoded', () => {
  const chs = [{ name: 'R', type: 3 }];
  const f = buildExr({ channels: chs, dataWindow: [0, 0, 0, 0], rowBytes: () => Buffer.alloc(4) });
  expectReject('pixelType=3', f.buf, 'unsupported-pixel-type');
});

test('reject/random-lineorder', () => {
  const chs = [{ name: 'R', type: 2 }];
  const f = buildExr({ channels: chs, dataWindow: [0, 0, 0, 0], lineOrder: 2, rowBytes: () => packRow(chs, [[1]]) });
  expectReject('lineOrder=2', f.buf, 'unsupported');
});

test('reject/missing-required-attributes', () => {
  const chs = [{ name: 'R', type: 2 }];
  for (const a of ['channels', 'compression', 'dataWindow']) {
    const f = buildExr({ channels: chs, dataWindow: [0, 0, 0, 0], omitHeaderAttr: [a], rowBytes: () => packRow(chs, [[1]]) });
    expectReject('缺少 ' + a, f.buf, '');
  }
});

test('reject/empty-or-inverted-windows', () => {
  const chs = [{ name: 'R', type: 2 }];
  expectReject('w=0', buildExr({ channels: chs, dataWindow: [5, 0, 4, 0], rowBytes: () => Buffer.alloc(0) }).buf, '');
  expectReject('h=0', buildExr({ channels: chs, dataWindow: [0, 5, 0, 4], rowBytes: () => Buffer.alloc(0) }).buf, '');
  expectReject('xmax<xmin', buildExr({ channels: chs, dataWindow: [3, 0, -3, 0], rowBytes: () => Buffer.alloc(0) }).buf, '');
});

// ================================================================ 结构损坏 / 敌意输入
test('hostile/truncated-header-terminator-and-offset-table', () => {
  const chs = [{ name: 'R', type: 2 }];
  const mk = o => buildExr(Object.assign({ channels: chs, dataWindow: [0, 0, 0, 0], rowBytes: () => packRow(chs, [[1]]) }, o)).buf;
  expectReject('截断 header', mk({ truncate: 12 }), '');
  expectReject('无 header 终止符（截到终止符前）', mk({ truncate: 1 + 8 + 4 }), '');
  expectReject('截断 offset table', mk({ truncate: 24 }), 'truncated');
  expectReject('offset table 完整但末尾行块数据被截断', mk({ truncate: 4 }), '');
  expectReject('无 offset table', mk({ omitOffsetTable: true, truncate: 0 }), '');
  expectReject('只有 magic+version', Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]), '');
});

test('hostile/chunk-offset-and-size-violations', () => {
  const chs = [{ name: 'R', type: 2 }];
  const base = { channels: chs, dataWindow: [0, 0, 0, 0], rowBytes: () => packRow(chs, [[1]]) };
  expectReject('offset=0', buildExr(Object.assign({}, base, { offsetFor: () => 0 })).buf, '');
  expectReject('offset 超过 EOF', buildExr(Object.assign({}, base, { offsetFor: (i, y, off) => off + 4096 })).buf, '');
  expectReject('offset=EOF-4', buildExr(Object.assign({}, base, { offsetFor: (i, y, off) => off + 4 })).buf, '');
  expectReject('dataSize 过小', buildExr(Object.assign({}, base, { chunkSizeOverride: () => 2 })).buf, '');
  expectReject('dataSize 过大', buildExr(Object.assign({}, base, { chunkSizeOverride: () => 1 << 20 })).buf, '');
  expectReject('dataSize 为负', buildExr(Object.assign({}, base, { chunkSizeOverride: () => -4 })).buf, '');
  expectReject('chunk y 越窗', buildExr(Object.assign({}, base, { chunkYOverride: () => 7 })).buf, '');
  expectReject('截断 chunk 数据', buildExr(Object.assign({}, base, { truncate: 2 })).buf, '');
});

test('hostile/duplicate-and-missing-scanlines', () => {
  const chs = [{ name: 'R', type: 2 }];
  const dw = [0, 0, 0, 2]; // h=3
  const mk = o => buildExr(Object.assign({ channels: chs, dataWindow: dw, rowBytes: y => packRow(chs, [[y / 2]]) }, o)).buf;
  expectReject('重复 y（缺行）', mk({ tableOrder: [0, 0, 1] }), '');
  expectReject('缺行（表项指向同一 chunk）', mk({ tableOrder: [0, 1, 1] }), '');
  expectReject('chunk 声明越界 y', mk({ chunkYOverride: y => (y === 2 ? 9 : y) }), '');
});

test('hostile/chlist-bounds-and-sizes', () => {
  const chs = [{ name: 'R', type: 2 }];
  const mk = o => buildExr(Object.assign({ channels: chs, dataWindow: [0, 0, 0, 0], rowBytes: () => packRow(chs, [[1]]) }, o)).buf;
  expectReject('空 chlist（只有终止 0）', mk({ chlistRaw: Buffer.from([0]) }), '');
  // 声明 size=18、内容恰好一个 18 字节条目但**没有终止 0**：不得越界续读
  expectReject('chlist 无终止 0（声明 size 内耗尽）', mk({ chlistRaw: Buffer.concat([strz('R'), i32(2), Buffer.alloc(12)]) }), '');
});

test('hostile/chlist-declared-size-overflow', () => {
  // 手工构造：channels 属性声明 size=0x7fffffff，实际只给 3 字节
  const head = Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]);
  const ch = Buffer.concat([strz('channels'), strz('chlist'), i32(0x7fffffff), Buffer.from([0x00])]);
  const tail = Buffer.concat([strz('compression'), strz('compression'), i32(1), Buffer.from([0])]);
  expectReject('chlist 超大声明', Buffer.concat([head, ch, tail, Buffer.from([0]), Buffer.alloc(8)]), '');
});

test('hostile/chlist-missing-terminator-and-negative-attr-size', () => {
  const head = Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]);
  const noTerm = Buffer.concat([strz('channels'), strz('chlist'), i32(17), Buffer.concat([strz('R'), i32(2), Buffer.alloc(12)])]);
  expectReject('chlist 无终止 0', Buffer.concat([head, noTerm, Buffer.from([0]), Buffer.alloc(8)]), '');
  const negSize = Buffer.concat([strz('channels'), strz('chlist'), i32(-64), Buffer.alloc(8)]);
  expectReject('属性 size 为负', Buffer.concat([head, negSize, Buffer.from([0]), Buffer.alloc(8)]), '');
});

test('hostile/huge-dimensions-rejected-fast', () => {
  const chs = [{ name: 'R', type: 2 }];
  // 只声明巨大窗口、文件本身仍是 1 行（dataWindowRaw 只改头部字节，不建真实行数据）
  const huge = dwRaw => buildExr({
    channels: chs, dataWindow: [0, 0, 0, 0], dataWindowRaw: dwRaw,
    rowBytes: () => packRow(chs, [[1]]),
  }).buf;
  expectReject('2^30 x 2^30', huge([0, 0, 1073741823, 1073741823]), 'too-large');
  expectReject('65535 x 65535', huge([0, 0, 65534, 65534]), 'too-large');
  expectReject('负数极端窗口', huge([-2147483648, 0, 2147483647, 0]), '');
});

test('hostile/tiny-file-huge-window-no-allocation', () => {
  // 合法的 1x1 文件，头部把 dataWindow 改成 60000x60000（36 亿像素）：必须在分配前置校验里被拒
  const chs = [{ name: 'R', type: 2 }];
  const f = buildExr({
    name: 'tiny-file-huge-window', channels: chs, dataWindow: [0, 0, 0, 0],
    dataWindowRaw: [0, 0, 59999, 59999], rowBytes: () => packRow(chs, [[1]]),
  });
  expectReject('小文件+巨窗口', f.buf, '');
});

test('hostile/fuzz-mutations-never-hang-or-throw', () => {
  const chs = [{ name: 'R', type: 1 }, { name: 'G', type: 1 }, { name: 'B', type: 1 }];
  const f = buildExr({
    name: 'fuzz-base-2x3-rgb-half', channels: chs, dataWindow: [0, 0, 1, 2],
    rowBytes: y => packRow(chs, [[y / 4, y / 4], [0.5, 0.5], [0.25, 0.25]]),
  });
  const base = f.buf;
  const mutable = []; // 只改 offset table 之后（含 table 本身），避免构造出天文窗口造成测试自身巨量分配
  for (let i = f.headerEnd; i < base.length; i++) mutable.push(i);
  let seed = 0x1234abcd;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const t0 = Date.now();
  for (let it = 0; it < 400; it++) {
    const m = Buffer.from(base);
    const kind = Math.floor(rnd() * 3);
    if (kind === 0) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) { const i = mutable[Math.floor(rnd() * mutable.length)]; m[i] = Math.floor(rnd() * 256); }
    } else if (kind === 1) {
      const cut = 1 + Math.floor(rnd() * 24);
      const sub = m.subarray(0, Math.max(8, m.length - cut));
      let r = null;
      try { r = P.parse(sub); } catch (e) { throw new Error('mutation#' + it + '（截断 ' + cut + 'B）parse 抛异常：' + e.message); }
      if (r) { eq(r.pixels.length, r.w * r.h * 4, 'mutation#' + it + ' pixels 长度'); }
      continue;
    } else {
      m[4 + Math.floor(rnd() * 4)] = Math.floor(rnd() * 256); // version 字段
      m[Math.floor(rnd() * 4)] = Math.floor(rnd() * 256);     // magic
    }
    let r = null;
    try { r = P.parse(m); } catch (e) { throw new Error('mutation#' + it + ' parse 抛异常：' + e.message); }
    if (r) {
      eq(r.pixels.length, r.w * r.h * 4, 'mutation#' + it + ' pixels 长度');
      ok(r.w > 0 && r.h > 0, 'mutation#' + it + ' 尺寸必须为正');
    }
  }
  const ms = Date.now() - t0;
  ok(ms < 5000, '400 次变异解析耗时 ' + ms + 'ms，疑似卡死');
  console.log('      · fuzz: 400 次变异，耗时 ' + ms + 'ms，无异常逃逸');
});

test('hostile/type-not-scanline-deep-names', () => {
  const chs = [{ name: 'R', type: 2 }];
  for (const t of ['deepscanline', 'deeptile', 'multipartimage']) {
    const f = buildExr({ channels: chs, dataWindow: [0, 0, 0, 0], typeAttr: t, rowBytes: () => packRow(chs, [[1]]) });
    expectReject('type=' + t, f.buf, 'unsupported');
  }
});

// ================================================================ toRGBA8 契约
test('toRGBA8/alpha-linear-and-per-channel-tonemap', () => {
  const mk = a => ({ w: 1, h: 1, pixels: new Float32Array([1, 0.5, 0.25, a]) });
  const opaque = P.toRGBA8(mk(1));
  eq(opaque[3], 255, 'A=1 -> 255');
  eq(opaque[0], 186, 'R=1 -> 186');
  eq(opaque[1], 155, 'G=0.5 -> 155');
  eq(opaque[2], 123, 'B=0.25 -> 123');
  eq(P.toRGBA8(mk(0.5))[3], 128, 'A=0.5 -> 128');
  eq(P.toRGBA8(mk(0))[3], 0, 'A=0 -> 0');
  eq(P.toRGBA8(mk(NaN))[3], 255, 'A=NaN -> 255（文档化策略）');
  eq(P.toRGBA8(mk(-1))[3], 0, 'A<0 -> 0');
  eq(P.toRGBA8(mk(3))[3], 255, 'A>1 -> 255');
  const nan = P.toRGBA8({ w: 1, h: 1, pixels: new Float32Array([NaN, Infinity, -1, 1]) });
  eq(nan[0], 0, 'NaN -> 0'); eq(nan[1], 0, 'Inf -> 0'); eq(nan[2], 0, '负 -> 0');

  // 回归：逐分量映射——灰阶明暗可分、分量之间互不影响
  const gray = v => P.toRGBA8({ w: 1, h: 1, pixels: new Float32Array([v, v, v, 1]) });
  const dark = gray(0.1)[0], light = gray(0.9)[0];
  eq(dark, 86, '灰 0.1 -> 86');
  eq(light, 182, '灰 0.9 -> 182');
  ok(light > dark, '灰 0.1/0.9 必须明暗不同，实得 ' + dark + '/' + light);
  eq(gray(0.5)[0], 155, '灰 0.5 -> 155（不再被归一化成 255）');
  const mixed = P.toRGBA8({ w: 1, h: 1, pixels: new Float32Array([0.5, 1, 1, 1]) });
  eq(mixed[0], 155, 'R=0.5 不受 G/B 强弱影响');
  eq(mixed[1], 186, 'G=1 -> 186');
  const p0 = P.toRGBA8({ w: 1, h: 1, pixels: new Float32Array([NaN, 1, 1, 1]) });
  eq(p0[0], 0, 'R=NaN -> 0'); eq(p0[1], 186, 'R=NaN 不影响 G'); eq(p0[2], 186, 'R=NaN 不影响 B');
  eq(P.toRGBA8(null), null, 'toRGBA8(null) 应安全返回 null');
});

// ================================================================ 汇总输出
console.log('');
console.log('# 工具链：node ' + process.version + ' / ' + process.platform + '-' + process.arch);
console.log('# exr-parser.js sha256=' + srcHash('exr-parser.js'));
console.log('# worker-shared.js sha256=' + srcHash('worker-shared.js'));
console.log('# 夹具清单（' + FIXTURES.size + ' 个）：');
for (const [n, v] of FIXTURES) console.log('#   FIXTURE ' + n + ' len=' + v.len + ' sha256=' + v.sha256);
console.log('');
console.log('SUMMARY: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' ran'
  + (only ? '  [--only=' + only + ']' : '') + (skip ? '  [--skip=' + skip + ']' : ''));
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failed ? 1 : 0);
