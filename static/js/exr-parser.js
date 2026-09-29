/**
 * exr-parser.js — OpenEXR scanline（仅 NO_COMPRESSION）解码器。
 * EXR.parse(buf) -> { w, h, pixels: Float32Array(w*h*4), channels } | null
 * EXR.toRGBA8(r) -> Uint8ClampedArray(w*h*4) | null
 * parse() 绝不抛异常（decode-worker.js 调用处没有 try/catch）：失败返回 null，原因写入
 * EXR.lastError，EXR.lastCode 为稳定前缀（测试按前缀断言）：not-exr / unsupported-* /
 * truncated-* / bad-attribute / missing-attribute / bad-chunk / too-large / internal-error。
 * 依赖 worker-shared.js 暴露的 self.ImageCodecShared.halfToFloat；classic script，
 * importScripts() 与 <script> 均可加载。
 */
var EXR = (function () {
  'use strict';

  var S = self.ImageCodecShared;
  if (!S) {
    throw new Error('exr-parser.js 需要先加载 worker-shared.js（self.ImageCodecShared 未定义）');
  }

  // 校验先于分配：声明了巨窗口的小文件必须快速拒绝，不尝试分配。
  var MAX_PIXELS = 33554432;

  var MAGIC = [0x76, 0x2f, 0x31, 0x01];

  var TYPE_BPP = [4, 2, 4];             // 0=UINT, 1=HALF, 2=FLOAT

  // 错误状态必须挂在 api 上，调用方读的是 EXR.lastError / EXR.lastCode。
  var api = {
    parse: null,
    toRGBA8: null,
    MAX_PIXELS: MAX_PIXELS,
    lastError: null,
    lastCode: null
  };

  function fail(code, msg) {
    api.lastCode = code;
    api.lastError = msg;
    return null;
  }

  function clearError() {
    api.lastError = null;
    api.lastCode = null;
  }

  function toBytes(input) {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer) {
      return new Uint8Array(input);
    }
    // TypedArray / DataView：必须尊重 byteOffset（不能对 input.buffer 整体切片）
    if (input && input.buffer && typeof input.byteLength === 'number') {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    return null;
  }

  function indexOfZero(bytes, from) {
    for (var i = from; i < bytes.length; i++) {
      if (bytes[i] === 0) return i;
    }
    return -1;
  }

  function latin1(bytes, from, to) {
    var s = '';
    for (var i = from; i < to; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // chlist: (name\0 pixelType:int32 pLinear:uchar reserved:3 xSampling:int32 ySampling:int32)* 0x00
  function parseChlist(bytes, dv, start, end) {
    var list = [];
    var p = start;
    while (true) {
      if (p >= end) return null;             // 未遇到 chlist 终止 0x00
      if (bytes[p] === 0) { p++; break; }
      var nameEnd = indexOfZero(bytes, p);
      if (nameEnd < 0 || nameEnd >= end) return null;
      var name = latin1(bytes, p, nameEnd);
      p = nameEnd + 1;
      if (p + 16 > end) return null;         // 条目固定 16 字节
      var type = dv.getInt32(p, true);
      var xSampling = dv.getInt32(p + 8, true);
      var ySampling = dv.getInt32(p + 12, true);
      p += 16;
      if (type < 0 || type >= TYPE_BPP.length) {
        return { bad: 'unsupported-pixel-type', detail: name + ' 的 pixelType=' + type };
      }
      if (xSampling !== 1 || ySampling !== 1) {
        return { bad: 'unsupported-sampling', detail: name + ' 的采样 ' + xSampling + '×' + ySampling };
      }
      list.push({ name: name, type: type, bpp: TYPE_BPP[type] });
    }
    if (p !== end) return null;              // 终止符后有多余字节：结构可疑
    return list;
  }

  // 通道 -> RGBA 槽位：名字末段（大小写不敏感）识别 R/G/B/A/Y，同名取文件序第一个；
  // 缺失的 R/G/B 按 Y→G→R→B 复制，无任何彩色通道时首个非 A 标量通道当灰度，缺失 A 默认 1。
  function mapChannels(list) {
    var direct = { R: -1, G: -1, B: -1, A: -1, Y: -1 };
    var i, k, c;
    for (i = 0; i < list.length; i++) {
      c = componentOf(list[i].name);
      if (c && direct[c] < 0) direct[c] = i;
    }
    var fallback = [direct.Y, direct.G, direct.R, direct.B];
    if (direct.R < 0 && direct.G < 0 && direct.B < 0 && direct.Y < 0) {
      for (i = 0; i < list.length; i++) {
        if (componentOf(list[i].name) !== 'A') { fallback[0] = i; break; }
      }
    }
    function pick() {
      for (var k2 = 0; k2 < fallback.length; k2++) {
        if (fallback[k2] >= 0) return fallback[k2];
      }
      return -1;
    }
    var src = {
      R: direct.R >= 0 ? direct.R : pick(),
      G: direct.G >= 0 ? direct.G : pick(),
      B: direct.B >= 0 ? direct.B : pick(),
      A: direct.A
    };
    var slotsOf = [];
    for (i = 0; i < list.length; i++) slotsOf.push([]);
    var keys = ['R', 'G', 'B', 'A'];
    var channelCount = 0;
    for (i = 0; i < list.length; i++) {
      for (k = 0; k < keys.length; k++) {
        if (src[keys[k]] === i) slotsOf[i].push(k);
      }
      if (slotsOf[i].length) channelCount++;
    }
    return { slotsOf: slotsOf, channelCount: channelCount };
  }

  function componentOf(name) {
    var n = String(name).toUpperCase();
    var dot = n.lastIndexOf('.');
    if (dot >= 0) n = n.slice(dot + 1);
    if (n === 'R' || n === 'G' || n === 'B' || n === 'A' || n === 'Y') return n;
    return '';
  }

  function parse(input) {
    clearError();
    try {
      return parseScanline(input);
    } catch (e) {
      // 兜底：绝不外抛
      return fail('internal-error', 'EXR 解析内部异常，已中止：' + (e && e.message ? e.message : String(e)));
    }
  }

  function parseScanline(input) {
    var bytes = toBytes(input);
    if (!bytes) {
      return fail('not-exr', 'EXR.parse 需要 ArrayBuffer 或 TypedArray/DataView，实得 ' +
        Object.prototype.toString.call(input));
    }
    var len = bytes.length;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    var i;

    if (len < 8) {
      return fail('not-exr', 'EXR 文件长度 ' + len + ' 字节，不足 8 字节（magic + version）');
    }
    for (i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) return fail('not-exr', '不是 OpenEXR 文件（magic 不匹配）');
    }

    var version = dv.getUint32(4, true);
    if ((version & 0xff) !== 2) {
      return fail('unsupported-version', '不支持的 EXR 版本号 ' + (version & 0xff) + '（本解码器仅支持版本 2）');
    }
    if (version & 0x200) return fail('unsupported-tiled', '不支持 tiled（分块）EXR 文件');
    if (version & 0x800) return fail('unsupported-version', '不支持 deep 数据 EXR 文件');
    if (version & 0x1000) return fail('unsupported-version', '不支持 multipart EXR 文件');
    // 0x400 = 长名字标志可接受；其余未知标志位忽略（不改变 scanline 布局）。

    // header: name\0 type\0 int32 size value，单个 0x00 结束
    var pos = 8;
    var channels = null, compression = null, dataWindow = null, lineOrder = 0, typeAttr = '';
    while (true) {
      if (pos >= len) return fail('truncated-header', 'header 未找到终止符（文件在 header 内被截断）');
      if (bytes[pos] === 0) { pos++; break; }

      var nameEnd = indexOfZero(bytes, pos);
      if (nameEnd < 0) return fail('truncated-header', '属性名缺少结束符 0x00');
      var attrName = latin1(bytes, pos, nameEnd);
      pos = nameEnd + 1;

      var typeEnd = indexOfZero(bytes, pos);
      if (typeEnd < 0) return fail('truncated-header', '属性 ' + attrName + ' 的类型名缺少结束符');
      var attrType = latin1(bytes, pos, typeEnd);
      pos = typeEnd + 1;

      if (pos + 4 > len) return fail('truncated-header', '属性 ' + attrName + ' 的 size 字段被截断');
      var attrSize = dv.getInt32(pos, true);
      pos += 4;
      if (attrSize < 0 || pos + attrSize > len) {
        return fail('truncated-header',
          '属性 ' + attrName + ' 声明 ' + attrSize + ' 字节，超出文件剩余 ' + (len - pos) + ' 字节');
      }
      var vend = pos + attrSize;

      if (attrName === 'channels' && attrType === 'chlist') {
        var cl = parseChlist(bytes, dv, pos, vend);
        if (cl === null) {
          return fail('bad-attribute', 'channels 属性结构非法（chlist 缺终止符或条目越界）');
        }
        if (cl.bad) return fail(cl.bad, '不支持的通道：' + cl.detail);
        channels = cl;
      } else if (attrName === 'compression' && attrType === 'compression') {
        if (attrSize < 1) return fail('bad-attribute', 'compression 属性长度不足 1 字节');
        compression = bytes[pos];
      } else if (attrName === 'dataWindow' && attrType === 'box2i') {
        if (attrSize < 16) return fail('bad-attribute', 'dataWindow 属性长度不足 16 字节');
        dataWindow = [dv.getInt32(pos, true), dv.getInt32(pos + 4, true),
                      dv.getInt32(pos + 8, true), dv.getInt32(pos + 12, true)];
      } else if (attrName === 'lineOrder' && attrType === 'lineOrder') {
        if (attrSize >= 1) lineOrder = bytes[pos];
      } else if (attrName === 'type' && attrType === 'string') {
        typeAttr = latin1(bytes, pos, vend);
      }
      pos = vend; // 未知属性按其声明长度跳过（已做边界校验）
    }

    if (!channels || !channels.length) {
      return fail('missing-attribute', channels ? 'channels 属性为空（没有任何通道）' : '缺少必需的 channels 属性');
    }
    if (dataWindow === null) return fail('missing-attribute', '缺少必需的 dataWindow 属性');
    if (compression === null) return fail('missing-attribute', '缺少必需的 compression 属性');

    if (typeAttr && typeAttr !== 'scanlineimage') {
      if (typeAttr === 'tiledimage' || typeAttr === 'deeptile') {
        return fail('unsupported-tiled', 'type 属性声明为 ' + typeAttr + '（分块文件）');
      }
      return fail('unsupported-version', '不支持的文件类型 type=' + typeAttr);
    }
    if (compression !== 0) {
      return fail('unsupported-compression',
        '不支持 compression=' + compression + '（本解码器只支持 NO_COMPRESSION(0)）');
    }
    if (lineOrder === 2) return fail('unsupported-line-order', '不支持 RANDOM_Y 随机行序');
    if (lineOrder !== 0 && lineOrder !== 1) {
      return fail('bad-attribute', 'lineOrder 取值非法：' + lineOrder);
    }

    var xMin = dataWindow[0], yMin = dataWindow[1], xMax = dataWindow[2], yMax = dataWindow[3];
    var w = xMax - xMin + 1;
    var h = yMax - yMin + 1;
    if (!(w > 0) || !(h > 0)) {
      return fail('bad-attribute',
        'dataWindow 非法/空：[' + xMin + ',' + yMin + ',' + xMax + ',' + yMax + '] -> ' + w + '×' + h);
    }
    // 巨窗口必须快速拒绝，不得先分配
    if (w * h > MAX_PIXELS) {
      return fail('too-large', '图像 ' + w + '×' + h + ' 超过本解码器上限 ' + MAX_PIXELS + ' 像素');
    }

    // 每行 = 各通道按 chlist 顺序排列的 w 个采样
    var list = channels;
    var map = mapChannels(list);
    var rowBytes = 0;
    for (i = 0; i < list.length; i++) rowBytes += list[i].bpp * w;

    // offset table: h 个 uint64（小端），低 32 位为文件内绝对偏移
    var tableStart = pos;
    var tableEnd = tableStart + h * 8;
    if (len < tableEnd) {
      return fail('truncated-offset-table',
        '偏移表需要 ' + (h * 8) + ' 字节，文件仅剩 ' + (len - tableStart) + ' 字节');
    }

    var rowOffset = new Array(h);
    var seen = new Array(h);
    for (i = 0; i < h; i++) { rowOffset[i] = -1; seen[i] = false; }
    for (i = 0; i < h; i++) {
      var e = tableStart + i * 8;
      var lo = dv.getUint32(e, true);
      var hi = dv.getUint32(e + 4, true);
      if (hi !== 0) return fail('bad-chunk', '偏移表第 ' + i + ' 项高 32 位非 0（超过 4 GiB，不支持）');
      if (lo < tableEnd || lo + 8 > len) {
        return fail('bad-chunk', '偏移表第 ' + i + ' 项 ' + lo + ' 越界（表结束于 ' + tableEnd + '，文件长 ' + len + '）');
      }
      var cy = dv.getInt32(lo, true);
      var dataSize = dv.getInt32(lo + 4, true);
      if (cy < yMin || cy > yMax) {
        return fail('bad-chunk', '行块 y=' + cy + ' 不在 dataWindow [' + yMin + ',' + yMax + '] 内');
      }
      if (dataSize !== rowBytes) {
        return fail('bad-chunk', '行块 y=' + cy + ' 数据长度 ' + dataSize + '，期望 ' + rowBytes + '（w=' + w + ' 的未压缩行）');
      }
      if (lo + 8 + dataSize > len) {
        return fail('bad-chunk', '行块 y=' + cy + ' 数据越界（需要到 ' + (lo + 8 + dataSize) + '，文件长 ' + len + '）');
      }
      var r = cy - yMin;
      if (seen[r]) return fail('bad-chunk', '行 y=' + cy + ' 出现重复行块');
      seen[r] = true;
      rowOffset[r] = lo + 8;
    }
    for (i = 0; i < h; i++) {
      if (!seen[i]) return fail('bad-chunk', '缺少行 y=' + (yMin + i) + ' 的行块（共 ' + h + ' 行）');
    }

    // 全部校验通过后才分配输出（try/catch 兜住内存失败）
    var pixels;
    try {
      pixels = new Float32Array(w * h * 4);
    } catch (memErr) {
      return fail('too-large', '分配 ' + w + '×' + h + ' RGBA float 输出失败：' +
        (memErr && memErr.message ? memErr.message : String(memErr)));
    }
    for (i = 3; i < pixels.length; i += 4) pixels[i] = 1; // A 缺省 1.0（不透明）

    var slotsOf = map.slotsOf;
    for (var row = 0; row < h; row++) {
      var srcPos = rowOffset[row];
      var dstRow = row * w * 4;
      for (var ci = 0; ci < list.length; ci++) {
        var ch = list[ci];
        var slots = slotsOf[ci];
        if (!slots.length) { srcPos += ch.bpp * w; continue; } // 未识别通道：只跳过数据
        for (var x = 0; x < w; x++) {
          var v;
          if (ch.type === 1) v = S.halfToFloat(dv.getUint16(srcPos, true));
          else if (ch.type === 2) v = dv.getFloat32(srcPos, true);
          else v = dv.getUint32(srcPos, true); // UINT32：超出 float 精度会损失（已知且文档化）
          srcPos += ch.bpp;
          var base = dstRow + x * 4;
          for (var k = 0; k < slots.length; k++) pixels[base + slots[k]] = v;
        }
      }
    }

    clearError();
    return {
      w: w, h: h,
      pixels: pixels,
      channels: map.channelCount,
      dataWindow: { xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax },
      compression: 'none',
      lineOrder: lineOrder === 1 ? 'decreasing' : 'increasing'
    };
  }

  // 逐分量（alpha 除外）：NaN / +Infinity / ≤0 -> 0，否则 Reinhard + 1/2.2 gamma（1.0 -> 186）
  function toneMap(v) {
    if (v !== v || v === Infinity || v <= 0) return 0;
    return to8(Math.pow(v / (v + 1), 1 / 2.2));
  }

  function alpha8(v) {
    if (v !== v) return 255;                // NaN -> 不透明
    if (v <= 0) return 0;
    if (v >= 1) return 255;                 // 含 +Infinity
    return to8(v);                          // alpha 是线性覆盖度，不做 tone map / gamma
  }

  function to8(v) {
    return v >= 1 ? 255 : Math.round(v * 255);
  }

  function toRGBA8(exr) {
    try {
      if (!exr || !exr.pixels || !(exr.w > 0) || !(exr.h > 0)) return null;
      var n = exr.w * exr.h;
      if (exr.pixels.length < n * 4) return null;
      var src = exr.pixels;
      var out = new Uint8ClampedArray(n * 4);
      for (var i = 0, o = 0; i < n; i++, o += 4) {
        var b = i * 4;
        out[o] = toneMap(src[b]);
        out[o + 1] = toneMap(src[b + 1]);
        out[o + 2] = toneMap(src[b + 2]);
        out[o + 3] = alpha8(src[b + 3]);
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  api.parse = parse;
  api.toRGBA8 = toRGBA8;
  return api;
})();
