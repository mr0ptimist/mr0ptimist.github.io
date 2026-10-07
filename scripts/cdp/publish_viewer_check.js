'use strict';
const assert = require('assert/strict');
const { openPage, sleep } = require('./cdp.js');

(async function() {
  const buttonMode = process.argv[3] === '--button';
  const page = await openPage(process.argv[2], { waitSelector: buttonMode ? '#publish-local-btn' : '.channel-container' });
  try {
    if (buttonMode) {
      const result = await page.evaluate(`(async function() {
        var opened = '';
        window.open = function(url) { opened = url; };
        var button = document.getElementById('publish-local-btn');
        button.click();
        for (var i = 0; i < 100 && document.getElementById('lp-confirm').disabled; i++)
          await new Promise(resolve => setTimeout(resolve, 20));
        var counterpart = document.getElementById('counterpart-article-btn');
        var overlay = document.getElementById('publish-local-overlay');
        return { opened: opened, path: button.dataset.publishPath, panel: overlay.classList.contains('ps-open'),
          ready: !document.getElementById('lp-confirm').disabled, images: document.getElementById('lp-images').textContent,
          resolution: document.getElementById('lp-max-edge').value, budget: document.getElementById('lp-budget').textContent,
          sizeHint: document.getElementById('lp-budget').parentElement.textContent,
          existing: document.getElementById('lp-existing').textContent,
          existingBytes: Number(button.dataset.publishExistingBytes),
          status: document.getElementById('lp-status-text').textContent,
          counterpart: counterpart && counterpart.href, counterpartLabel: counterpart && counterpart.title };
      })()`);
      assert.equal(result.opened, '', 'Opening the panel creates no browser tab');
      assert.equal(result.panel, true);
      assert.equal(result.ready, true, result.status);
      assert.equal(result.images, '2 张 · 1 张转 PNG');
      assert.equal(result.resolution, '0');
      assert.ok(result.budget.startsWith('约 '));
      assert.ok(result.sizeHint.includes('未压缩数据量（上限参考）'));
      assert.equal(result.existingBytes, Number(process.argv[4]), 'Existing size must match the full published folder');
      assert.match(result.existing, /^\d+(\.\d+)? (B|KiB|MiB|GiB)$/);
      assert.ok(new URL(result.counterpart).pathname.startsWith('/posts/'));
      assert.equal(result.counterpartLabel, '打开公开版');
      await page.evaluate("document.getElementById('lp-cancel').click()");
      async function clickCounterpart(label) {
        await page.evaluate("document.getElementById('counterpart-article-btn').click()");
        for (let i = 0; i < 60; i++) {
          await sleep(100);
          const link = await page.evaluate(`(function() {
            var button = document.getElementById('counterpart-article-btn');
            return button && { label: button.title, href: button.href, url: location.href };
          })()`);
          if (link && link.label === label) return link;
        }
        throw new Error('Counterpart navigation did not reach ' + label);
      }
      const published = await clickCounterpart('打开本地版');
      assert.equal(published.url, result.counterpart);
      const local = await clickCounterpart('打开公开版');
      assert.equal(local.url, published.href);
      console.log(JSON.stringify(result));
      return;
    }
    let result;
    for (let i = 0; i < 60; i++) {
      result = await page.evaluate(`(function() {
        var container = document.querySelector('.channel-container');
        var canvas = container && container.querySelector('canvas');
        var meta = container && container.querySelector('.channel-meta');
        if (!canvas || !meta) return null;
        return { size: [canvas.width, canvas.height], pixel: Array.from(canvas.getContext('2d').getImageData(0, 0, 1, 1).data),
          sliders: container.querySelectorAll('input[type=range]').length, flip: canvas.style.transform,
          metadata: meta.textContent, errors: document.querySelectorAll('.image-error').length };
      })()`);
      if (result) break;
      await sleep(100);
    }
    assert.ok(result, 'PNG viewer must finish loading');
    assert.deepEqual(result.size, [2, 2]);
    assert.deepEqual(result.pixel, [255, 17, 33, 255], 'RGB under alpha=0 survives the published viewer');
    assert.equal(result.sliders, 0, 'PNG does not expose source mip/array controls');
    assert.equal(result.flip, 'scaleY(-1)', 'Sidecar flip is applied once');
    assert.ok(result.metadata.includes('通道说明'));
    const channels = await page.evaluate(`(function() {
      var container = document.querySelector('.channel-container');
      var canvas = container.querySelector('canvas');
      container.querySelector('[data-ch=A]').click();
      var alpha = Array.from(canvas.getContext('2d').getImageData(1, 0, 1, 1).data);
      container.querySelector('[data-ch=RGBA]').click();
      var rgba = Array.from(canvas.getContext('2d').getImageData(1, 0, 1, 1).data);
      return { alpha: alpha, rgba: rgba };
    })()`);
    assert.deepEqual(channels.alpha, [128, 128, 128, 255], 'Separate alpha preserves the original A channel');
    assert.equal(channels.rgba[3], 128);
    [9, 180, 44].forEach((value, i) => assert.ok(Math.abs(channels.rgba[i] - value) <= 1, 'RGBA uses straight RGB without multiplying it twice'));
    console.log(JSON.stringify(result));
  } finally { await page.close(); }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
