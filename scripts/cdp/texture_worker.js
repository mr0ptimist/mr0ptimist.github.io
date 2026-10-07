'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const zlib = require('zlib');
const { parentPort, workerData } = require('worker_threads');
const { openPage } = require('./cdp.js');

const JS_DIR = (workerData && workerData.jsDir) || path.resolve(__dirname, '../../static/js');

const sandbox = { console };
sandbox.self = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const name of ['worker-shared.js', 'dds-codec.js', 'exr-parser.js']) {
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, name), 'utf8'), sandbox, { filename: name });
}
const D = sandbox.ImageCodecDDS;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

function pngChunk(type, data) {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const bytes of [name, data]) for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, name, data, checksum]);
}

function encodePNG(pixels, w, h, channels = 4) {
  const samples = Buffer.from(pixels);
  if (samples.length !== w * h * channels) throw new Error('Decoded pixel count does not match dimensions');
  const stride = w * channels, rows = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const start = y * (stride + 1), src = y * stride;
    rows[start] = 1;
    for (let x = 0; x < stride; x++) rows[start + x + 1] = (samples[src + x] - (x >= channels ? samples[src + x - channels] : 0)) & 255;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4);
  header[8] = 8; header[9] = { 1: 0, 3: 2, 4: 6 }[channels];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function channelsFor(dds) {
  const type = dds.fmt.type || '', family = dds.fmt.family || '';
  if (/^(BC4|R8S?|R16S?|R16F|R32F|D32S8)$/.test(family) || /^[RD]\d+_/.test(type)) return 'R';
  if (/^(BC5|R8G8S?|R16G16S?|R16G16F|R32G32F)$/.test(family) || /^R\d+G\d+_/.test(type)) return 'RG';
  if (dds.fmt.opaque || /B8G8R8X8|BC6H|R11G11B10|RGB9E5/.test(type + family)) return 'RGB';
  return /RGBA|A\d|BC[1237]|DXT[135]/.test(type + family) ? 'RGBA' : 'RGB';
}

let page = null, server = null, gpuBytes = null;

async function ensurePage() {
  if (page) return page;
  const scripts = ['worker-shared.js', 'dds-codec.js', 'dds-parser.js'];
  server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/texture') { res.end(gpuBytes); return; }
    const script = scripts.find(s => req.url === '/' + s);
    if (script) { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(JS_DIR, script))); return; }
    if (req.url !== '/') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8">' + scripts.map(s => '<script src="/' + s + '"></script>').join(''));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  page = await openPage('http://127.0.0.1:' + server.address().port + '/', { waitSelector: null });
  return page;
}

async function convertOne(item, maxEdge) {
  const bytes = fs.readFileSync(item.source);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let frame, format, channels;
  if (/\.dds$/i.test(item.source)) {
    const dds = D.parse(buf);
    if (!dds) throw new Error(item.source + ': ' + D.lastError);
    if (/TYPELESS/i.test((item.sidecar?.renderdoc || {}).format || '') && dds.fmt.family === 'R16F') {
      dds.fmt.type = 'R16_UNORM'; dds.fmt.family = 'R16';
    }
    format = dds.fmt.type;
    channels = channelsFor(dds);
    if (dds.fmt.family === 'BC6H' || dds.fmt.family === 'BC7') {
      gpuBytes = bytes;
      const gpuPage = await ensurePage();
      const decoded = await gpuPage.evaluate(`(async function() {
        var dds = DDS.parse(await (await fetch('/texture')).arrayBuffer());
        var frame = dds && dds.getFrame(0, 0, 1);
        if (!frame) throw new Error(DDS.lastError || 'GPU texture decoding failed');
        var chunks = [];
        for (var i = 0; i < frame.pixels.length; i += 32768)
          chunks.push(String.fromCharCode.apply(null, frame.pixels.subarray(i, i + 32768)));
        return { w: frame.w, h: frame.h, rgba: btoa(chunks.join('')), normMin: frame.normMin, normMax: frame.normMax };
      })()`);
      frame = { ...decoded, pixels: Buffer.from(decoded.rgba, 'base64') };
    } else {
      frame = D.decodeCPU(dds, 0, 0, 1);
      if (!frame) throw new Error(item.source + ': ' + D.lastError);
    }
  } else if (/\.exr$/i.test(item.source)) {
    const exr = sandbox.EXR.parse(new Uint8Array(buf));
    if (!exr) throw new Error(item.source + ': ' + sandbox.EXR.lastError);
    frame = D.fromRaw(exr.pixels, exr.w, exr.h, 3);
    frame.pixels = sandbox.EXR.toRGBA8(exr);
    format = 'OpenEXR'; channels = 'RGBA';
    if (!frame.pixels) throw new Error(item.source + ': EXR display conversion failed');
  } else throw new Error('Expected DDS or EXR: ' + item.source);
  if (channels === 'R') {
    for (let i = 1; i < frame.pixels.length; i += 4) { frame.pixels[i] = 0; frame.pixels[i + 1] = 0; }
  }
  const sourceWidth = frame.w, sourceHeight = frame.h;
  if (maxEdge && Math.max(frame.w, frame.h) > maxEdge) {
    const scale = maxEdge / Math.max(frame.w, frame.h);
    const w = Math.max(1, Math.round(frame.w * scale)), h = Math.max(1, Math.round(frame.h * scale));
    const pixels = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(frame.h - 1, Math.floor((y + 0.5) * frame.h / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(frame.w - 1, Math.floor((x + 0.5) * frame.w / w));
        const src = (sy * frame.w + sx) * 4, dst = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) pixels[dst + c] = frame.pixels[src + c];
      }
    }
    frame = { ...frame, w, h, pixels };
  }
  const rgb = Buffer.alloc(frame.w * frame.h * 3), alpha = Buffer.alloc(frame.w * frame.h);
  let hasAlpha = false;
  for (let i = 0, j = 0; i < frame.pixels.length; i += 4, j++) {
    rgb[j * 3] = frame.pixels[i]; rgb[j * 3 + 1] = frame.pixels[i + 1]; rgb[j * 3 + 2] = frame.pixels[i + 2];
    alpha[j] = frame.pixels[i + 3];
    if (alpha[j] !== 255) hasAlpha = true;
  }
  fs.writeFileSync(item.destination, encodePNG(rgb, frame.w, frame.h, 3));
  const alphaPath = item.destination.replace(/\.png$/i, '.alpha.png');
  if (hasAlpha) fs.writeFileSync(alphaPath, encodePNG(alpha, frame.w, frame.h, 1));
  return { source: item.source, destination: item.destination, width: frame.w, height: frame.h,
    source_width: sourceWidth, source_height: sourceHeight,
    alpha_file: hasAlpha ? path.basename(alphaPath) : null,
    format, channels, normMin: frame.normMin, normMax: frame.normMax, mip: 0, slice: 0 };
}

let busy = false, stopRequested = false, closed = false;

async function shutdown() {
  if (closed) return;
  closed = true;
  try { if (page) await page.close(); } catch (e) { }
  page = null;
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
  parentPort.close();
}

parentPort.on('message', async message => {
  if (!message) return;
  if (message.type === 'stop') {
    stopRequested = true;
    if (!busy) await shutdown();
    return;
  }
  if (message.type !== 'task' || busy || stopRequested) return;
  busy = true;
  try {
    const result = await convertOne(message.item, message.maxEdge);
    parentPort.postMessage({ type: 'done', index: message.index, source: message.item.source, result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', index: message.index, source: message.item.source,
      message: error && error.message ? error.message : String(error) });
  } finally {
    busy = false;
    if (stopRequested) await shutdown();
  }
});
