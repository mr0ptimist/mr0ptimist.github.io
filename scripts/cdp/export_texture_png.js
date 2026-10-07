'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const JS_DIR = path.resolve(__dirname, '../../static/js');
const WORKER_SCRIPT = path.join(__dirname, 'texture_worker.js');
const MAX_WORKERS = 4;
const SHUTDOWN_GRACE_MS = 10000;

function availableCPUs() {
  if (typeof os.availableParallelism === 'function') return os.availableParallelism();
  return os.cpus().length;
}

function resolveWorkerCount(manifest, total) {
  const requested = manifest.workers;
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_WORKERS) {
      throw new Error('Invalid texture worker count: expected integer 1-' + MAX_WORKERS);
    }
    return Math.min(requested, total);
  }
  if (!total) return 0;
  return Math.max(1, Math.min(MAX_WORKERS, availableCPUs(), total));
}

async function convert(manifest, options = {}) {
  if (!manifest || !Array.isArray(manifest.images)) throw new Error('Manifest images must be an array');
  const maxEdge = manifest.max_edge ?? 0;
  if (!Number.isInteger(maxEdge) || maxEdge < 0 || maxEdge > 16384) throw new Error('Invalid texture resolution limit');
  const images = manifest.images;
  const total = images.length;
  const workerCount = resolveWorkerCount(manifest, total);
  if (!workerCount) return { images: [], workers: 0 };

  const results = new Array(total);
  const pool = [];
  let next = 0, done = 0, failure = null, stopping = false;

  const stopAll = async () => {
    stopping = true;
    for (const slot of pool) { slot.stopSent = true; try { slot.worker.postMessage({ type: 'stop' }); } catch (e) { } }
    await Promise.all(pool.map(slot => new Promise(resolve => {
      const timer = setTimeout(() => { slot.worker.terminate().then(resolve, resolve); }, SHUTDOWN_GRACE_MS);
      slot.exited.then(() => { clearTimeout(timer); resolve(); });
    })));
  };

  let resolveJob, rejectJob;
  const job = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });

  const fail = async error => {
    if (failure) return;
    failure = error;
    await stopAll();
    rejectJob(error);
  };

  const dispatch = slot => {
    if (failure || stopping) return;
    if (next >= total) {
      slot.stopSent = true;
      try { slot.worker.postMessage({ type: 'stop' }); } catch (e) { }
      return;
    }
    const index = next++;
    slot.busy = index;
    try {
      slot.worker.postMessage({ type: 'task', index, item: images[index], maxEdge });
    } catch (e) {
      fail(e);
    }
  };

  for (let i = 0; i < workerCount; i++) {
    let worker;
    try {
      worker = new Worker(WORKER_SCRIPT, { workerData: { jsDir: JS_DIR } });
    } catch (error) {
      stopAll().then(() => rejectJob(error), () => rejectJob(error));
      return job;
    }
    const slot = { worker, busy: null, stopSent: false };
    slot.exited = new Promise(resolve => worker.once('exit', resolve));
    worker.on('message', message => {
      if (failure || stopping || !message) return;
      if (message.type === 'done' && message.index === slot.busy) {
        slot.busy = null;
        results[message.index] = message.result;
        done++;
        try {
          if (options.progress) options.progress({ event: 'texture', completed: done, total, source: message.source });
        } catch (error) {
          fail(error);
          return;
        }
        if (done === total) { stopAll().then(() => resolveJob({ images: results, workers: workerCount })); return; }
        dispatch(slot);
      } else if (message.type === 'error') {
        fail(new Error(message.message || 'Texture conversion failed'));
      }
    });
    worker.on('error', error => { fail(error); });
    worker.on('exit', code => {
      if (stopping || failure || done === total || slot.stopSent) return;
      fail(new Error('Texture worker exited before all textures completed (code ' + code + ')'));
    });
    pool.push(slot);
  }
  for (const slot of pool) dispatch(slot);
  return job;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const progress = process.argv.includes('--progress');
  const started = Date.now();
  const report = await convert(manifest, progress ? {
    progress(event) {
      process.stdout.write(JSON.stringify(event) + '\n');
    }
  } : {});
  console.error('PNG: ' + report.images.length + ' texture(s) via ' + report.workers + ' worker(s) in ' + (Date.now() - started) + 'ms');
  console.log(JSON.stringify(report));
}

module.exports = { convert, resolveWorkerCount };

if (require.main === module) {
  main().catch(e => { console.error(e.message || String(e)); process.exitCode = 1; });
}
