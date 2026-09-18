// scripts/cdp/thumb_check.js — 列表页缩略图「渲染 + 缓存」回归
//
// 断言：
//   1. 冷启动：DDS/EXR 缩略图渲染成 canvas（数量达到预期）、缓存条目写入
//   2. 刷新：命中缓存 → 0 个 .dds 请求、耗时骤降、canvas 数量不变
//   3. 画面一致：解码版与缓存版逐图 RGB 均值差 ≤ 6（缓存走 WebP 有损编码，不能比像素哈希）
//
// 用法：node scripts/cdp/thumb_check.js <页面URL> [DDS/EXR 缩略图数]
const { openPage, sleep } = require('./cdp');

const URL_ = process.argv[2];
const EXPECT_THUMBS = +(process.argv[3] || 16);

const PATCH = `(function () {
  window.__req = { dds: 0, json: 0 };
  var orig = window.fetch;
  window.fetch = function () {
    var u = String(arguments[0]);
    if (/\\.dds$/i.test(u)) window.__req.dds++;
    else if (/\\.json$/i.test(u)) window.__req.json++;
    return orig.apply(this, arguments);
  };
})();`;

// 每张缩略图：尺寸 + RGB 均值
const SIG = `(function () {
  var out = [];
  document.querySelectorAll('canvas.thumb-canvas').forEach(function (cv) {
    var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    var r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < d.length; i += 4 * 97) { r += d[i]; g += d[i+1]; b += d[i+2]; n++; }
    out.push([cv.width, cv.height, Math.round(r/n), Math.round(g/n), Math.round(b/n)]);
  });
  return JSON.stringify(out);
})()`;

async function measure(page) {
  const t0 = Date.now();
  let n = 0;
  for (let i = 0; i < 240; i++) {          // 最多等 60s
    n = await page.evaluate(`document.querySelectorAll('canvas.thumb-canvas').length`);
    if (n >= EXPECT_THUMBS) break;
    await sleep(250);
  }
  return { ms: Date.now() - t0, canvases: n };
}

(async () => {
  const page = await openPage(URL_, { initScript: PATCH });
  const fails = [];
  const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails.push(msg); };
  try {
    console.log('[加载 1] 冷启动（无缓存）');
    const first = await measure(page);
    await sleep(3000);                     // 等 blob 编码 + c.put 落盘
    const req1 = await page.evaluate(`JSON.stringify(window.__req)`);
    const sig1 = await page.evaluate(SIG);
    const cacheN = await page.evaluate(`caches.open('blog-thumb-v1').then(function(c){ return c.keys(); }).then(function(k){ return k.length; })`);
    console.log(`  耗时 ${(first.ms/1000).toFixed(1)}s，canvas ${first.canvases} 个，请求 ${req1}，缓存条目 ${cacheN}`);

    console.log('[加载 2] 刷新（应命中缓存）');
    await page.evaluate(`location.reload(); 1`);
    await sleep(600);
    const second = await measure(page);
    const req2 = JSON.parse(await page.evaluate(`JSON.stringify(window.__req)`));
    const sig2 = await page.evaluate(SIG);
    console.log(`  耗时 ${(second.ms/1000).toFixed(1)}s，canvas ${second.canvases} 个，请求 ${JSON.stringify(req2)}`);

    check(second.canvases === first.canvases, `刷新后 canvas 数量一致（${first.canvases} → ${second.canvases}）`);
    check(req2.dds === 0, `刷新后没有再下载 .dds（${req2.dds} 个）`);
    check(cacheN >= EXPECT_THUMBS, `缓存条目数 ≥ ${EXPECT_THUMBS}（实际 ${cacheN}）`);
    check(second.ms < first.ms / 3, `刷新耗时骤降（${(first.ms/1000).toFixed(1)}s → ${(second.ms/1000).toFixed(1)}s）`);

    const A = JSON.parse(sig1), B = JSON.parse(sig2);
    check(A.length === B.length && A.length === first.canvases, `画面签名数量一致（${A.length} vs ${B.length}）`);
    let maxDiff = 0, worst = '';
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      if (A[i][0] !== B[i][0] || A[i][1] !== B[i][1]) { maxDiff = 999; worst = `#${i} 尺寸不一致`; break; }
      for (let c = 2; c < 5; c++) { const d = Math.abs(A[i][c] - B[i][c]); if (d > maxDiff) { maxDiff = d; worst = `#${i} 通道${c}`; } }
    }
    check(maxDiff <= 6, `解码版与缓存版画面一致（最大 RGB 均值差 ${maxDiff}${worst ? ', ' + worst : ''}）`);

    console.log(fails.length ? `\nRESULT: FAIL — ${fails.length} 项` : '\nRESULT: PASS — 缩略图渲染 + 缓存命中 + 画面一致');
    process.exitCode = fails.length ? 1 : 0;
  } finally {
    await page.close();
  }
})().catch(e => { console.error('ERROR', e); process.exit(2); });
