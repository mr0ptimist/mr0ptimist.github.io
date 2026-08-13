/**
 * Mermaid diagram initialization.
 * Loaded on-demand by extend_head.html when a page contains mermaid diagrams.
 */
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
  theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
  maxEdges: 2000,
  flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis' },
  themeVariables: { fontSize: '14px' }
});

function runMermaid() {
  // Hugo's safeHTML sets innerHTML, but the browser HTML parser eats angle-bracket
  // syntax like <<interface>> (parses <interface> as an HTML tag). Fix by reading
  // innerHTML, restoring &lt; sequences that should be <<, and writing back via
  // textContent so mermaid sees the correct source.
  document.querySelectorAll('pre.mermaid:not([data-processed])').forEach(function (pre) {
    var html = pre.innerHTML;
    html = html.replace(/&lt;/g, '&lt;&lt;').replace(/>&gt;/g, '&gt;&gt;');
    // Preserve <br/> before textContent strips it (HTML parser turns <br/> into <br> element)
    html = html.replace(/<br\s*\/?>/gi, '%%MERMAID_BR%%');
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var text = temp.textContent || temp.innerText;
    text = text.replace(/%%MERMAID_BR%%/g, '<br/>');
    pre.textContent = text;
  });
  mermaid.run({ querySelector: 'pre.mermaid:not([data-processed])' }).then(function () {
    document.querySelectorAll('pre.mermaid svg').forEach(function (svg) {
      svg.querySelectorAll('.nodeLabel div, .nodeLabel p').forEach(function (el) {
        el.style.maxWidth = 'none';
      });
      // Force all text black with inline !important to block Dark Reader
      svg.querySelectorAll('text').forEach(function (t) {
        t.style.setProperty('fill', '#000', 'important');
      });
      attachPan(svg.closest('pre.mermaid'));
      attachInlineZoom(svg.closest('pre.mermaid'));
    });
  });
}

/* ==================== 页面内拖拽平移 ====================
   按住图拖动 = 平移 pre 滚动容器（grab 式，scrollLeft/Top 跟随指针）。
   仅左键；无滚动空间（未放大）时不启用——100% 视图是纯文本选择模式，
   放大后才进入拖拽模式（拖拽与文字选择冲突，放大查看时平移优先）。
   真拖拽（>3px）才加 panning 禁选，单击/小移动不影响选择与右键复制。
   ==================================================== */
function attachPan(pre) {
  if (!pre || pre.dataset.panAttached) return;
  var svg = pre.querySelector('svg');
  if (!svg) return;
  pre.dataset.panAttached = '1';

  pre.addEventListener('selectstart', function (e) {
    if (pre.classList.contains('panning')) e.preventDefault();
  });

  var dragging = false, moved = false, sx = 0, sy = 0, sl = 0, st = 0;
  svg.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;  // 非左键：交给系统（右键菜单/复制）
    // 指针在文字（label/foreignObject）上：不拖拽，保证可选中复制
    var t = e.target;
    if (t && t !== svg && t.closest && t.closest('foreignObject')) return;
    // 仅放大状态启用拖拽平移：100% 时全区域可选中（滚轮滚动文章）
    var baseW = parseFloat(svg.dataset.baseW) || parseFloat(svg.getAttribute('width')) || 800;
    var cur = parseFloat(svg.getAttribute('width')) / baseW;
    if (cur <= 1.05) return;
    dragging = true;
    moved = false;
    sx = e.clientX; sy = e.clientY;
    sl = pre.scrollLeft; st = pre.scrollTop;
    try { svg.setPointerCapture(e.pointerId); } catch (err) {}
  });
  svg.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      moved = true;
      pre.classList.add('panning');
    }
    if (moved) {
      pre.scrollLeft = sl - dx;
      pre.scrollTop = st - dy;
    }
  });
  function endDrag() {
    dragging = false;
    pre.classList.remove('panning');
  }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('lostpointercapture', endDrag);
}

/* ==================== 页面内缩放 ====================
   初始适配容器（CSS max-width/max-height 100%，完整可见，pre 无滚动空间
   → 滚轮穿透滚动文章）；Ctrl/Cmd + 滚轮缩放（无修饰滚轮留给页面），指针锚点。
   适配后的显示宽度记为基准（100% = 适配视图），放大后拖拽平移查看。
   直接改 svg 的 width/height（viewBox 等比），布局级缩放。
   范围 0.25x–3x，指数映射顺滑无跳变。
   ==================================================== */
function attachInlineZoom(pre) {
  if (!pre || pre.dataset.zoomAttached) return;
  var svg = pre.querySelector('svg');
  if (!svg) return;
  pre.dataset.zoomAttached = '1';

  var vb = svg.getAttribute('viewBox') || '';
  var vbParts = vb.trim().split(/[\s,]+/).map(Number);
  var ratio = vbParts.length === 4 && vbParts[2] > 0 ? vbParts[3] / vbParts[2] : 1;
  if (vbParts.length === 4 && vbParts[2] > 0 && vbParts[3] > 0) {
    svg.style.aspectRatio = vbParts[2] + ' / ' + vbParts[3];  // 适配缩放保持比例
  }
  // CSS max 已把初始显示宽压到容器内：记录适配宽为基准，解除 max 钳制（放大不受限）
  var baseW = svg.getBoundingClientRect().width || parseFloat(svg.getAttribute('width')) || 800;
  svg.style.maxWidth = 'none';
  svg.dataset.baseW = baseW;  // 供 attachPan 判断是否放大（拖拽平移启用条件）
  // 高度按 viewBox 比例：CSS height:auto 对 SVG 取 attribute height（不随 width
  // 联动），只改宽度会横向拉伸成扁图，必须显式同设。
  var baseH = baseW * ratio;
  var MIN_S = 0.25, MAX_S = 3;

  // hover 右上角操作提示（pointer-events none，不挡交互）
  var wrap = pre.closest('.mermaid-wrap') || pre;
  var hint = document.createElement('div');
  hint.className = 'mermaid-hint';
  hint.setAttribute('data-darkreader-ignore', '');
  hint.textContent = 'Ctrl + 滚轮缩放';
  wrap.appendChild(hint);

  function applyScale(s) {
    var w = Math.round(baseW * s * 100) / 100;
    var h = Math.round(baseH * s * 100) / 100;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.style.width = w + 'px';
    svg.style.height = h + 'px';
  }
  function curScale() {
    var w = parseFloat(svg.getAttribute('width'));
    return w && baseW ? w / baseW : 1;
  }
  applyScale(1);  // 固化适配尺寸：maxWidth 解除后 svg 不会弹回 attribute 原始宽

  svg.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;  // 无修饰：滚动文章
    e.preventDefault();
    var ns = curScale() * Math.exp(-e.deltaY * 0.0015);
    ns = Math.max(MIN_S, Math.min(MAX_S, ns));
    var k = ns / curScale();
    var preRect = pre.getBoundingClientRect();
    var px = e.clientX - preRect.left;
    var py = e.clientY - preRect.top;
    // 指针下内容坐标（缩放前）→ 缩放后保持，实现指针锚点
    var cxp = pre.scrollLeft + px;
    var cyp = pre.scrollTop + py;
    applyScale(ns);
    pre.scrollLeft = cxp * k - px;
    pre.scrollTop = cyp * k - py;
  }, { passive: false });
}

/* ==================== 远程 mmd 文件渲染 ====================
   {{< mermaid-src "file.mmd" >}} shortcode 生成 <div class="mmd-src" data-src="...">
   浏览器端 fetch 文件内容 → 建 pre.mermaid → 复用 runMermaid 全链路。
   fetch 文本直接 textContent 注入，不经 HTML 解析器：
   源文件里的 &lt; 等实体不会被浏览器预吃，由 mermaid 自己解码。
   ============================================================ */
function runRemoteMermaid() {
  document.querySelectorAll('.mmd-src').forEach(function (div) {
    if (div.dataset.loading) return;
    div.dataset.loading = '1';
    fetch(div.dataset.src, { credentials: 'same-origin' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
      })
      .then(function (text) {
        var wrap = document.createElement('div');
        wrap.className = 'mermaid-wrap';
        wrap.setAttribute('data-darkreader-ignore', '');
        var pre = document.createElement('pre');
        pre.className = 'mermaid darkreader-ignore';
        pre.setAttribute('data-darkreader-ignore', '');
        pre.textContent = text;
        wrap.appendChild(pre);
        div.parentNode.replaceChild(wrap, div);
        runMermaid();
      })
      .catch(function (err) {
        div.classList.add('mmd-error');
        div.textContent = '⚠️ mmd 加载失败：' + div.dataset.name + '（' + err.message + '）';
      });
  });
}

document.addEventListener('DOMContentLoaded', function () {
  runRemoteMermaid();
  runMermaid();
  // Re-render mermaid inside details when they open
  document.addEventListener('toggle', function (e) {
    if (e.target.open) {
      setTimeout(runMermaid, 50);
    }
  });
});
