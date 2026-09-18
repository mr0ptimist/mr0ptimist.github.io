// scripts/cdp/tree_check.js — 列表页树形视图「分组守恒」回归
//
// 断言：JS 执行后，每个 <ul class="ptree-list"> 的直属文章集合，与其服务端渲染结果一致。
// 背景：sort-bar.js 曾用递归 querySelectorAll 抓全树文章、再整体 insertBefore 到排序第一名的
//       父 <ul>，导致所有分组塌进一个文件夹（列表页每次加载都会触发）。
//
// 用法：node scripts/cdp/tree_check.js <页面URL> <expected.json>
//       期望值由 python scripts/cdp/parse_expected.py <构建出的index.html> <out.json> 生成
const fs = require('fs');
const { openPage } = require('./cdp');

const URL_ = process.argv[2];
const EXPECTED = JSON.parse(fs.readFileSync(process.argv[3], 'utf-8'));

const CAPTURE = `(function () {
  var out = [];
  document.querySelectorAll('.ptree-list').forEach(function (ul) {
    var arts = [];
    for (var i = 0; i < ul.children.length; i++) {
      var c = ul.children[i];
      if (c.classList.contains('ptree-article')) {
        var t = c.querySelector('.ptree-title');
        arts.push(t ? t.textContent.trim() : '?');
      }
    }
    var li = ul.parentElement.closest('li.ptree-folder');
    var chain = [], node = li;
    while (node) {
      var n = node.querySelector('summary .ptree-name');
      chain.unshift(n ? n.textContent.trim() : '?');
      node = node.parentElement.closest('li.ptree-folder');
    }
    out.push({ path: chain.join('/'), articles: arts });
  });
  return JSON.stringify(out);
})()`;

(async () => {
  const page = await openPage(URL_);
  try {
    const actual = JSON.parse(await page.evaluate(CAPTURE));
    const show = rows => rows.map(r => `  ${r.path || '<ROOT>'} (${r.articles.length})`).join('\n');
    console.log(`=== 期望（服务端渲染）— ${EXPECTED.length} 个列表 ===\n${show(EXPECTED)}`);
    console.log(`=== 实际（JS 执行后的 DOM）— ${actual.length} 个列表 ===\n${show(actual)}`);

    let bad = 0;
    for (const e of EXPECTED) {
      const a = actual.find(x => (x.path || '') === (e.path || ''));
      if (!a) { console.log(`\n!! DOM 中缺失：${e.path || '<ROOT>'}`); bad++; continue; }
      const sE = [...e.articles].sort().join('|'), sA = [...a.articles].sort().join('|');
      if (sE !== sA) {
        bad++;
        console.log(`\n!! 集合被破坏：${e.path || '<ROOT>'}`);
        console.log(`   期望 (${e.articles.length}): ${e.articles.map(t => t.slice(0, 26)).join(' ; ')}`);
        console.log(`   实际 (${a.articles.length}): ${a.articles.map(t => t.slice(0, 26)).join(' ; ')}`);
      }
    }
    console.log(bad ? `\nRESULT: FAIL — ${bad}/${EXPECTED.length} 个列表丢失/吸收了文章`
      : `\nRESULT: PASS — ${EXPECTED.length} 个列表各自守恒`);
    process.exitCode = bad ? 1 : 0;
  } finally {
    await page.close();
  }
})().catch(e => { console.error('ERROR', e); process.exit(2); });
