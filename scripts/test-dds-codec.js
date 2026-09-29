'use strict';
// =============================================================================
// test-dds-codec.js — BC1-BC5 软件解码 + DXGI 格式识别回归测试
// 被测：static/js/worker-shared.js（在 vm 沙箱里以 self=沙箱 加载，模拟经典 script）
//
// 期望值来源（独立于实现，按 D3D11 / DirectXTex 参考解码手推）：
//   * BC1 —— c0>c1：4 色模式 c2=(2*c0+c1)/3、c3=(c0+2*c1)/3（整数截断到 8bit）
//            c0<=c1：3 色模式 c2=(c0+c1)/2（截断）、c3=(0,0,0,0) 透明黑
//   * BC2/BC3 —— 颜色块**恒为 4 色模式**（不套 BC1 的 3 色+透明分支）
//                BC2 alpha = 16 个 4bit nibble × 17
//                BC3 alpha = 8 字节 BC4 风格内插块（a0>a1 时 8 值）
//   * BC4/BC5 UNORM —— 6 值模式 (6-idx)*e0+(idx-1)*e1 /5，8 值模式 /7，整数除法截断
//   * BC4/BC5 SNORM —— 浮点：e/127 → 内插 → (v+1)*127.5 映射到显示字节（Uint8 截断）
//   * 所有解码器输出 RGBA8：单通道格式把值复制到 R/G/B，A=255
// 运行：node scripts/test-dds-codec.js
// =============================================================================
var vm = require('vm');
var fs = require('fs');
var path = require('path');
var assert = require('assert');

// ---------------------------------------------------------------- 沙箱加载
var srcPath = path.join(__dirname, '..', 'static', 'js', 'worker-shared.js');
var sandbox = { console: console };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(srcPath, 'utf8'), sandbox, { filename: srcPath });
var S = sandbox.ImageCodecShared;
assert.ok(S && typeof S.decodeBC === 'function', 'worker-shared.js 应暴露 ImageCodecShared.decodeBC');

// ---------------------------------------------------------------- 工具
// 4×4 像素的逐像素断言用的期望数组生成器
function rep(arr, n) { var o = []; for (var i = 0; i < n; i++) o = o.concat(arr); return o; }

// BC1 索引打包（16×2bit → 4 字节，LSB 优先）
function idx2bytes(idx) {
  var b = [0, 0, 0, 0];
  for (var i = 0; i < 16; i++) b[(i >> 2)] |= (idx[i] & 3) << ((i & 3) * 2);
  return b;
}
// BC4/5 索引打包（16×3bit → 6 字节，LSB 优先）
function idx3bytes(idx) {
  var b = [0, 0, 0, 0, 0, 0];
  for (var i = 0; i < 16; i++)
    for (var k = 0; k < 3; k++)
      if ((idx[i] >> k) & 1) { var bit = i * 3 + k; b[(bit / 8) | 0] |= 1 << (bit % 8); }
  return b;
}
function px(buf, x, y, w) { var o = ((y * w) + x) * 4; return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]; }
// 所有 16 像素都应等于同一 RGBA
function allSamePixels(buf, rgba) {
  var got = Array.from(buf);
  assert.deepStrictEqual(got, rep(rgba, 16));
}
var BC1 = { fourCC: 'DXT1', dxgi: 71, type: 'BC1_UNORM', family: 'BC1', isComp: true, bpp: 8 };
var BC2 = { fourCC: 'DXT3', dxgi: 74, type: 'BC2_UNORM', family: 'BC3', isComp: true, bpp: 16 };
var BC3 = { fourCC: 'DXT5', dxgi: 77, type: 'BC3_UNORM', family: 'BC3', isComp: true, bpp: 16 };
var BC4U = { fourCC: 'ATI1', dxgi: 80, type: 'BC4_UNORM', family: 'BC4', isComp: true, bpp: 8 };
var BC4S = { fourCC: 'BC4S', dxgi: 81, type: 'BC4_SNORM', family: 'BC4', isComp: true, bpp: 8 };
var BC5U = { fourCC: 'ATI2', dxgi: 83, type: 'BC5_UNORM', family: 'BC5', isComp: true, bpp: 16 };
var BC5S = { fourCC: 'BC5S', dxgi: 84, type: 'BC5_SNORM', family: 'BC5', isComp: true, bpp: 16 };

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---------------------------------------------------------------- BC1
test('BC1 c0<=c1 + 全 3 索引 → 透明黑 (0,0,0,0)', function () {
  // c0=0x0000, c1=0xFFFF, 索引全 3 → BC1 3 色模式：c3 是透明黑
  var d = [0, 0, 0xFF, 0xFF].concat(idx2bytes(rep([3], 16)));
  allSamePixels(S.decodeBC(new Uint8Array(d), 4, 4, BC1), [0, 0, 0, 0]);
});

test('BC1 c0<=c1 索引 2 → 端点均值 (127,127,127,255)', function () {
  // (0 + 255) / 2 = 127.5 → 截断 127
  var d = [0, 0, 0xFF, 0xFF].concat(idx2bytes(rep([2], 16)));
  allSamePixels(S.decodeBC(new Uint8Array(d), 4, 4, BC1), [127, 127, 127, 255]);
});

test('BC1 c0>c1 4 色模式：索引 2/3 为 1/3、2/3 插值，A=255', function () {
  var e0 = 0xFFFF, e1 = 0x0000; // 白、黑
  var d2 = [e0 & 255, e0 >> 8, e1 & 255, e1 >> 8].concat(idx2bytes(rep([2], 16)));
  allSamePixels(S.decodeBC(new Uint8Array(d2), 4, 4, BC1), [170, 170, 170, 255]); // (2*255+0)/3
  var d3 = [e0 & 255, e0 >> 8, e1 & 255, e1 >> 8].concat(idx2bytes(rep([3], 16)));
  allSamePixels(S.decodeBC(new Uint8Array(d3), 4, 4, BC1), [85, 85, 85, 255]);   // (255+2*0)/3
});

test('BC1 逐像素索引：不同像素取不同颜色', function () {
  var e0 = 0xFFFF, e1 = 0x0000;
  var d = [e0 & 255, e0 >> 8, e1 & 255, e1 >> 8].concat(idx2bytes(rep([0, 1, 2, 3], 4)));
  var out = S.decodeBC(new Uint8Array(d), 4, 4, BC1);
  assert.deepStrictEqual(px(out, 0, 0, 4), [255, 255, 255, 255]);
  assert.deepStrictEqual(px(out, 1, 0, 4), [0, 0, 0, 255]);
  assert.deepStrictEqual(px(out, 2, 0, 4), [170, 170, 170, 255]);
  assert.deepStrictEqual(px(out, 3, 0, 4), [85, 85, 85, 255]);
});

// ---------------------------------------------------------------- BC2
test('BC2 alpha 全 0 不被颜色/收尾覆写 → (255,0,0,0)', function () {
  // alpha 8 字节 = 0；颜色块 c0=0xF800(红) c1=0x0000 索引全 0
  var d = [0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0xF8, 0x00, 0x00].concat(idx2bytes(rep([0], 16)));
  allSamePixels(S.decodeBC(new Uint8Array(d), 4, 4, BC2), [255, 0, 0, 0]);
});

test('BC2 alpha 4bit nibble × 17，颜色独立', function () {
  // 规范：像素 2i 取字节 i 的低 nibble、像素 2i+1 取高 nibble（×17）
  var d = [0x0F, 0xF0, 0x0F, 0xF0, 0x0F, 0xF0, 0x0F, 0xF0,
           0x1F, 0x00, 0x00, 0x00].concat(idx2bytes(rep([0], 16))); // c0=0x001F 蓝
  var out = S.decodeBC(new Uint8Array(d), 4, 4, BC2);
  // 逐像素 alpha 期望：字节 0x0F → 低 nibble 255 / 高 nibble 0；字节 0xF0 反之
  var alphas = [];
  for (var b = 0; b < 8; b++) { alphas.push(b % 2 === 0 ? 255 : 0, b % 2 === 0 ? 0 : 255); }
  for (var i = 0; i < 16; i++)
    assert.deepStrictEqual(px(out, i % 4, (i / 4) | 0, 4), [0, 0, 255, alphas[i]], 'BC2 pixel ' + i);
});

test('BC2 颜色块恒 4 色（c0<=c1 时索引 3 不是透明）', function () {
  // c0=0x0000 < c1=0xFFFF —— BC1 会走透明分支；BC2 必须仍取 (c0+2*c1)/3 = 170
  var d = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
           0x00, 0x00, 0xFF, 0xFF].concat(idx2bytes(rep([3], 16)));
  allSamePixels(S.decodeBC(new Uint8Array(d), 4, 4, BC2), [170, 170, 170, 255]);
});

// ---------------------------------------------------------------- BC3
test('BC3 a0=255 + 颜色 c0=0/c1=0xFFFF 索引 3 → (170,170,170,255)', function () {
  var alpha = [255, 0].concat(idx3bytes(rep([0], 16))); // a0=255,a1=0,全 0 索引 → alpha=a0=255
  var d = alpha.concat([0x00, 0x00, 0xFF, 0xFF]).concat(idx2bytes(rep([3], 16)));
  allSamePixels(S.decodeBC(new Uint8Array(d), 4, 4, BC3), [170, 170, 170, 255]);
});

test('BC3 alpha 内插（索引 1 → a1）与颜色分离', function () {
  var alpha = [255, 0].concat(idx3bytes(rep([1], 16))); // 全 1 索引 → alpha=a1=0
  var d = alpha.concat([0x00, 0x00, 0xFF, 0xFF]).concat(idx2bytes(rep([3], 16)));
  allSamePixels(S.decodeBC(new Uint8Array(d), 4, 4, BC3), [170, 170, 170, 0]);
});

test('BC3 alpha 6 值模式：a0=0<=a1=255 逐索引', function () {
  // a0<=a1 → 6 值模式：idx2..5 → (idx-1)*255/5 截断 = 51,102,153,204；idx6=0、idx7=255
  var idx = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
  var alpha = [0, 255].concat(idx3bytes(idx));
  var d = alpha.concat([0x00, 0x00, 0xFF, 0xFF]).concat(idx2bytes(rep([0], 16))); // 颜色索引 0 → c0=黑
  var out = S.decodeBC(new Uint8Array(d), 4, 4, BC3);
  var expect = [0, 255, 51, 102, 153, 204, 0, 255];
  for (var i = 0; i < 16; i++)
    assert.deepStrictEqual(px(out, i % 4, (i / 4) | 0, 4), [0, 0, 0, expect[i % 8]], 'BC3a idx=' + (i % 8));
});

test('BC3 alpha 8 值模式：a0=255>a1=0 逐索引', function () {
  // a0>a1 → 8 值模式：idx2..7 → (8-idx)*255/7 截断 = 218,182,145,109,72,36
  var idx = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
  var alpha = [255, 0].concat(idx3bytes(idx));
  var d = alpha.concat([0x00, 0x00, 0xFF, 0xFF]).concat(idx2bytes(rep([0], 16)));
  var out = S.decodeBC(new Uint8Array(d), 4, 4, BC3);
  var expect = [255, 0, 218, 182, 145, 109, 72, 36];
  for (var i = 0; i < 16; i++)
    assert.deepStrictEqual(px(out, i % 4, (i / 4) | 0, 4), [0, 0, 0, expect[i % 8]], 'BC3a8 idx=' + (i % 8));
});

// ---------------------------------------------------------------- BC4 UNORM
test('BC4_UNORM 8 值模式（r0=255>r1=0）逐索引，整数截断', function () {
  // (8-idx)*255/7 截断：idx2..7 → 218,182,145,109,72,36
  var idx = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
  var d = [255, 0].concat(idx3bytes(idx));
  var out = S.decodeBC(new Uint8Array(d), 4, 4, BC4U);
  var expect = [255, 0, 218, 182, 145, 109, 72, 36];
  for (var i = 0; i < 16; i++) {
    var v = expect[i % 8];
    assert.deepStrictEqual(px(out, i % 4, (i / 4) | 0, 4), [v, v, v, 255], 'BC4U idx=' + (i % 8));
  }
});

test('BC4_UNORM 6 值模式（r0=0<=r1=255）逐索引', function () {
  // idx0=0, idx1=255, idx2..5 = (6-idx)*0+(idx-1)*255 /5 → 51,102,153,204; idx6=0, idx7=255
  var idx = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
  var d = [0, 255].concat(idx3bytes(idx));
  var out = S.decodeBC(new Uint8Array(d), 4, 4, BC4U);
  var expect = [0, 255, 51, 102, 153, 204, 0, 255];
  for (var i = 0; i < 16; i++) {
    var v = expect[i % 8];
    assert.deepStrictEqual(px(out, i % 4, (i / 4) | 0, 4), [v, v, v, 255], 'BC4U idx=' + (i % 8));
  }
});

// ---------------------------------------------------------------- BC4 SNORM
test('BC4_SNORM 6 值模式权重正确（r0=129=-127 <= r1=127=+127）', function () {
  // f0=-1, f1=+1；idx2..5 → (f0*(6-idx)+f1*(idx-1))/5 = -0.6,-0.2,+0.2,+0.6
  // 显示映射 (v+1)*127.5 → 51,102,153,204（截断）
  // 回归：实现曾是 (5-idx)/5 → 76,127,178,229
  var idx = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
  var d = [129, 127].concat(idx3bytes(idx));
  var out = S.decodeBC(new Uint8Array(d), 4, 4, BC4S);
  var expect = [0, 255, 51, 102, 153, 204, 0, 255];
  for (var i = 0; i < 16; i++) {
    var v = expect[i % 8];
    assert.deepStrictEqual(px(out, i % 4, (i / 4) | 0, 4), [v, v, v, 255], 'BC4S idx=' + (i % 8));
  }
});

test('BC4_SNORM 8 值模式（r0=127 > r1=129）', function () {
  // f0=+1,f1=-1；(f0*(8-idx)+f1*(idx-1))/7 → idx2..7 = 5/7,3/7,1/7,-1/7,-3/7,-5/7
  // 显示：(v+1)*127.5 截断 → 218,182,145,109,72,36
  var idx = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
  var d = [127, 129].concat(idx3bytes(idx));
  var out = S.decodeBC(new Uint8Array(d), 4, 4, BC4S);
  var expect = [255, 0, 218, 182, 145, 109, 72, 36];
  for (var i = 0; i < 16; i++) {
    var v = expect[i % 8];
    assert.deepStrictEqual(px(out, i % 4, (i / 4) | 0, 4), [v, v, v, 255], 'BC4S8 idx=' + (i % 8));
  }
});

test('BC4_SNORM 端点 -128 钳到 -127（避免 f=-1.0078）', function () {
  var d = [128, 127].concat(idx3bytes(rep([0], 16)));
  allSamePixels(S.decodeBC(new Uint8Array(d), 4, 4, BC4S), [0, 0, 0, 255]);
});

// ---------------------------------------------------------------- BC5
test('BC5_UNORM 双通道：R 取第一块、G 取第二块、B=0、A=255', function () {
  var rBlk = [255, 0].concat(idx3bytes(rep([0], 16))); // R=255
  var gBlk = [0, 255].concat(idx3bytes(rep([7], 16))); // G=255（6 值模式 idx7）
  var out = S.decodeBC(new Uint8Array(rBlk.concat(gBlk)), 4, 4, BC5U);
  allSamePixels(out, [255, 255, 0, 255]);
});

test('BC5_SNORM 双通道各自走 SNORM 权重', function () {
  var rBlk = [129, 127].concat(idx3bytes(rep([2], 16))); // R: -0.6 → 51
  var gBlk = [127, 129].concat(idx3bytes(rep([2], 16))); // G: +5/7 → 218
  var out = S.decodeBC(new Uint8Array(rBlk.concat(gBlk)), 4, 4, BC5S);
  allSamePixels(out, [51, 218, 0, 255]);
});

// ---------------------------------------------------------------- 分派 / 格式识别
test('DXGI TYPELESS（73/76/79/82）按 UNORM 解码，不落空', function () {
  // detectFmt 认得 DXGI 73 = BC2_TYPELESS，但修前 decodeBC 的 dxgi 白名单没有 73 → 整块黑
  function dx10(dxgi, payload) {
    var b = new Uint8Array(148 + payload.length);
    b[84] = 68; b[85] = 88; b[86] = 49; b[87] = 48; // 'DX10'
    b[128] = dxgi & 255; b[129] = (dxgi >> 8) & 255;
    b.set(payload, 148);
    return b;
  }
  // 用真实的 detectFmt 走一遍识别
  var detected = S.detectFmt(dx10(73, new Uint8Array(16)));
  assert.strictEqual(detected.dxgi, 73);
  assert.strictEqual(detected.type, 'BC2_TYPELESS');
  assert.strictEqual(detected.family, 'BC3');
  assert.strictEqual(detected.isComp, true);

  function decodeAt(dxgi, payload, w, h) {
    var buf = dx10(dxgi, payload);
    var fmt = S.detectFmt(buf);
    return S.decodeBC(buf.subarray(148), w, h, fmt);
  }
  // BC2_TYPELESS：alpha 全 0 + 红色 c0=0xF800 → (255,0,0,0)
  var bc2 = [0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0xF8, 0x00, 0x00].concat(idx2bytes(rep([0], 16)));
  allSamePixels(decodeAt(73, bc2, 4, 4), [255, 0, 0, 0]);
  // BC3_TYPELESS：a0=255 + c0=0/c1=0xFFFF/idx3 → (170,170,170,255)
  var bc3 = [255, 0].concat(idx3bytes(rep([0], 16))).concat([0, 0, 0xFF, 0xFF]).concat(idx2bytes(rep([3], 16)));
  allSamePixels(decodeAt(76, bc3, 4, 4), [170, 170, 170, 255]);
  // BC4_TYPELESS → 灰阶 255
  var bc4 = [255, 0].concat(idx3bytes(rep([0], 16)));
  allSamePixels(decodeAt(79, bc4, 4, 4), [255, 255, 255, 255]);
  // BC5_TYPELESS：R=255 G=255
  var bc5 = [255, 0].concat(idx3bytes(rep([0], 16))).concat([0, 255]).concat(idx3bytes(rep([7], 16)));
  allSamePixels(decodeAt(82, bc5, 4, 4), [255, 255, 0, 255]);
  // SRGB 变体（75/78）与 UNORM 同布局
  allSamePixels(decodeAt(75, bc2, 4, 4), [255, 0, 0, 0]);
  allSamePixels(decodeAt(78, bc3, 4, 4), [170, 170, 170, 255]);
});

test('不支持的类型必须抛错，不得伪装成功', function () {
  var d = new Uint8Array(16);
  assert.throws(function () { S.decodeBC(d, 4, 4, { type: 'R8G8B8A8_UNORM', family: 'RGBA8', isComp: false, bpp: 32 }); }, /unsupported compressed format/);
  assert.throws(function () { S.decodeBC(d, 4, 4, { type: 'BC7_UNORM', family: 'BC7', isComp: true }); }, /unsupported compressed format/);
  assert.throws(function () { S.decodeBC(d, 4, 4, {}); }, /unsupported compressed format/);
});

// ---------------------------------------------------------------- 尺寸/采样
test('非 4 倍数尺寸：只写有效像素，块足量读取', function () {
  // 5×3 BC1：需要 2 个块（nbw=2, nbh=1）
  var blk0 = [0x00, 0x00, 0xFF, 0xFF].concat(idx2bytes(rep([3], 16))); // 透明黑
  var blk1 = [0xFF, 0xFF, 0x00, 0x00].concat(idx2bytes(rep([0], 16))); // 白
  var out = S.decodeBC(new Uint8Array(blk0.concat(blk1)), 5, 3, BC1);
  assert.strictEqual(out.length, 5 * 3 * 4);
  assert.deepStrictEqual(px(out, 0, 0, 5), [0, 0, 0, 0]);
  assert.deepStrictEqual(px(out, 4, 0, 5), [255, 255, 255, 255]); // 第 2 块
  assert.deepStrictEqual(px(out, 4, 2, 5), [255, 255, 255, 255]);
});

test('step 抽样：输出尺寸 ceil(w/step)，取到正确像素', function () {
  // 8×8：4 个块，全部白色 4 色模式
  var blk = [0xFF, 0xFF, 0x00, 0x00].concat(idx2bytes(rep([0], 16)));
  var data = new Uint8Array(blk.concat(blk, blk, blk));
  var out = S.decodeBC(data, 8, 8, BC1, 2);
  assert.strictEqual(out.length, 4 * 4 * 4);
  assert.deepStrictEqual(Array.from(out), rep([255, 255, 255, 255], 16));
  var out3 = S.decodeBC(data, 8, 8, BC1, 3); // ceil(8/3)=3
  assert.strictEqual(out3.length, 3 * 3 * 4);
  assert.deepStrictEqual(Array.from(out3), rep([255, 255, 255, 255], 9));
  assert.deepStrictEqual(Array.from(S.decodeBC(data, 8, 8, BC1, 1)), rep([255, 255, 255, 255], 64));
});

test('BC 块尺寸：BC1/BC4 走 8 字节、BC2/BC3/BC5 走 16 字节', function () {
  // 2×1 块排列：若块尺寸算错，第二块会读到错误偏移 → 颜色不对
  // 1×2 块网格（w=4,h=8）BC4：块 stride 8
  var g0 = [255, 0].concat(idx3bytes(rep([0], 16))); // 255
  var g1 = [0, 0].concat(idx3bytes(rep([0], 16)));   // 0
  var out = S.decodeBC(new Uint8Array(g0.concat(g1)), 4, 8, BC4U);
  assert.deepStrictEqual(px(out, 0, 0, 4), [255, 255, 255, 255]);
  assert.deepStrictEqual(px(out, 0, 4, 4), [0, 0, 0, 255]);
});

// ---------------------------------------------------------------- 运行
var pass = 0, fail = 0;
for (var i = 0; i < tests.length; i++) {
  try { tests[i].fn(); pass++; console.log('  ok  ' + tests[i].name); }
  catch (e) { fail++; console.log('  FAIL ' + tests[i].name + '\n       ' + (e && e.message)); }
}
console.log('\ntest-dds-codec: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
else console.log('dds-codec tests passed');
