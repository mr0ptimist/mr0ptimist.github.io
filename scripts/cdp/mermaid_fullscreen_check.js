// scripts/cdp/mermaid_fullscreen_check.js — Mermaid 全屏查看器交互回归
//
// 用法：node scripts/cdp/mermaid_fullscreen_check.js <含 Mermaid 图的页面 URL>
const { openPage, sleep } = require('./cdp');

const URL_ = process.argv[2];

(async () => {
  if (!URL_) throw new Error('缺少页面 URL');

  const page = await openPage(URL_, { waitSelector: 'pre.mermaid svg' });
  const fails = [];
  const check = (ok, msg) => {
    console.log((ok ? '  ok   ' : '  FAIL ') + msg);
    if (!ok) fails.push(msg);
  };

  try {
    const initial = await page.evaluate(`(function () {
      var pre = document.querySelector('pre.mermaid');
      var svg = pre && pre.querySelector('svg');
      var button = pre && pre.closest('.mermaid-wrap').querySelector('.mermaid-fullscreen-button');
      return {
        hasButton: !!button,
        diagramCount: document.querySelectorAll('pre.mermaid svg').length,
        buttonCount: document.querySelectorAll('.mermaid-fullscreen-button').length,
        label: button && button.getAttribute('aria-label'),
        parentClass: pre && pre.parentElement.className,
        svgStyle: svg && svg.getAttribute('style'),
        width: svg && svg.getAttribute('width'),
        height: svg && svg.getAttribute('height')
      };
    })()`);

    check(initial.hasButton, '每张 Mermaid 图有全屏按钮');
    check(initial.buttonCount === initial.diagramCount, '全屏按钮数量与 Mermaid 图数量一致');
    check(initial.label === '全屏查看图表', '全屏按钮有可访问名称');
    if (!initial.hasButton) {
      console.log(`\nRESULT: FAIL — ${fails.length} 项断言失败`);
      process.exitCode = 1;
      return;
    }

    await page.evaluate(`document.querySelector('.mermaid-fullscreen-button').click()`);
    await sleep(100);

    const opened = await page.evaluate(`(function () {
      var viewer = document.querySelector('.mermaid-fullscreen');
      var pre = viewer && viewer.querySelector('pre.mermaid');
      var rect = pre.querySelector('svg').getBoundingClientRect();
      return {
        active: !!viewer,
        ownsDiagram: !!viewer && pre.parentElement === viewer.querySelector('.mermaid-fullscreen-canvas'),
        bodyLocked: document.body.classList.contains('mermaid-fullscreen-open'),
        closeLabel: viewer && viewer.querySelector('.mermaid-fullscreen-close').getAttribute('aria-label'),
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      };
    })()`);

    check(opened.active, '点击按钮打开全屏查看器');
    check(opened.ownsDiagram, '全屏查看器展示当前 Mermaid 图');
    check(opened.bodyLocked, '全屏期间锁定页面滚动');
    check(opened.closeLabel === '退出全屏', '全屏关闭按钮有可访问名称');

    await page.evaluate(`(function () {
      var canvas = document.querySelector('.mermaid-fullscreen-canvas');
      var r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: -180,
        clientX: r.left + r.width * 0.6, clientY: r.top + r.height * 0.4
      }));
    })()`);
    await sleep(50);
    const zoomed = await page.evaluate(`(function () {
      var r = document.querySelector('.mermaid-fullscreen pre.mermaid svg').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`);
    check(zoomed.width > opened.rect.width, '全屏内滚轮无需修饰键即可放大');

    await page.evaluate(`(function () {
      var canvas = document.querySelector('.mermaid-fullscreen-canvas');
      var r = canvas.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1,
        clientX: x, clientY: y
      }));
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1,
        clientX: x + 48, clientY: y + 32
      }));
      canvas.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 0,
        clientX: x + 48, clientY: y + 32
      }));
    })()`);
    await sleep(50);
    const panned = await page.evaluate(`(function () {
      var r = document.querySelector('.mermaid-fullscreen pre.mermaid svg').getBoundingClientRect();
      return { left: r.left, top: r.top };
    })()`);
    check(Math.abs(panned.left - zoomed.left) > 30 && Math.abs(panned.top - zoomed.top) > 20,
      '全屏内左键拖拽平移图表');

    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(50);
    const closed = await page.evaluate(`(function () {
      var pre = document.querySelector('pre.mermaid');
      var svg = pre.querySelector('svg');
      return {
        viewerGone: !document.querySelector('.mermaid-fullscreen'),
        bodyUnlocked: !document.body.classList.contains('mermaid-fullscreen-open'),
        parentClass: pre.parentElement.className,
        svgStyle: svg.getAttribute('style'),
        width: svg.getAttribute('width'),
        height: svg.getAttribute('height')
      };
    })()`);
    check(closed.viewerGone, 'Esc 退出全屏查看器');
    check(closed.bodyUnlocked, '退出后恢复页面滚动');
    check(closed.parentClass === initial.parentClass, '退出后图表回到原容器');
    check(closed.svgStyle === initial.svgStyle && closed.width === initial.width && closed.height === initial.height,
      '退出后恢复图表原始尺寸与样式');

    console.log(fails.length ? `\nRESULT: FAIL — ${fails.length} 项断言失败` : '\nRESULT: PASS — Mermaid 全屏交互正确');
    process.exitCode = fails.length ? 1 : 0;
  } finally {
    await page.close();
  }
})().catch(e => { console.error('ERROR', e); process.exit(2); });
