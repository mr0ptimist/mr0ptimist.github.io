'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exportModule = require(path.join(__dirname, 'cdp', 'export_texture_png.js'));
const convert = exportModule.convert;

function u32(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32LE(value >>> 0, index * 4));
  return buffer;
}

function rgbaDds(pixels, width, height) {
  const header = new Array(31).fill(0);
  Object.assign(header, { 0: 124, 1: 0x100f, 2: height, 3: width, 4: width * 4, 6: 1 });
  Object.assign(header, { 18: 32, 19: 0x41, 20: 0, 21: 32, 22: 0xff, 23: 0xff00, 24: 0xff0000, 25: 0xff000000 });
  header[26] = 0x1000;
  return Buffer.concat([Buffer.from('DDS ', 'ascii'), u32(header), Buffer.from(pixels)]);
}

function floatDds(width, height, seed) {
  const header = new Array(31).fill(0);
  Object.assign(header, { 0: 124, 1: 0x100f, 2: height, 3: width, 4: width * 4, 6: 1 });
  header[18] = 32; header[19] = 4; header[20] = 0x30315844; header[26] = 0x1000;
  const dx10 = Buffer.alloc(20);
  [41, 3, 0, 1, 0].forEach((value, index) => dx10.writeUInt32LE(value, index * 4));
  const pixels = Buffer.alloc(width * height * 4);
  let state = seed >>> 0;
  for (let i = 0; i < width * height; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    pixels.writeFloatLE((state / 4294967296) * 8 - 2, i * 4);
  }
  return Buffer.concat([Buffer.from('DDS ', 'ascii'), u32(header), dx10, pixels]);
}

let root;
function fixture(name, bytes) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function manifestFor(sources, workers) {
  const manifest = {
    max_edge: 0,
    images: sources.map((source, index) => ({
      source,
      destination: path.join(root, 'out-' + index + '.png'),
      sidecar: {}
    }))
  };
  if (workers !== undefined) manifest.workers = workers;
  return manifest;
}

async function timed(fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

async function main() {
  assert.strictEqual(typeof convert, 'function', 'export_texture_png.js must export convert(manifest, options)');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texture-pool-'));

  const smallPixels = [255, 17, 33, 0, 9, 180, 44, 128, 50, 60, 70, 255, 80, 90, 100, 255];
  const smallSources = [
    fixture('small/a.dds', rgbaDds(smallPixels, 2, 2)),
    fixture('small/b.dds', rgbaDds([...smallPixels].reverse(), 2, 2)),
    fixture('small/c.dds', rgbaDds(Array(16).fill(200), 2, 2))
  ];
  const serial = await convert(manifestFor(smallSources, 1), {});
  const serialBytes = serial.images.map(item => fs.readFileSync(item.destination));
  const serialAlpha = fs.readFileSync(path.join(root, 'out-0.alpha.png'));
  const parallel = await convert(manifestFor(smallSources, 2), {});
  assert.deepStrictEqual(parallel.images, serial.images, 'parallel metadata must match serial');
  parallel.images.forEach((item, index) => {
    assert.deepStrictEqual(fs.readFileSync(item.destination), serialBytes[index],
      'PNG bytes must match serial for ' + item.source);
  });
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'out-0.alpha.png')), serialAlpha,
    'packed alpha PNG bytes must match serial');
  assert.strictEqual(parallel.images[0].alpha_file, 'out-0.alpha.png', 'packed alpha PNG must be preserved');
  assert.ok(fs.existsSync(path.join(root, 'out-0.alpha.png')), 'alpha PNG must exist');

  assert.strictEqual(parallel.workers, 2, 'explicit workers=2 must be honored');
  assert.strictEqual(serial.workers, 1, 'explicit workers=1 must be honored');
  const cpus = Math.min(4, os.availableParallelism ? os.availableParallelism() : os.cpus().length);
  const dflt = await convert(manifestFor(smallSources), {});
  assert.ok(dflt.workers >= 1, 'default worker count must be positive');
  assert.ok(dflt.workers <= Math.min(4, cpus, smallSources.length), 'default workers must be bounded by CPU/image count');

  await assert.rejects(() => convert(manifestFor(smallSources, 0), {}), /worker/i, 'workers=0 must be rejected');
  await assert.rejects(() => convert(manifestFor(smallSources, 5), {}), /worker/i, 'workers=5 must be rejected');
  await assert.rejects(() => convert(manifestFor(smallSources, 1.5), {}), /worker/i, 'non-integer workers must be rejected');
  await assert.rejects(() => convert(manifestFor([], 0), {}), /worker/i, 'empty manifests must still validate worker bounds');
  assert.deepStrictEqual(await convert(manifestFor([]), {}), { images: [], workers: 0 });
  await assert.rejects(() => convert({ max_edge: 99999, images: [{ source: smallSources[0], destination: path.join(root, 'x.png') }] }, {}),
    /resolution/i, 'invalid max_edge must be rejected');

  const events = [];
  const ordered = await convert(manifestFor(smallSources, 2), { progress: event => events.push(event) });
  assert.strictEqual(events.length, smallSources.length, 'one completion event per texture');
  assert.deepStrictEqual(events.map(event => event.completed), [1, 2, 3], 'completed must be strictly increasing 1..N');
  assert.ok(events.every(event => event.event === 'texture' && event.total === smallSources.length), 'event shape');
  const sources = events.map(event => path.basename(event.source));
  assert.strictEqual(new Set(sources).size, sources.length, 'progress sources must be unique');
  assert.deepStrictEqual(new Set(sources), new Set(['a.dds', 'b.dds', 'c.dds']), 'progress sources must be accurate');
  assert.deepStrictEqual(ordered.images.map(item => path.basename(item.source)), ['a.dds', 'b.dds', 'c.dds'],
    'images must stay in input order despite out-of-order completion');

  const brokenSources = [smallSources[0], fixture('broken/bad.dds', Buffer.from('corrupt DDS'))];
  await assert.rejects(() => convert(manifestFor(brokenSources, 2), {}), /bad\.dds|贴图|decode|DDS/i,
    'corrupt texture must reject');
  await assert.rejects(() => convert(manifestFor(smallSources, 2), {
    progress() { throw new Error('Progress consumer failed'); }
  }), /Progress consumer failed/, 'progress errors must reject after workers stop');

  const cpuCount = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  if (cpuCount >= 2) {
    const heavy = [1, 2, 3, 4].map(seed => fixture('heavy/' + seed + '.dds', floatDds(1200, 1200, seed * 7919)));
    const serialRun = await timed(() => convert(manifestFor(heavy, 1), {}));
    const serialHeavyBytes = serialRun.value.images.map(item => fs.readFileSync(item.destination));
    const parallelRun = await timed(() => convert(manifestFor(heavy, 4), {}));
    assert.strictEqual(parallelRun.value.images.length, 4, 'heavy parallel run must complete all images');
    assert.deepStrictEqual(parallelRun.value.images, serialRun.value.images, 'float metadata must match');
    parallelRun.value.images.forEach((item, index) => {
      assert.deepStrictEqual(fs.readFileSync(item.destination), serialHeavyBytes[index], 'float PNG bytes must match');
    });
    const speedup = serialRun.ms / parallelRun.ms;
    console.log('speedup ' + speedup.toFixed(2) + 'x (serial ' + serialRun.ms.toFixed(0) + 'ms, parallel ' + parallelRun.ms.toFixed(0) + 'ms)');
  } else {
    console.log('skip overlap timing: only one CPU');
  }
  console.log('test-texture-pool: PASS');
}

const guard = setTimeout(() => {
  console.error('test-texture-pool: FAIL — worker pool did not settle (possible hang/orphan)');
  process.exit(1);
}, 180000);
guard.unref();

main().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
}, error => {
  console.error('test-texture-pool: FAIL — ' + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
