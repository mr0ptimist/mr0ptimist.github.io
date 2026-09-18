// scripts/cdp/cdp.js — 无头 Chrome 连接助手（tree_check / order_check 共用）
// 启动 headless Chrome，等 DevTools 端口就绪（--remote-debugging-port=0 自动分配，避免端口冲突），
// 导航到目标页并等到树形视图渲染完成，返回 evaluate/close。
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openPage(url, opts) {
  opts = opts || {};
  const exe = CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) throw new Error('未找到 Chrome/Edge，可用环境变量 CHROME_PATH 指定');

  const profile = path.join(os.tmpdir(), 'cdp-profile-' + Date.now());
  const chrome = spawn(exe, ['--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let ws;
  try {
    // DevTools 端口写入 profile/DevToolsActivePort（首行）
    let port = null;
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !port; i++) {
      try { port = fs.readFileSync(portFile, 'utf-8').split('\n')[0].trim() || null; } catch (e) { }
      if (!port) await sleep(150);
    }
    if (!port) throw new Error('DevToolsActivePort 未生成');

    let list = null;
    for (let i = 0; i < 60; i++) {
      try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.length) break; } catch (e) { }
      await sleep(200);
    }
    if (!list) throw new Error('DevTools 不可达');

    ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0; const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method && opts.onEvent) opts.onEvent(m.method, m.params);   // 事件订阅（如 Debugger.paused）
    };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result.result.value;
    };

    // 等页面就绪：默认等树形视图（列表页用）；传 waitSelector:false 可跳过（诊断类工具用）
    const waitSel = opts.waitSelector === undefined ? '.ptree-article' : opts.waitSelector;
    const waitTree = async () => {
      if (!waitSel) return;
      for (let i = 0; i < 80; i++) {
        try { if (await evaluate(`document.querySelectorAll(${JSON.stringify(waitSel)}).length`) > 0) return; } catch (e) { }
        await sleep(250);
      }
      throw new Error('未等到选择器：' + waitSel);
    };

    await send('Page.enable'); await send('Runtime.enable');
    if (opts.setup) await opts.setup(send);                                 // 导航前的准备（如开 Debugger 域）
    for (const src of [].concat(opts.initScript || []))
      await send('Page.addScriptToEvaluateOnNewDocument', { source: src });   // 每次导航都会注入
    await send('Page.navigate', { url });
    await waitTree();
    await sleep(800);   // 让 sort-bar.js 的加载时排序跑完

    return {
      evaluate,
      send,
      waitTree,
      async close() { try { ws.close(); } catch (e) { } chrome.kill(); }
    };
  } catch (e) {
    try { ws && ws.close(); } catch (_) { }
    chrome.kill();
    throw e;
  }
}

module.exports = { openPage, sleep };
