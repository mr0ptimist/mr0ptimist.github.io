// =============================================================================
// page-shot.js — 「渲染页面为图片」（文章头部按钮）
// =============================================================================
// 仅 dev 配置（vscodeContentBase）+ 文章页由 header.html 加载：
//   1. vendor/html2canvas.min.js
//   2. js/page-shot.js?v=N
//
// 功能：把页面渲染为长图 / 当前屏幕截图，支持
//   - 渲染范围：整篇正文（.post-single）/ 整个页面 / 当前屏幕
//   - 倍率 1× / 2×（超长页自动降倍率避免 canvas 尺寸上限）
//   - 输出 PNG / WebP / JPEG + 质量
//   - 渲染前自动展开折叠章节、整页模式隐藏左侧目录并居中
//   - 隐藏图片查看器调试工具栏/角标的开关
//
// 兼容性策略（基于 headless Chrome 实测逐项适配）：
//   1. 图片懒加载是 IntersectionObserver(rootMargin 800px)，且查看器 canvas
//      在滚动触达后才创建 —— 截图前逐个 scrollIntoView 强制触达，轮询等待
//      全部图片处理完（稳定判据：正文内不再有“可见且未被查看器收编”的 <img>）
//   2. html2canvas(1.4.1) 在整棵子树捕获时不稳定地丢失 <canvas> 位图
//      （单独截 canvas 却正常）→ 截图前把所有查看器 canvas 光栅化成
//      display 尺寸的 dataURL <img>（≤1400px 边，防内存爆炸），捕获后还原
//   3. mermaid 的 SVG 会被 html2canvas 序列化成 svg-dataURL <img>，其中
//      foreignObject 的 HTML 标签靠浏览器 UA 默认样式渲染（主题色/字体
//      CSS 全部丢失）→ 截图前把 FO 子树每个元素的计算样式内联到 style，
//      保证明暗主题下文字可读，捕获后还原
//   4. html2canvas 不识别 color-mix()/backdrop-filter → 捕获时 .header
//      临时改实色（截图里 blur 无意义）
//   5. DDS/EXR 原始 <img> 浏览器无法解码，进克隆只会报错 → ignoreElements
//      剔除（可见画面由步骤 2 的 img 提供）
//
// 调试钩子：window.__psRun({mode,scale,format,quality,expand,hideToc,clean})
//   → Promise<{dataUrl,w,h,usedScale,ms,note}>，供 headless CDP 测试。
// =============================================================================
(function () {
  var btn = document.getElementById('page-shot-btn');
  if (!btn || typeof window.html2canvas === 'undefined') return;

  var MAX_SIDE = 30000;          // canvas 单边安全上限（Chrome 65535，留余量）
  var MAX_AREA = 240000000;      // Chrome canvas 面积上限 ~268M，留余量
  var RASTER_CAP = 1400;         // canvas 光栅化边长上限（防大纹理内存爆炸）

  var overlay = null;            // 弹窗根节点（懒构建）
  var busy = false;
  var lastCanvas = null;         // 最近一次渲染结果（供下载）
  var lastOpts = null;
  var previewNatW = 0;           // 预览图自然宽度（100% 模式用）
  var fullState = { open: false, zoom: 1, natW: 0, natH: 0, url: null, root: null, img: null, stage: null };

  // ---------------------------------------------------------------- helpers
  function qs(s) { return document.querySelector(s); }
  function qsa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function readVar(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || '';
  }
  // 页面背景色：body 计算值；透明则退回 --theme
  function pageBg() {
    var b = getComputedStyle(document.body).backgroundColor;
    if (b && !/^rgba\(\s*0,\s*0,\s*0,\s*0\)$/.test(b)) return b;
    var t = readVar('--theme');
    return t || '#ffffff';
  }
  // color-mix(border 60%, transparent) 叠在 theme 上的近似实色（header 底边）
  function solidHeaderBorder() {
    var fa = parseColor(readVar('--theme'));
    var fb = parseColor(readVar('--border'));
    if (!fa || !fb) return '';
    var t = 0.6;
    return 'rgb(' + Math.round(fb[0] * t + fa[0] * (1 - t)) + ',' +
      Math.round(fb[1] * t + fa[1] * (1 - t)) + ',' +
      Math.round(fb[2] * t + fa[2] * (1 - t)) + ')';
  }
  function parseColor(str) {
    var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(str || '');
    if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
    var h = /^#([0-9a-f]{6})$/i.exec(str || '');
    if (h) { var n = parseInt(h[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255, 1]; }
    return null;
  }

  // ------------------------------------------------------------ 弹窗 UI
  function buildOverlay() {
    var o = document.createElement('div');
    o.id = 'ps-overlay';
    o.className = 'ps-overlay';    o.innerHTML =
      '<div class="ps-card" id="ps-card">' +
        '<div class="ps-head">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>' +
          '<span>渲染页面为图片</span>' +
          '<button id="ps-close" class="ps-close" title="关闭 (Esc)" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="ps-body">' +
          '<div class="ps-row">' +
            '<span class="ps-label">渲染范围</span>' +
            '<div class="ps-seg" id="ps-scope">' +
              '<label><input type="radio" name="ps-scope" value="content" checked><span>整篇正文</span></label>' +
              '<label><input type="radio" name="ps-scope" value="page"><span>整个页面</span></label>' +
              '<label><input type="radio" name="ps-scope" value="screen"><span>当前屏幕</span></label>' +
            '</div>' +
            '<div class="ps-hint" id="ps-scope-hint"></div>' +
          '</div>' +
          '<div class="ps-row">' +
            '<span class="ps-label">渲染引擎</span>' +
            '<div class="ps-seg" id="ps-engine">' +
              '<label><input type="radio" name="ps-engine" value="fast" checked><span>快速（html2canvas）</span></label>' +
              '<label><input type="radio" name="ps-engine" value="native"><span>原生（逐像素一致）</span></label>' +
            '</div>' +
            '<div class="ps-hint">原生 = 浏览器排版引擎直接绘制（文字/加粗/药丸与屏幕一致），大页面约 20–60 秒；「当前屏幕」模式自动回退快速引擎。</div>' +
          '</div>' +
          '<div class="ps-row">' +
            '<span class="ps-label">倍率（输出尺寸 = 页面宽度 × 倍率）</span>' +
            '<div class="ps-seg" id="ps-scale">' +
              '<label><input type="radio" name="ps-scale" value="1"><span>1×</span></label>' +
              '<label><input type="radio" name="ps-scale" value="2" checked><span>2×</span></label>' +
            '</div>' +
          '</div>' +
          '<div class="ps-row">' +
            '<span class="ps-label">格式</span>' +
            '<div class="ps-fmt-row">' +
              '<select id="ps-format">' +
                '<option value="png">PNG（无损，体积大）</option>' +
                '<option value="webp">WebP（体积小）</option>' +
                '<option value="jpeg">JPEG（体积最小）</option>' +
              '</select>' +
              '<span class="ps-quality" id="ps-quality-wrap">' +
                '<input type="range" id="ps-quality" min="50" max="100" value="90">' +
                '<span id="ps-quality-val">90</span>' +
              '</span>' +
            '</div>' +
          '</div>' +
          '<label class="ps-chk"><input type="checkbox" id="ps-expand" checked><span>渲染前展开所有折叠章节（确保长图内容完整）</span></label>' +
          '<label class="ps-chk" id="ps-toc-row"><input type="checkbox" id="ps-hidetoc" checked><span>「整个页面」模式隐藏左侧目录并居中排版</span></label>' +
          '<label class="ps-chk"><input type="checkbox" id="ps-clean"><span>隐藏图片查看器的调试工具栏与角标（通道按钮/尺寸/耗时徽标）</span></label>' +
        '</div>' +
        '<div class="ps-status"><span class="ps-spin"></span><span class="ps-status-text" id="ps-status-text"></span></div>' +
        '<div class="ps-result" id="ps-result" style="display:none">' +
          '<div class="ps-preview-bar">' +
            '<span class="ps-label">预览（下载文件为原尺寸）</span>' +
            '<span class="ps-seg" id="ps-zoom">' +
              '<label><input type="radio" name="ps-zoom" value="fit" checked><span>适应</span></label>' +
              '<label><input type="radio" name="ps-zoom" value="full"><span>100%</span></label>' +
            '</span>' +
          '</div>' +
          '<div class="ps-preview-scroll" id="ps-preview-scroll">' +
            '<img id="ps-preview" alt="渲染预览">' +
          '</div>' +
          '<div class="ps-meta" id="ps-meta"></div>' +
        '</div>' +
        '<div class="ps-foot">' +
          '<button id="ps-fullbtn" class="ps-btn">🖥️ 全屏预览</button>' +
          '<button id="ps-download" class="ps-btn primary" style="display:none">下载图片</button>' +
          '<button id="ps-run" class="ps-btn primary">渲染</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(o);
    overlay = o;

    o.addEventListener('click', function (e) {
      if (e.target === o) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (fullState.open) { closeFull(); return; }
      if (overlay && overlay.classList.contains('ps-open') && !busy) close();
    });
    o.querySelector('#ps-close').addEventListener('click', close);
    o.querySelector('#ps-run').addEventListener('click', function () { if (!busy) startRender(); });

    qsaRoot(o, 'input[name="ps-scope"]').forEach(function (r) { r.addEventListener('change', syncScopeUI); });
    qsaRoot(o, 'input[name="ps-scale"]').forEach(function (r) { r.addEventListener('change', syncScopeUI); });
    qsaRoot(o, 'input[name="ps-zoom"]').forEach(function (r) { r.addEventListener('change', syncZoomUI); });
    o.querySelector('#ps-format').addEventListener('change', syncFmtUI);
    o.querySelector('#ps-quality').addEventListener('input', function () {
      o.querySelector('#ps-quality-val').textContent = this.value;
    });
    o.querySelector('#ps-download').addEventListener('click', downloadResult);
    o.querySelector('#ps-fullbtn').addEventListener('click', openFull);
    o.querySelector('#ps-preview').addEventListener('dblclick', openFull);
  }
  function qsaRoot(root, s) { return Array.prototype.slice.call(root.querySelectorAll(s)); }

  function syncScopeUI() {
    if (!overlay) return;
    var mode = overlay.querySelector('input[name="ps-scope"]:checked').value;
    var scale = overlay.querySelector('input[name="ps-scale"]:checked').value;
    var hint = overlay.querySelector('#ps-scope-hint');
    var tocRow = overlay.querySelector('#ps-toc-row');
    var base = mode === 'content' ? '仅文章正文区域（不含顶部导航与左侧目录）'
      : mode === 'page' ? '顶部导航 + 整篇文章 + 页脚，一次渲染为长图'
      : '当前滚动位置所见的屏幕内容';
    hint.textContent = base + (mode !== 'screen' ? ' · 倍率 ' + scale + '×' : '');
    tocRow.style.display = mode === 'page' ? '' : 'none';
  }
  function syncFmtUI() {
    if (!overlay) return;
    var f = overlay.querySelector('#ps-format').value;
    overlay.querySelector('#ps-quality-wrap').style.display = (f === 'png') ? 'none' : '';
  }
  function syncZoomUI() {
    if (!overlay || !previewNatW) return;
    var z = overlay.querySelector('input[name="ps-zoom"]:checked');
    if (!z) return;
    var img = overlay.querySelector('#ps-preview');
    var wrap = overlay.querySelector('#ps-preview-scroll');
    if (z.value === 'full') {
      img.style.width = previewNatW + 'px';
      img.style.maxWidth = 'none';
      wrap.scrollLeft = 0; wrap.scrollTop = 0;
    } else {
      img.style.width = '100%';
      img.style.maxWidth = '100%';
      wrap.scrollTop = 0;
    }
  }

  function open() {
    if (fullState.open) return;
    if (!overlay) buildOverlay();
    if (busy) return;
    lastCanvas = null; lastOpts = null;
    overlay.querySelector('#ps-result').style.display = 'none';
    overlay.querySelector('#ps-download').style.display = 'none';
    overlay.querySelector('#ps-run').style.display = '';
    overlay.querySelector('#ps-run').disabled = false;
    setStatus('', false);
    syncScopeUI(); syncFmtUI();
    overlay.classList.add('ps-open');
  }
  function close() {
    if (!overlay || busy) return;
    overlay.classList.remove('ps-open');
    lastCanvas = null; lastOpts = null;
  }
  function setStatus(text, isErr) {
    if (!overlay) return;
    var st = overlay.querySelector('#ps-status-text');
    st.textContent = text;
    st.className = 'ps-status-text' + (isErr ? ' ps-error' : '');
    overlay.querySelector('.ps-status').classList.toggle('ps-busy', busy && !isErr);
  }

  // ---------------------------------------------------------------- 渲染
  function collectOpts() {
    return {
      mode: overlay.querySelector('input[name="ps-scope"]:checked').value,
      engine: overlay.querySelector('input[name="ps-engine"]:checked').value,
      scale: parseInt(overlay.querySelector('input[name="ps-scale"]:checked').value, 10) || 1,
      format: overlay.querySelector('#ps-format').value,
      quality: parseInt(overlay.querySelector('#ps-quality').value, 10) / 100,
      expand: overlay.querySelector('#ps-expand').checked,
      hideToc: overlay.querySelector('#ps-hidetoc').checked,
      clean: overlay.querySelector('#ps-clean').checked
    };
  }

  function startRender() {
    if (fullState.open) closeFull();
    busy = true;
    overlay.querySelector('#ps-run').disabled = true;
    overlay.querySelector('#ps-result').style.display = 'none';
    overlay.querySelector('#ps-download').style.display = 'none';
    setStatus('准备中…', false);
    var opts = collectOpts();
    wait(80).then(function () {
      return renderCore(opts);
    }).then(function (res) {
      busy = false;
      overlay.querySelector('#ps-run').disabled = false;
      lastOpts = opts;
      showResult(res);
    }).catch(function (err) {
      busy = false;
      overlay.querySelector('#ps-run').disabled = false;
      console.error('[page-shot]', err);
      setStatus('渲染失败：' + (err && err.message ? err.message : err), true);
    });
  }

  // 截图前的图片完备化：
  //  1) 逐个 scrollIntoView 触达 IntersectionObserver 懒加载（并禁用平滑滚动）
  //  2) 轮询等待“正文内已无可见且未被收编的 <img>”，再补 500ms 等 worker 收尾
  function forceDecode(mode) {
    if (mode === 'screen') return Promise.resolve();
    var imgs = qsa('.post-content img');
    function allSettled() {
      var left = 0;
      imgs.forEach(function (img) {
        if (!img.isConnected) return;
        var cs = window.getComputedStyle(img);
        if (cs.display === 'none') return;
        if (img.closest('.channel-container') || img.closest('.entry-thumb')) return;
        left++;
      });
      return left === 0;
    }
    function poke(i) {
      if (i >= imgs.length) {
        var t0 = Date.now();
        var lastCvs = -1, lastSh = -1, stableSince = 0;
        function settle() {
          var cvs = document.querySelectorAll('.post-content canvas.channel-canvas').length;
          var sh = document.documentElement.scrollHeight;
          if (allSettled() && cvs === lastCvs && sh === lastSh) {
            if (stableSince === 0) stableSince = Date.now();
            if (Date.now() - stableSince >= 1200) return wait(400);
          } else {
            stableSince = 0;
            lastCvs = cvs; lastSh = sh;
          }
          if (Date.now() - t0 > 25000) return wait(400);
          return wait(350).then(settle);
        }
        return settle();
      }
      var img = imgs[i];
      if (img.isConnected) {
        try { img.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
      }
      return wait(40).then(function () { return poke(i + 1); });
    }
    return poke(0);
  }

  // 把 .channel-canvas 光栅化成 dataURL <img>（display 分辨率上限 RASTER_CAP），
  // 规避 html2canvas 对深子树 canvas 的丢位图问题；顺带把查看器右下尺寸 /
  // 左下耗时角标按原位置绘制进位图（html2canvas 深子树会丢绝对定位角标）
  function rasterizeCanvases(inViewportOnly, drawChips) {
    var swaps = [];
    var vw = window.innerWidth, vh = window.innerHeight;
    qsa('.post-content canvas.channel-canvas').forEach(function (cv) {
      if (!cv.isConnected) return;
      if (inViewportOnly) {
        var r = cv.getBoundingClientRect();
        if (r.bottom < -100 || r.top > vh + 100 || r.right < -100 || r.left > vw + 100) return;
      }
      var flip = /^matrix\(1, 0, 0, -1/.test(window.getComputedStyle(cv).transform);
      var sc = Math.min(1, RASTER_CAP / cv.width, RASTER_CAP / cv.height);
      var tw = Math.max(1, Math.round(cv.width * sc));
      var th = Math.max(1, Math.round(cv.height * sc));
      var tmp = document.createElement('canvas');
      tmp.width = tw; tmp.height = th;
      var cx = tmp.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      if (flip) { cx.translate(0, th); cx.scale(1, -1); }
      try {
        cx.drawImage(cv, 0, 0, tw, th);
      } catch (e) {
        return; // 画不出来的（tainted 等）保持原样
      }
      cx.setTransform(1, 0, 0, 1, 0, 0);
      // ---- 角标合成（尺寸/耗时 chip 画进位图，位置取 chip 相对 canvas 显示框） ----
      if (drawChips) {
        var cssRect = cv.getBoundingClientRect();
        if (cssRect.width > 0 && cssRect.height > 0) {
          var rx = tw / cssRect.width;
          var chips = qsaRoot(cv.closest('.channel-container') || cv.parentNode,
            '.channel-size-badge, .channel-time-badge');
          chips.forEach(function (chip) {
            if (!chip.isConnected) return;
            var cs = window.getComputedStyle(chip);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return;
            var cr = chip.getBoundingClientRect();
            var x0 = Math.round((cr.left - cssRect.left) * rx);
            var y0 = Math.round((cr.top - cssRect.top) * rx);
            var w0 = Math.max(1, Math.round(cr.width * rx));
            var h0 = Math.max(1, Math.round(cr.height * rx));
            if (x0 > tw || y0 > th) return;
            cx.save();
            cx.beginPath();
            cx.rect(x0, y0, Math.min(w0, tw - x0), Math.min(h0, th - y0));
            cx.clip();
            cx.fillStyle = 'rgba(0,0,0,0.7)';
            cx.fillRect(x0, y0, w0, h0);
            var family = (cs.fontFamily || 'monospace').split(',')[0].replace(/^["']|["']$/g, '');
            cx.font = (cs.fontWeight || '400') + ' ' + cs.fontSize + ' ' + family;
            cx.fillStyle = cs.color;
            cx.textBaseline = 'middle';
            cx.textAlign = 'left';
            var pad = 2 * rx + 4;
            cx.fillText(chip.textContent, x0 + pad, y0 + h0 / 2, Math.max(0, w0 - pad * 2));
            cx.restore();
          });
        }
      }
      var img = document.createElement('img');
      img.src = tmp.toDataURL('image/png');
      img.className = cv.className + ' ps-swap-img';
      img.style.cssText = cv.style.cssText;
      img.setAttribute('width', String(cv.width));
      img.setAttribute('height', String(cv.height));
      cv.parentNode.insertBefore(img, cv);
      cv.style.display = 'none';
      swaps.push({ img: img, cv: cv });
    });
    return function restore() {
      swaps.forEach(function (p) {
        if (p.img.isConnected) p.img.remove();
        p.cv.style.display = '';
      });
    };
  }

  // mermaid SVG → dataURL <img>（img 通道经实测会渲染 foreignObject 文本；
  // html2canvas 自带 svg 序列化通道在整页捕获中会丢 FO 内容）
  function rasterizeMermaid() {
    var swaps = [];
    qsa('.mermaid svg').forEach(function (svg) {
      if (!svg.isConnected) return;
      var xml;
      try {
        xml = new XMLSerializer().serializeToString(svg);
      } catch (e) { return; }
      var rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var img = document.createElement('img');
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      img.className = 'ps-swap-svgimg';
      img.style.maxWidth = '100%';
      img.style.width = rect.width + 'px';
      img.style.height = rect.height + 'px';
      svg.parentNode.insertBefore(img, svg);
      svg.style.display = 'none';
      swaps.push({ img: img, svg: svg });
    });
    return function restore() {
      swaps.forEach(function (p) {
        if (p.img.isConnected) p.img.remove();
        p.svg.style.display = '';
      });
    };
  }

  // 行内 code 药丸背景：html2canvas 对行内元素背景锚定在行盒顶边（比真实
  // padding-box 药丸高 2–4px 的“上飘”）。改为按实测定点生成绝对定位背景层
  // （z-index:-1 压在文字下），位置 = 元素实时 padding-box 矩形，零布局影响。
  function patchCodePillStyles(inViewportOnly) {
    var overlays = [];
    var vw = window.innerWidth, vh = window.innerHeight;
    qsa('.post-content code').forEach(function (el) {
      if (!el.isConnected || el.closest('pre') || el.closest('.mermaid')) return;
      var cs = window.getComputedStyle(el);
      var bg = cs.backgroundColor;
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return;
      var rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (inViewportOnly) {
        if (rect.bottom < -100 || rect.top > vh + 100 || rect.right < -100 || rect.left > vw + 100) return;
      }
      var o = document.createElement('div');
      o.style.cssText =
        'position:absolute;z-index:-1;pointer-events:none;' +
        'left:' + Math.round(rect.left + window.scrollX) + 'px;' +
        'top:' + Math.round(rect.top + window.scrollY) + 'px;' +
        'width:' + rect.width + 'px;height:' + rect.height + 'px;' +
        'background:' + bg + ';' +
        'border-radius:' + (cs.borderRadius || '0') + ';';
      document.body.appendChild(o);
      overlays.push(o);
    });
    return function restore() {
      overlays.forEach(function (o) { if (o.isConnected) o.remove(); });
      overlays = [];
    };
  }

  function inlineMermaidStyles() {
    var touched = [];
    qsa('.mermaid svg foreignObject').forEach(function (fo) {
      function walk(el) {
        if (el.nodeType !== 1) return;
        if (el.tagName === 'DIV' || el.tagName === 'SPAN' || el.tagName === 'P' || el.tagName === 'BR') {
          var cs = window.getComputedStyle(el);
          var prev = el.getAttribute('style') || '';
          var add = 'color:' + cs.color + ';font-size:' + cs.fontSize + ';font-family:' +
            cs.fontFamily + ';font-weight:' + cs.fontWeight + ';line-height:' + cs.lineHeight +
            ';text-align:' + cs.textAlign + ';white-space:pre-wrap;';
          el.setAttribute('style', add + prev);
          touched.push({ el: el, prev: prev });
        }
        for (var c = el.firstChild; c; c = c.nextSibling) walk(c);
      }
      walk(fo);
    });
    return function restore() {
      touched.forEach(function (t) {
        if (t.prev) t.el.setAttribute('style', t.prev);
        else t.el.removeAttribute('style');
      });
      touched = [];
    };
  }

  // core：返回 { canvas, w, h, usedScale, ms, note }
  function renderCore(opts) {
    var t0 = performance.now();
    var undos = [];
    var originX = window.scrollX, originY = window.scrollY;
    var note = '';
    // 原生引擎（foreignObject）：仅正文/整页；屏幕模式回退 html2canvas
    var nativeEngine = opts.engine === 'native' && opts.mode !== 'screen' &&
      typeof window.modernScreenshot !== 'undefined';
    // 渲染全程禁用平滑滚动（全局 html{scroll-behavior:smooth} 会与程序化滚动
    // 互相取消/冻结，导致滚动位置错乱），收尾时再还原
    var htmlEl = document.documentElement;
    var origBehavior = htmlEl.style.scrollBehavior;
    if (htmlEl.style.scrollBehavior !== 'auto') {
      htmlEl.style.scrollBehavior = 'auto';
      pushUndo(function () { htmlEl.style.scrollBehavior = origBehavior; });
    }

    function setStyle(el, prop, val) {
      if (!el) return;
      undos.push(function () { el.style[prop] = ''; });
      el.style[prop] = val;
    }
    function pushUndo(fn) { undos.push(fn); }

    // ---- 1. 展开折叠章节（先展开，懒加载触达才有意义；渲染后还原） ----
    if (opts.expand) {
      var prevOpen = [];
      qsa('.post-content details').forEach(function (d) {
        if (d.className.indexOf('collapsible-section') >= 0 ||
            d.className.indexOf('subsection') >= 0 ||
            d.className.indexOf('subsubsection') >= 0) {
          prevOpen.push({ d: d, open: d.open });
          if (!d.open) d.open = true;
        }
      });
      pushUndo(function () {
        for (var k = 0; k < prevOpen.length; k++) {
          if (prevOpen[k].d.open !== prevOpen[k].open) prevOpen[k].d.open = prevOpen[k].open;
        }
      });
    }

    var prep = wait(60).then(function () {
      setStatus('正在加载文中全部图片…', false);
      return forceDecode(opts.mode);
    });
    return prep.then(function () {

      // ---- 2. 临时样式与结构适配 ----
      var ignored = [];
      function ignoreEl(el) { if (el) ignored.push(el); }

      if (!nativeEngine) {
        if (opts.mode !== 'screen') {
          ignoreEl(qs('details.toc'));
          qsa('.top-link').forEach(ignoreEl);
          var wp = qs('.width-panel'); if (wp) ignoreEl(wp);
        }
        if (opts.mode === 'page' && opts.hideToc) {
          var main = qs('.main');
          if (main) {
            setStyle(main, 'marginLeft', 'auto');
            setStyle(main, 'marginRight', 'auto');
          }
        }
        if (opts.clean) {
          qsa('.post-content .channel-toolbar, .post-content .channel-meta, .post-content .channel-size-badge, .post-content .channel-time-badge').forEach(ignoreEl);
        } else {
          // 角标已合成进光栅图，避免 DOM 原件在克隆里二次出现
          qsa('.post-content .channel-size-badge, .post-content .channel-time-badge').forEach(ignoreEl);
        }

        // color-mix()/backdrop-filter → 实色
        var themeCol = readVar('--theme');
        var header = qs('.header');
        if (header && themeCol) {
          setStyle(header, 'background', themeCol);
          setStyle(header, 'borderBottomColor', solidHeaderBorder());
          setStyle(header, 'backdropFilter', 'none');
          setStyle(header, 'webkitBackdropFilter', 'none');
        }
        var wpi = qs('.width-panel-inner');
        if (wpi && themeCol) { setStyle(wpi, 'background', themeCol); }

        // 查看器 canvas → dataURL img（含角标合成）；mermaid svg → dataURL img
        pushUndo(rasterizeCanvases(opts.mode === 'screen', !opts.clean));
        // 行内 code：保持原生文本布局，仅叠约定点药丸背景层（零叠字/换行风险）
        pushUndo(patchCodePillStyles(opts.mode === 'screen'));
        // mermaid FO 内部元素计算样式内联（svg-as-img 环境不加载站点 CSS）
        pushUndo(inlineMermaidStyles());
        pushUndo(rasterizeMermaid());
      } else {
        // 原生引擎：foreignObject 会随排版引擎一并绘制（无需任何补丁）；
        // 仅“整页+隐藏目录”需要临时隐藏 TOC 并居中正文
        if (opts.mode === 'page' && opts.hideToc) {
          var tocN = qs('details.toc');
          if (tocN) setStyle(tocN, 'display', 'none');
          var mainN = qs('.main');
          if (mainN) {
            setStyle(mainN, 'marginLeft', 'auto');
            setStyle(mainN, 'marginRight', 'auto');
          }
        }
      }

      // 弹窗本体移出 DOM
      if (overlay && overlay.parentNode === document.body) {
        var host = overlay;
        document.body.removeChild(host);
        pushUndo(function () { if (host.parentNode !== document.body) document.body.appendChild(host); });
      }
      var stats = {
        canvases: qsa('.post-content canvas.channel-canvas').length,
        foInlined: qsa('.mermaid svg foreignObject').length, // 已 display:none 的 svg 也计入（近似）
        mermaidSwap: qsa('img.ps-swap-svgimg').length
      };

      // ---- 3. 目标元素与尺寸 ----
      var mode = opts.mode;
      var target = null;
      if (mode === 'content') {
        target = qs('.post-single') || qs('.post-content') || qs('article');
      } else if (mode === 'page') {
        target = document.documentElement;
      } else {
        target = document.body;
      }
      if (!target) throw new Error('找不到要渲染的内容区域');

      var w0, h0;
      if (mode === 'screen') {
        w0 = window.innerWidth; h0 = window.innerHeight;
      } else {
        w0 = target.offsetWidth;
        h0 = Math.max(target.offsetHeight, target.scrollHeight, document.documentElement.scrollHeight);
      }
      if (!w0 || !h0) throw new Error('内容区域尺寸为空');

      var s = opts.scale || 1;
      if (w0 * s > MAX_SIDE || h0 * s > MAX_SIDE) {
        s = Math.min(MAX_SIDE / w0, MAX_SIDE / h0);
        note = '⚠️ 页面过长，倍率已自动降为 ' + Math.round(s * 100) / 100 + '×（浏览器画布尺寸上限）';
      }
      if (w0 * s * h0 * s > MAX_AREA) {
        s = Math.sqrt(MAX_AREA / (w0 * h0));
        note = '⚠️ 页面过大，倍率已自动降为 ' + Math.round(s * 100) / 100 + '×（浏览器画布面积上限）';
      }
      s = Math.max(0.25, Math.floor(s * 100) / 100);

      // ---- 4. html2canvas / 原生 ----
      // 正文/整页：回到页首再渲染（取景与窗口滚动位置耦合）；
      // 屏幕模式保持用户视口
      if (mode !== 'screen') {
        window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      }
      setStatus((nativeEngine ? '原生引擎渲染中' : '正在渲染 ') + Math.round(w0 * s) + '×' + Math.round(h0 * s) + ' px…', false);

      function fastCapture() {
        var ignoreFn = function (el) {
          if (!el || el.nodeType !== 1) return false;
          if (ignored.indexOf(el) >= 0) return true;
          if (el.tagName === 'IMG') {
            var src = el.getAttribute('src') || '';
            if (/\.(dds|exr)$/i.test(src) && el.style.display === 'none') return true;
          }
          return false;
        };
        var h2cOpts = {
          scale: s,
          backgroundColor: pageBg(),
          logging: false,
          useCORS: true,
          ignoreElements: ignoreFn
        };
        if (mode === 'screen') {
          h2cOpts.width = w0;
          h2cOpts.height = h0;
          h2cOpts.windowWidth = w0;
          h2cOpts.windowHeight = h0;
          h2cOpts.scrollX = -originX;
          h2cOpts.scrollY = -originY;
        }
        return window.html2canvas(target, h2cOpts);
      }
      function nativeCapture() {
        if (!window.modernScreenshot) {
          return Promise.reject(new Error('原生渲染引擎未加载（modern-screenshot 资源缺失）'));
        }
        return window.modernScreenshot.domToCanvas(target, {
          scale: s,
          backgroundColor: pageBg()
        });
      }

      var cap = nativeEngine ? nativeCapture() : fastCapture();
      return cap.then(function (canvas) {
        return {
          canvas: canvas,
          w: canvas.width,
          h: canvas.height,
          usedScale: s,
          ms: Math.round(performance.now() - t0),
          note: note,
          stats: stats
        };
      });
    }).then(function (res) {
      for (var i = undos.length - 1; i >= 0; i--) { try { undos[i](); } catch (e) {} }
      undos = [];
      window.scrollTo({ left: originX, top: originY, behavior: 'instant' });
      return res;
    }, function (err) {
      for (var j = undos.length - 1; j >= 0; j--) { try { undos[j](); } catch (e2) {} }
      window.scrollTo({ left: originX, top: originY, behavior: 'instant' });
      throw err;
    });
  }

  // 分步降采样：每次减半再收尾，避免一步大比例缩放产生的混叠/糊
  function makePreviewCanvas(src, maxW) {
    var cur = src;
    while (cur.width > maxW * 2) {
      var nw = Math.max(1, Math.ceil(cur.width / 2));
      var nh = Math.max(1, Math.ceil(cur.height / 2));
      var n = document.createElement('canvas');
      n.width = nw; n.height = nh;
      var nctx = n.getContext('2d');
      nctx.imageSmoothingEnabled = true;
      nctx.imageSmoothingQuality = 'high';
      nctx.drawImage(cur, 0, 0, nw, nh);
      cur = n;
    }
    var fw = Math.round(maxW);
    var fh = Math.max(1, Math.round(cur.height * maxW / cur.width));
    var f = document.createElement('canvas');
    f.width = fw; f.height = fh;
    var fctx = f.getContext('2d');
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(cur, 0, 0, fw, fh);
    return f;
  }

  // ---- 结果展示 ----
  function showResult(res) {
    lastCanvas = res.canvas;
    previewNatW = 0;
    var result = overlay.querySelector('#ps-result');
    var preview = overlay.querySelector('#ps-preview');
    var wrap = overlay.querySelector('#ps-preview-scroll');

    var pv = makePreviewCanvas(res.canvas, 1000);
    previewNatW = pv.width;
    try { preview.src = pv.toDataURL('image/png'); } catch (e) { preview.removeAttribute('src'); }
    // 重置为「适应」视图并滚回顶部
    var fitRadio = overlay.querySelector('input[name="ps-zoom"][value="fit"]');
    if (fitRadio) fitRadio.checked = true;
    syncZoomUI();
    if (wrap) { wrap.scrollTop = 0; wrap.scrollLeft = 0; }

    var f = overlay.querySelector('#ps-format').value;
    overlay.querySelector('#ps-meta').textContent = res.w + '×' + res.h + ' px · 倍率 ' + res.usedScale + '× · ' +
      f.toUpperCase() + ' · 耗时 ' + res.ms + ' ms';
    result.style.display = '';
    overlay.querySelector('#ps-download').style.display = '';
    overlay.querySelector('#ps-run').textContent = '重新渲染';
    overlay.querySelector('#ps-run').style.display = '';
    if (res.note) setStatus(res.note, false);
    else setStatus('完成，点击「下载图片」保存。', false);
  }

  function fileName() {
    var t = '';
    var h1 = qs('.post-title') || qs('h1');
    if (h1) t = h1.textContent;
    t = (t || document.title || 'page').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    var mode = lastOpts ? lastOpts.mode : 'content';
    var ext = lastOpts ? lastOpts.format : 'png';
    return t + '_' + mode + '_' + ext + '.' + ext;
  }

  function downloadResult() {
    if (!lastCanvas) return;
    var opts = lastOpts || { format: 'png', quality: 0.9 };
    var mime = opts.format === 'jpeg' ? 'image/jpeg' : opts.format === 'webp' ? 'image/webp' : 'image/png';
    var q = opts.format === 'png' ? undefined : opts.quality;
    lastCanvas.toBlob(function (blob) {
      if (!blob) { setStatus('图片编码失败', true); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }, mime, q);
  }

  // ------------------------------------------------------ 全屏完整预览
  function fullSetZoom(scale) {
    if (!fullState.img || !fullState.natW) return;
    scale = Math.max(0.02, Math.min(20, scale));
    fullState.zoom = scale;
    fullState.img.style.width = Math.round(fullState.natW * scale) + 'px';
    fullState.img.style.height = 'auto';
    var val = document.getElementById('pf-zoomval');
    if (val) val.textContent = Math.round(scale * 100) + '%';
  }
  function fullFit(mode) {
    if (!fullState.img || !fullState.natW) return;
    var stage = fullState.stage;
    var sw = stage.clientWidth, sh = stage.clientHeight;
    if (!sw || !sh) return;
    var s;
    if (mode === 'page') s = Math.min(sw / fullState.natW, sh / fullState.natH, 1);
    else s = Math.min(sw / fullState.natW, 1); // width
    fullSetZoom(s);
  }
  function openFull() {
    if (!lastCanvas || fullState.open) return;
    fullState.open = true;
    document.body.classList.add('ps-lock');
    var f = document.createElement('div');
    f.id = 'ps-full';
    f.innerHTML =
      '<div class="pf-bar">' +
        '<span class="pf-title">🖥️ 完整预览</span>' +
        '<span class="pf-name" id="pf-name"></span>' +
        '<span class="pf-sep"></span>' +
        '<button class="pf-btn" data-zoom="page" title="整幅缩放至窗口内">适应页面</button>' +
        '<button class="pf-btn" data-zoom="width" title="按宽度缩放（不超过 100%）">适应宽度</button>' +
        '<button class="pf-btn" data-zoom="100" title="实际像素 100%">100%</button>' +
        '<button class="pf-btn" data-zoom="out" title="缩小">−</button>' +
        '<button class="pf-btn" data-zoom="in" title="放大">+</button>' +
        '<span class="pf-zoomval" id="pf-zoomval"></span>' +
        '<span class="pf-sep"></span>' +
        '<button class="pf-btn primary" id="pf-download">下载图片</button>' +
        '<button class="pf-btn" id="pf-close" title="关闭 (Esc)">✕ 关闭</button>' +
      '</div>' +
      '<div class="pf-stage" id="pf-stage"></div>' +
      '<div class="pf-hint">拖动滚动条浏览 · Ctrl+滚轮缩放 · 双击切换 100% ↔ 适应页面 · Esc 关闭</div>';
    document.body.appendChild(f);
    fullState.root = f;
    fullState.img = null;
    fullState.url = null;
    var stage = f.querySelector('#pf-stage');
    fullState.stage = stage;
    var t = qs('.post-title') || qs('h1');
    f.querySelector('#pf-name').textContent = (t ? t.textContent.trim() : '') + ' · 渲染结果';

    f.querySelector('#pf-close').addEventListener('click', closeFull);
    f.querySelector('#pf-download').addEventListener('click', downloadResult);
    f.querySelectorAll('.pf-btn[data-zoom]').forEach(function (b) {
      b.addEventListener('click', function () {
        var z = b.getAttribute('data-zoom');
        if (z === 'page') fullFit('page');
        else if (z === 'width') fullFit('width');
        else if (z === '100') fullSetZoom(1);
        else if (z === 'in') fullSetZoom(fullState.zoom * 1.25);
        else if (z === 'out') fullSetZoom(fullState.zoom / 1.25);
      });
    });
    stage.addEventListener('dblclick', function () {
      if (Math.abs(fullState.zoom - 1) < 0.02) fullFit('page');
      else fullSetZoom(1);
    });
    stage.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        fullSetZoom(e.deltaY < 0 ? fullState.zoom * 1.15 : fullState.zoom / 1.15);
      }
    }, { passive: false });

    var note = f.querySelector('#pf-zoomval');
    note.textContent = '正在生成全尺寸位图…';
    var cvs = lastCanvas;
    setTimeout(function () {
      cvs.toBlob(function (blob) {
        if (!fullState.open) return;
        if (!blob) { note.textContent = '生成失败'; return; }
        fullState.url = URL.createObjectURL(blob);
        var img = document.createElement('img');
        img.alt = '完整预览';
        fullState.img = img;
        stage.appendChild(img);
        img.onload = function () {
          fullState.natW = img.naturalWidth;
          fullState.natH = img.naturalHeight;
          note.textContent = '';
          fullFit('page');
        };
        img.src = fullState.url;
      }, 'image/png');
    }, 60);
  }
  function closeFull() {
    if (!fullState.open) return;
    fullState.open = false;
    document.body.classList.remove('ps-lock');
    if (fullState.url) { URL.revokeObjectURL(fullState.url); fullState.url = null; }
    if (fullState.root) { fullState.root.remove(); fullState.root = null; }
    fullState.img = null;
    fullState.stage = null;
  }

  // ---------------------------------------------------------------- 挂载
  btn.addEventListener('click', open);

  // 调试钩子（headless CDP 验证用）：__psRun(opts) → Promise<结果>
  window.__psRun = function (o) {
    o = o || {};
    return renderCore({
      mode: o.mode || 'content',
      engine: o.engine === 'native' ? 'native' : 'fast',
      scale: o.scale == null ? 1 : Number(o.scale),
      format: o.format || 'webp',
      quality: o.quality == null ? 0.9 : Number(o.quality),
      expand: o.expand !== false,
      hideToc: o.hideToc !== false,
      clean: !!o.clean
    }).then(function (res) {
      lastCanvas = res.canvas;
      window.__psLastCanvas = res.canvas; // 调试：CDP 直接采样最终画布
      var fmt = o.format || 'webp';
      var q = o.quality == null ? 0.9 : Number(o.quality);
      lastOpts = { format: fmt, quality: q, mode: o.mode || 'content' };
      var mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
      var dataUrl = res.canvas.toDataURL(mime, q);
      return { dataUrl: dataUrl, w: res.canvas.width, h: res.canvas.height, usedScale: res.usedScale, ms: res.ms, note: res.note, stats: res.stats || null };
    });
  };
})();
