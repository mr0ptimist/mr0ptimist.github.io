// scripts/cdp/order_check.js — 列表页树形视图「排序与交互」回归
//
// 断言（与排序规则无关，避免把 JS localeCompare 和 Hugo 排序差异当 bug）：
//   1. 加载即按存储偏好排序：各列表集合守恒、日期单调
//   2. 同一按钮切换方向：desc == reverse(asc)（键有并值时跳过——稳定排序保持原序）
//   3. 每个状态下集合必须与「服务端渲染期望值」一致（分组不被破坏）
//
// 用法：node scripts/cdp/order_check.js <页面URL> <expected.json>
const fs = require('fs');
const { openPage, sleep } = require('./cdp');

const URL_ = process.argv[2];
const EXPECTED = JSON.parse(fs.readFileSync(process.argv[3], 'utf-8'));

const CAPTURE = `(function () {
  var out = [];
  document.querySelectorAll('.ptree-list').forEach(function (ul) {
    var arts = [];
    for (var i = 0; i < ul.children.length; i++) {
      var c = ul.children[i];
      if (c.classList.contains('ptree-article')) {
        var t = c.querySelector('.ptree-title'), d = c.querySelector('.ptree-date');
        arts.push({ t: t ? t.textContent.trim() : '?', d: d ? d.textContent.trim() : '' });
      }
    }
    var li = ul.parentElement.closest('li.ptree-folder');
    var chain = [], node = li;
    while (node) {
      var n = node.querySelector('summary .ptree-name');
      chain.unshift(n ? n.textContent.trim() : '?');
      node = node.parentElement.closest('li.ptree-folder');
    }
    out.push({ path: chain.join('/'), arts: arts });
  });
  return JSON.stringify(out);
})()`;

(async () => {
  const page = await openPage(URL_);
  const fails = [];
  const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails.push(msg); };
  const expOrder = p => { const e = EXPECTED.find(x => (x.path || '') === (p || '')); return e ? e.articles : null; };
  const setOk = L => { const exp = expOrder(L.path); return !!exp && JSON.stringify([...L.arts.map(a => a.t)].sort()) === JSON.stringify([...exp].sort()); };
  const orderOf = L => L.arts.map(a => a.t);
  const snap = async () => JSON.parse(await page.evaluate(CAPTURE));
  const click = async sel => { await page.evaluate(`document.querySelector('.sort-btn[data-sort="${sel}"]').click();`); await sleep(350); return snap(); };
  const reloadFresh = async () => {
    await page.evaluate(`window.__old = 1; location.reload(); 1`);
    for (let i = 0; i < 60; i++) { try { if (!(await page.evaluate(`!!window.__old`))) break; } catch (e) { } await sleep(150); }
    await page.waitTree();
    await sleep(400);
  };

  try {
    console.log('[state 1] 清空偏好后加载（默认 date desc）');
    await page.evaluate(`sessionStorage.removeItem('blog_local_sort'); 1`);
    await reloadFresh();
    for (const L of await snap()) {
      const dates = L.arts.map(a => a.d).filter(Boolean);
      check(dates.every((d, i) => i === 0 || dates[i - 1] >= d), `${L.path || '<ROOT>'}: 日期单调不增`);
      check(setOk(L), `${L.path || '<ROOT>'}: 集合与期望一致`);
    }

    console.log('[state 2/3] 按名称 asc -> desc');
    const nameAsc = await click('name');
    const nameDesc = await click('name');
    for (const L of nameAsc) {
      const D = nameDesc.find(x => x.path === L.path);
      check(!!D && JSON.stringify(orderOf(D)) === JSON.stringify([...orderOf(L)].reverse()), `${L.path || '<ROOT>'}: desc == reverse(asc)`);
      check(setOk(L) && setOk(D), `${L.path || '<ROOT>'}: 两个方向集合均一致`);
    }

    console.log('[state 4/5] 按日期 desc -> asc');
    const dateDesc = await click('date');
    for (const L of dateDesc) {
      const dates = L.arts.map(a => a.d).filter(Boolean);
      check(dates.every((d, i) => i === 0 || dates[i - 1] >= d), `${L.path || '<ROOT>'}: 日期单调不增`);
      check(setOk(L), `${L.path || '<ROOT>'}: 集合一致`);
    }
    const dateAsc = await click('date');
    for (const L of dateAsc) {
      const D = dateDesc.find(x => x.path === L.path);
      const dates = L.arts.map(a => a.d).filter(Boolean);
      check(dates.every((d, i) => i === 0 || dates[i - 1] <= d), `${L.path || '<ROOT>'}: 日期单调不减`);
      check(setOk(L), `${L.path || '<ROOT>'}: 集合一致`);
      if (new Set(dates).size === dates.length)
        check(!!D && JSON.stringify(orderOf(L)) === JSON.stringify([...orderOf(D)].reverse()), `${L.path || '<ROOT>'}: asc == reverse(desc)（日期无并值）`);
      else
        console.log(`  skip  ${L.path || '<ROOT>'}: 日期存在并值，逆序断言不适用`);
    }

    console.log('[state 6] 按修改日期');
    for (const L of await click('lastmod')) check(setOk(L), `${L.path || '<ROOT>'}: 集合一致`);

    console.log(fails.length ? `\nRESULT: FAIL — ${fails.length} 项断言失败` : '\nRESULT: PASS — 排序与分组均正确');
    process.exitCode = fails.length ? 1 : 0;
  } finally {
    await page.close();
  }
})().catch(e => { console.error('ERROR', e); process.exit(2); });
