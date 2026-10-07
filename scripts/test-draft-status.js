'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function check(mode) {
  function element() {
    return { events: {}, disabled: false, textContent: '',
      addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; } };
  }
  const fields = Object.fromEntries(['.draft-article-title', '.draft-confirm', '.draft-cancel', '.draft-status-message'].map(name => [name, element()]));
  let button, dialog, requests = [], reloads = 0;
  const hint = { innerHTML: '<svg></svg>', replaceWith(value) { button = value; } };
  const article = 'content/protect/group/post/index.md';
  const document = {
    currentScript: { getAttribute(name) { return name === 'data-service' ? 'http://127.0.0.1:1314' : article; } },
    querySelector(selector) { return selector.includes('.entry-hint') ? hint : { textContent: '文章标题' }; },
    createElement(tag) {
      const value = element();
      if (tag === 'dialog') { dialog = value; value.querySelector = selector => fields[selector]; }
      return value;
    }, body: { appendChild() {} }
  };
  const context = { document, location: { protocol: 'http:', reload() { reloads++; } },
    setTimeout(fn) { fn(); }, TypeError,
    async fetch(url, options) {
      requests.push({ url, options });
      if (url.endsWith('/session')) return { ok: true, json: async () => ({ token: 'token', remove_draft: mode !== 'legacy' }) };
      assert.equal(fields['.draft-confirm'].disabled, true);
      return { ok: mode !== 'failure', json: async () => mode === 'failure' ? { error: '文章被占用' } : { draft: false, changed: true } };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/draft-status.js'), 'utf8'), context);
  button.events.click();
  assert.equal(dialog.open, true);
  assert.equal(fields['.draft-article-title'].textContent, '文章标题');
  fields['.draft-cancel'].events.click();
  assert.equal(dialog.open, false);
  assert.equal(requests.length, 0);
  button.events.click();
  await fields['.draft-confirm'].events.click();
  if (mode === 'success') {
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(requests[1].options.headers['X-GithubIO-Publish-Token'], 'token');
    assert.equal(JSON.parse(requests[1].options.body).article, article);
    assert.equal(reloads, 1);
  } else {
    assert.equal(reloads, 0);
    assert.equal(fields['.draft-confirm'].disabled, false);
    assert.match(fields['.draft-status-message'].textContent, mode === 'legacy' ? /重新运行/ : /文章被占用/);
    if (mode === 'legacy') assert.equal(requests.length, 1);
  }
}
(async () => {
  for (const mode of ['success', 'legacy', 'failure']) await check(mode);
  console.log('PASS: draft dialog cancel, confirmation, refresh, legacy service and error feedback');
})().catch(error => { console.error(error); process.exitCode = 1; });
