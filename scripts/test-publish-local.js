'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function check(existingBytes, selected = 'public', supported = ['public', 'protect'], resumed = false) {
  const articlePath = 'D:/GithubIO/content/local/Endfield/文章 空格/index.md';
  const previewPath = '/' + (selected === 'protect' ? 'protect' : 'posts') + '/endfield/public-entry/';
  const listeners = {}, opened = [], fields = {};
  let modal, navigations = 0, publishRequests = 0, jobPolls = 0, finishJob;
  const jobFinished = new Promise(resolve => { finishJob = resolve; });
  const storage = new Map();
  const pendingKey = 'local-publish:' + articlePath.toLowerCase();
  if (resumed) storage.set(pendingKey, JSON.stringify({ id: 'test-job', edge: 1024, destination: selected }));
  const service = 'http://127.0.0.1:1314';
  let destination = 'http://localhost:1313/local/endfield/local-entry/';
  const location = {
    origin: 'http://localhost:1313',
    get href() { return destination; },
    set href(url) { destination = url; navigations++; }
  };
  function element() {
    const events = {}, classes = new Set();
    return { events, value: '0', disabled: false, textContent: '', style: {},
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } },
      addEventListener(event, listener) { events[event] = listener; }, focus() {} };
  }
  const button = Object.assign(element(), {
    title: '发布到公开文章',
    getAttribute(name) { return ({'data-publish-path': articlePath, 'data-publish-preview': '/posts/endfield/public-entry/', 'data-publish-service': service,
      'data-publish-existing-bytes': existingBytes, 'data-publish-protect-existing-bytes': '5242880',
      'data-publish-protect-preview': '/protect/endfield/public-entry/'})[name] || null; },
    addEventListener(event, listener) { listeners[event] = listener; }
  });
  const textureUrl = 'http://localhost:1313/local/endfield/source-bundle/images/map.dds';
  const files = [{ name: 'images/map.dds', bytes: 500, url: textureUrl }, { name: 'images/map.json', bytes: 20 },
                 { name: 'index.md', bytes: 100 }, { name: 'context.json', bytes: 30 }];
  const dds = new ArrayBuffer(148), header = new DataView(dds);
  header.setUint32(0, 0x20534444, true); header.setUint32(12, 2160, true); header.setUint32(16, 3840, true);
  const image = { src: textureUrl };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/publish-local.js'), 'utf8'), {
    document: {
      getElementById(id) { return id === 'publish-local-btn' ? button : { textContent: JSON.stringify(files) }; },
      querySelectorAll(selector) { return selector.includes('img') ? [image, image] : []; },
      createElement() {
        modal = element();
        modal.querySelector = selector => fields[selector] || (fields[selector] = element());
        return modal;
      },
      addEventListener() {},
      body: { appendChild() {} }
    },
    fetch: async (url, opts) => {
      if (url === service + '/session') return { ok: true, json: async () => Object.assign({ token: 'test-token' }, supported ? { destinations: supported } : {}) };
      if (url === service + '/publish') {
        publishRequests++;
        assert.equal(opts.method, 'POST');
        assert.equal(opts.headers['X-GithubIO-Publish-Token'], 'test-token');
        assert.deepEqual(JSON.parse(opts.body), { article: articlePath, max_edge: 1024, destination: selected });
        return { ok: true, json: async () => ({ id: 'test-job', state: 'running' }) };
      }
      if (url === service + '/jobs/test-job') {
        if (!jobPolls++) return { ok: true, json: async () => ({ state: 'running', message: '已完成 1 / 1 张：images/map.dds',
          progress: {phase: 'textures', completed: 1, total: 1, file: 'images/map.dds'} }) };
        await jobFinished;
        return { ok: true, json: async () => ({ state: 'succeeded', result: {converted: 1, output_bytes: 4096, destination: selected, preview_url: location.origin + previewPath} }) };
      }
      if (url.startsWith(location.origin + previewPath)) return { ok: true };
      assert.equal(url, image.src);
      assert.equal(opts.headers.Range, 'bytes=0-147');
      return { status: 206, arrayBuffer: async () => dds };
    },
    window: { location, open(url, target) { opened.push({ url, target }); }, sessionStorage: {
      getItem(key) { return storage.get(key) || null; }, setItem(key, value) { storage.set(key, value); }, removeItem(key) { storage.delete(key); }
    } }, console: { info() {}, error() {} },
    location, URL, JSON, Map, Set, Promise, DataView, Uint8Array, TextDecoder, encodeURIComponent, decodeURIComponent,
    AbortSignal,
    setTimeout(callback) { return setImmediate(callback); }
  });
  listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, 0, 'Opening publication settings must not create an untitled browser tab');
  assert.equal(navigations, 0, 'The top button only opens a preview; publication requires confirmation');
  assert.ok(modal.classList.contains('ps-open'));
  assert.equal(fields['#lp-images'].textContent, '1 张 · 1 张转 PNG');
  const existingSize = existingBytes === null ? '尚未生成' : '47.4 MiB';
  if (resumed) {
    assert.equal(fields['#lp-destination'].value, selected, 'Reload must restore the pending destination');
    assert.equal(fields['#lp-destination'].disabled, true);
    assert.equal(fields['#lp-max-edge'].value, '1024');
    assert.equal(publishRequests, 0, 'Reload must watch the existing job without generating another copy');
    finishJob();
    for (let i = 0; i < 20 && !navigations; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(destination, location.origin + previewPath);
    assert.equal(storage.has(pendingKey), false);
    return;
  }
  assert.equal(fields['#lp-destination'].value, 'public');
  assert.equal(fields['#lp-existing'].textContent, existingSize);
  fields['#lp-destination'].value = 'protect';
  fields['#lp-destination'].events.change();
  assert.equal(fields['#lp-path'].textContent, 'D:/GithubIO/content/protect/Endfield/文章 空格/');
  assert.equal(fields['#lp-existing'].textContent, '5.0 MiB');
  assert.ok(fields['#lp-existing-label'].textContent.includes('protect'));
  assert.ok(fields['#lp-warning'].textContent.includes('content/protect/'));
  if (!supported || !supported.includes('protect')) {
    assert.equal(fields['#lp-confirm'].disabled, true, 'An old service must not silently generate public when protect is selected');
    await fields['#lp-confirm'].events.click();
    assert.equal(publishRequests, 0);
  }
  fields['#lp-destination'].value = 'public';
  fields['#lp-destination'].events.change();
  assert.equal(fields['#lp-existing'].textContent, existingSize);
  assert.equal(fields['#lp-confirm'].disabled, false);
  fields['#lp-destination'].value = selected;
  fields['#lp-destination'].events.change();
  assert.doesNotMatch(modal.innerHTML, /预计发布体积/);
  const originalBudget = fields['#lp-budget'].textContent;
  assert.ok(originalBudget.startsWith('约 '));
  fields['#lp-max-edge'].value = '1024';
  fields['#lp-max-edge'].events.change();
  assert.notEqual(fields['#lp-budget'].textContent, originalBudget);
  assert.equal(fields['#lp-existing'].textContent, selected === 'protect' ? '5.0 MiB' : existingSize, 'Changing resolution must not relabel the previous publication as a forecast');
  const publication = fields['#lp-confirm'].events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(navigations, 0, 'Confirmation sends an HTTP request without navigating to a native protocol');
  assert.equal(publishRequests, 1);
  assert.equal(fields['#lp-confirm'].disabled, true);
  assert.equal(fields['#lp-destination'].disabled, true);
  assert.equal(JSON.parse(storage.get(pendingKey)).destination, selected);
  assert.ok(fields['#lp-status-text'].textContent.includes('1 / 1 张'));
  assert.equal(fields['#lp-progress'].value, 1);
  assert.equal(fields['#lp-progress'].max, 1);
  assert.equal(fields['#lp-progress'].hidden, false);
  fields['#lp-confirm'].events.click();
  assert.equal(publishRequests, 1);
  finishJob();
  await publication;
  assert.equal(destination, location.origin + previewPath);
  assert.equal(navigations, 1);
  assert.equal(fields['#lp-confirm'].disabled, false);
  assert.equal(fields['#lp-destination'].disabled, false);
  assert.equal(storage.has(pendingKey), false);
  assert.ok(fields['#lp-status-text'].textContent.includes('4.0 KiB'));
  assert.equal(opened.length, 0, 'Publication success opens the current tab');
  console.log('PASS settings, HTTP confirmation, observable publication result, deduplication, raw size reference, existing publication size, and no untitled tab');
}
(async function() {
  await check(null);
  await check('49681942');
  await check('49681942', 'protect');
  await check('49681942', 'public', null);
  await check('49681942', 'protect', ['public', 'protect'], true);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
