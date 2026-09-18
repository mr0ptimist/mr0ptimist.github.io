// scripts/cdp/trace_exceptions.js — 「静默失败」追踪器
//
// 暂停在**所有**异常上（含被 try/catch 或 .catch(){} 吞掉的），打印抛错描述与调用栈。
// 页面没反应但控制台无输出时用它——2026-09 缩略图静默失败就是这样定位到具体行号的。
//
// 用法：node scripts/cdp/trace_exceptions.js <页面URL> [观测秒数]
const { openPage, sleep } = require('./cdp');

const URL_ = process.argv[2];
const WAIT_MS = +(process.argv[3] || 8) * 1000;

const found = [];
let cdpSend = null;    // setup 钩子给的 send：暂停事件可能在 openPage 返回前就到了

(async () => {
  const page = await openPage(URL_, {
    waitSelector: false,          // 诊断工具：任何页面都能用，不等树形视图
    setup: async send => {
      cdpSend = send;
      await send('Debugger.enable');
      await send('Debugger.setPauseOnExceptions', { state: 'all' });
    },
    onEvent: (method, params) => {
      if (method !== 'Debugger.paused') return;
      const d = params.data || {};
      found.push({
        desc: (d.description || d.value || d.type || '?').toString().split('\n')[0].slice(0, 200),
        uncaught: !!d.uncaught,
        frames: params.callFrames.slice(0, 6).map(f =>
          `${f.functionName || '(anonymous)'}@${(f.url || '').split('/').slice(-1)[0] || '?'}:${f.location.lineNumber + 1}`)
      });
      if (cdpSend) cdpSend('Debugger.resume', {});
    }
  });
  try {
    await sleep(WAIT_MS);
    await page.send('Debugger.setPauseOnExceptions', { state: 'none' });

    console.log(`捕获 ${found.length} 个异常`);
    const seen = new Map();
    for (const f of found) {
      const key = f.desc + ' | ' + f.frames.slice(0, 3).join(' <- ');
      if (!seen.has(key)) seen.set(key, { n: 0, f });
      seen.get(key).n++;
    }
    const rows = [...seen.values()].sort((a, b) => b.n - a.n);
    for (const { n, f } of rows) {
      console.log(`\n  x${n} ${f.uncaught ? '[未捕获] ' : '[已捕获] '}${f.desc}`);
      for (const fr of f.frames) console.log(`       ${fr}`);
    }
    console.log(rows.length ? '' : '\n  没有异常。');
  } finally {
    await page.close();
  }
})().catch(e => { console.error('ERROR', e); process.exit(2); });
