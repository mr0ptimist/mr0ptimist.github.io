(function() {
  var button = document.getElementById('publish-local-btn');
  if (!button) return;
  var overlay, stats, preparing, session, publishing = false;
  var path = button.getAttribute('data-publish-path');
  var destinations = {
    public: { section: 'posts', label: '公开版', bytes: button.getAttribute('data-publish-existing-bytes'),
      preview: button.getAttribute('data-publish-preview') },
    protect: { section: 'protect', label: 'protect 版', bytes: button.getAttribute('data-publish-protect-existing-bytes'),
      preview: button.getAttribute('data-publish-protect-preview') }
  };
  var preview;
  var service = new URL(button.getAttribute('data-publish-service') || 'http://127.0.0.1:1314', location.origin).href.replace(/\/$/, '');
  var pendingKey = 'local-publish:' + path.toLowerCase();
  var code = /\.(hlsl|glsl|usf|ush|ufh|shader|compute|cpp|c|cc|cxx|h|hpp|inl|cs|py|js|ts|metal|wgsl|spv|cso|dxil)$/i;

  function field(id) { return overlay.querySelector('#lp-' + id); }
  function size(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MiB' : (bytes / 1024).toFixed(1) + ' KiB';
  }
  function destinationLabel() { return destinations[field('destination').value].label; }
  function selectDestination(feedback) {
    var choice = field('destination').value, target = destinations[choice];
    if (!target) { field('confirm').disabled = true; return; }
    preview = new URL(target.preview, location.origin).href;
    field('path').textContent = path.replace(/\/content\/local\//i, '/content/' + target.section + '/')
      .replace(/\/index\.md$/i, '/').replace(/\.md$/i, '/');
    field('existing-label').textContent = '已有' + target.label + '实际体积';
    field('existing').textContent = target.bytes === null ? '尚未生成' : size(Number(target.bytes));
    field('warning').textContent = '重新生成会完整替换选中的 content/' + target.section + '/ 文章文件夹，以 local 源为准。';
    var supported = session && (Array.isArray(session.destinations) ? session.destinations.includes(choice) : choice === 'public');
    field('confirm').disabled = publishing || !stats || !supported;
    if (feedback && stats && !publishing) {
      status(supported ? '配置就绪，确认后开始生成' + target.label + '。' : '当前发布服务不支持此目标，请重启本地预览启动器后重试。', false, !supported);
    }
  }
  function close() { overlay.classList.remove('ps-open'); button.focus(); }
  function status(text, busy, error) {
    field('status-text').textContent = text;
    field('status').classList[busy ? 'add' : 'remove']('ps-busy');
    field('status').classList[error ? 'add' : 'remove']('ps-error');
  }
  function pending(value) {
    try {
      if (value) window.sessionStorage.setItem(pendingKey, JSON.stringify(value));
      else window.sessionStorage.removeItem(pendingKey);
    } catch (error) {}
  }
  async function request(route, method, body) {
    var headers = {};
    if (session) headers['X-GithubIO-Publish-Token'] = session.token;
    if (body) headers['Content-Type'] = 'application/json';
    var response = await fetch(service + route, { method: method || 'GET', headers: headers,
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(10000) });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || '发布服务返回 HTTP ' + response.status);
    return data;
  }
  function wait() { return new Promise(function(resolve) { setTimeout(resolve, 750); }); }
  async function watch(id) {
    for (;;) {
      var job = await request('/jobs/' + id);
      if (job.progress) {
        field('progress').hidden = !job.progress.total;
        field('progress').max = job.progress.total || 1;
        field('progress').value = job.progress.completed;
      }
      if (job.state === 'failed') throw new Error(job.error);
      if (job.state === 'succeeded') {
        var result = job.result;
        status('已生成' + destinationLabel() + '：' + result.converted + ' 张贴图转 RGB PNG' + (result.alpha_images ? '，另存 ' + result.alpha_images + ' 张 Alpha 图' : '') + '，实际体积 ' + size(result.output_bytes) + '。正在打开文章…', false);
        var url = new URL(result.preview_url || preview, location.origin);
        preview = new URL(url.pathname + url.search + url.hash, location.origin).href;
        for (var attempt = 0; attempt < 20; attempt++) {
          var page = await fetch(preview, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(5000) });
          if (page.ok) { pending(); location.href = preview; return; }
          await wait();
        }
        pending();
        status(destinationLabel() + '已生成，页面仍在更新。可通过顶部对应按钮查看。', false);
        return;
      }
      status(job.message || '正在生成' + destinationLabel() + '…', true);
      await wait();
    }
  }
  function budget() {
    if (!stats) return;
    var edge = Number(field('max-edge').value), bytes = stats.copied;
    stats.textures.forEach(function(image) {
      var scale = edge ? Math.min(1, edge / Math.max(image.w, image.h)) : 1;
      var w = Math.max(1, Math.round(image.w * scale)), h = Math.max(1, Math.round(image.h * scale));
      bytes += (w * 4 + 2) * h * 1.001 + 256 + 1024;
    });
    field('budget').textContent = '约 ' + size(bytes);
  }
  async function dimensions(image) {
    var exr = /\.exr$/i.test(image.name);
    var response = await fetch(image.url, { headers: { Range: exr ? 'bytes=0-4095' : 'bytes=0-147' }, cache: 'no-store' });
    if (response.status !== 206) {
      if (response.body) await response.body.cancel();
      throw new Error('服务器不支持文件头预估：' + image.name);
    }
    var bytes = await response.arrayBuffer(), view = new DataView(bytes), w, h;
    if (!exr) {
      if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x20534444) throw new Error('DDS 文件头无效：' + image.name);
      w = view.getUint32(16, true); h = view.getUint32(12, true);
    } else {
      if (bytes.byteLength < 8 || view.getUint32(0, true) !== 20000630) throw new Error('EXR 文件头无效：' + image.name);
      var raw = new Uint8Array(bytes), offset = 8;
      function string() {
        var start = offset;
        while (offset < raw.length && raw[offset]) offset++;
        if (offset >= raw.length) throw new Error('EXR 文件头过长：' + image.name);
        return new TextDecoder().decode(raw.subarray(start, offset++));
      }
      while (offset < raw.length && raw[offset]) {
        var name = string(), type = string();
        if (offset + 4 > raw.length) break;
        var length = view.getUint32(offset, true); offset += 4;
        if (offset + length > raw.length) break;
        if (name === 'dataWindow' && type === 'box2i' && length === 16) {
          w = view.getInt32(offset + 8, true) - view.getInt32(offset, true) + 1;
          h = view.getInt32(offset + 12, true) - view.getInt32(offset + 4, true) + 1;
          break;
        }
        offset += length;
      }
    }
    if (!(w > 0 && h > 0 && w <= 16384 && h <= 16384)) throw new Error('无法读取贴图尺寸：' + image.name);
    return { w: w, h: h };
  }
  async function prepare() {
    session = null;
    stats = null;
    field('confirm').disabled = true;
    field('budget').textContent = '计算中…';
    status('正在读取贴图尺寸，仅请求文件头…', true);
    try {
      var inventory = JSON.parse(document.getElementById('publish-local-files').textContent);
      var files = new Map(inventory.map(function(file) { return [file.name.toLowerCase(), file]; }));
      var base = new URL('.', location.href), used = new Set(), images = new Map(), excluded = new Set();
      var resources = new Map();
      inventory.forEach(function(file) { if (file.url) resources.set(new URL(file.url, base).pathname, file); });
      function local(value) {
        var url = new URL(value, base);
        if (url.origin !== base.origin) return null;
        var file = resources.get(url.pathname);
        if (!file && url.pathname.startsWith(base.pathname))
          file = files.get(decodeURIComponent(url.pathname.slice(base.pathname.length)).toLowerCase());
        return file && { name: file.name, bytes: file.bytes, url: file.url ? new URL(file.url, base).href : url.href };
      }
      function include(name) { if (files.has(name.toLowerCase())) used.add(name.toLowerCase()); }
      function sidecar(name) { include(name.replace(/\.[^.]+$/, '.json')); }
      include('index.md'); include('context.json');
      document.querySelectorAll('.post-content img[src], .post-cover img[src], .entry-cover img[src]').forEach(function(img) {
        var file = local(img.src);
        if (!file) return;
        images.set(file.name.toLowerCase(), file);
        include(file.name); sidecar(file.name);
      });
      document.querySelectorAll('.post-content a[href]').forEach(function(link) {
        var url = new URL(link.href, base);
        if (['winfs:', 'vscode:', 'cc:', 'cca:', 'file:'].includes(url.protocol)) { excluded.add(link.href); return; }
        var file = local(link.href);
        if (!file) return;
        if (code.test(file.name)) { excluded.add(file.name); sidecar(file.name); }
        else if (/\.(json|md|txt|html|csv|css)$/i.test(file.name)) include(file.name);
      });
      var textures = Array.from(images.values()).filter(function(image) { return /\.(dds|exr)$/i.test(image.name); });
      var original = 0, copied = 0;
      used.forEach(function(name) {
        var bytes = files.get(name).bytes;
        original += bytes;
        if (!/\.(dds|exr)$/i.test(name)) copied += bytes;
      });
      field('images').textContent = images.size + ' 张 · ' + textures.length + ' 张转 PNG';
      field('source').textContent = size(original);
      field('code').textContent = excluded.size + ' 个源码链接';
      var results = await Promise.all([Promise.all(textures.map(dimensions)), request('/session')]);
      var headers = results[0]; session = results[1];
      stats = { textures: headers, copied: copied + 1024 };
      budget();
      selectDestination(true);
    } catch (error) {
      field('budget').textContent = '暂时无法预估';
      status(error.message + '；请确认本地预览启动器已启动发布服务，关闭后重试。', false, true);
    }
  }
  function create() {
    overlay = document.createElement('div');
    overlay.id = 'publish-local-overlay';
    overlay.className = 'ps-overlay lp-overlay';
    overlay.innerHTML = '<section class="ps-card" role="dialog" aria-modal="true" aria-labelledby="lp-title">' +
      '<div class="ps-head"><span id="lp-title">生成文章副本</span><button id="lp-close" class="ps-close" aria-label="关闭">✕</button></div>' +
      '<div class="ps-body"><div class="ps-row"><label class="ps-label" for="lp-destination">生成目标</label>' +
      '<select id="lp-destination"><option value="public">public（随公开博客发布）</option><option value="protect">protect（不随公开博客发布）</option></select></div>' +
      '<div class="ps-row"><span class="ps-label">生成到</span><div id="lp-path" class="lp-path"></div></div>' +
      '<div class="ps-row"><label class="ps-label" for="lp-max-edge">DDS / EXR 转 PNG · 贴图尺寸</label>' +
      '<select id="lp-max-edge"><option value="0">原尺寸（默认）</option><option value="2048">最长边 2048</option><option value="1024">最长边 1024</option></select>' +
      '<p class="ps-hint">保持宽高比，小图不放大。导出 mip 0 / slice 0；PNG 默认显示完整 RGB，Alpha 单独保存供通道查看。已有 PNG、JPG 等图片原样保留。</p></div>' +
      '<div class="lp-stats"><div class="lp-stat"><span class="ps-label">文章图片</span><strong id="lp-images">统计中…</strong></div>' +
      '<div class="lp-stat"><span class="ps-label">引用资源原始体积</span><strong id="lp-source">统计中…</strong></div>' +
      '<div class="lp-stat"><span id="lp-existing-label" class="ps-label"></span><strong id="lp-existing"></strong></div>' +
      '<div class="lp-stat"><span class="ps-label">省略代码文件，保留 sidecar</span><strong id="lp-code">统计中…</strong></div></div>' +
      '<p class="ps-hint">未压缩数据量（上限参考）：<span id="lp-budget">计算中…</span>。按 RGB+Alpha 最多 4 字节/像素，加附件和少量余量计算，未考虑 PNG 压缩。已有目标版本体积仅供参考，本次实际体积会在生成完成后统计。</p>' +
      '<div id="lp-warning" class="lp-warning"></div></div>' +
      '<div id="lp-status" class="ps-status" role="status" aria-live="polite"><span class="ps-spin"></span><span id="lp-status-text"></span>' +
      '<progress id="lp-progress" class="lp-progress" max="1" value="0" aria-label="贴图导出进度" hidden></progress></div>' +
      '<div class="ps-foot"><button id="lp-cancel" class="ps-btn">取消</button><button id="lp-confirm" class="ps-btn primary" disabled>确认生成</button></div></section>';
    document.body.appendChild(overlay);
    field('destination').value = 'public';
    selectDestination(false);
    field('close').addEventListener('click', close);
    field('cancel').addEventListener('click', close);
    field('max-edge').addEventListener('change', budget);
    field('destination').addEventListener('change', function() { selectDestination(true); });
    overlay.addEventListener('click', function(event) { if (event.target === overlay) close(); });
    document.addEventListener('keydown', function(event) { if (event.key === 'Escape' && overlay.classList.contains('ps-open')) close(); });
    field('confirm').addEventListener('click', async function() {
      if (field('confirm').disabled) return;
      publishing = true;
      field('confirm').disabled = true;
      field('max-edge').disabled = true;
      field('destination').disabled = true;
      status('正在提交发布任务…', true);
      try {
        var edge = Number(field('max-edge').value);
        var destination = field('destination').value;
        var job = await request('/publish', 'POST', { article: path, max_edge: edge, destination: destination });
        pending({ id: job.id, edge: edge, destination: destination });
        console.info('[local-publish] 发布任务已接收', job.id);
        await watch(job.id);
      } catch (error) {
        pending();
        status('生成失败：' + error.message, false, true);
        console.error('[local-publish]', error);
      } finally {
        publishing = false;
        field('max-edge').disabled = false;
        field('destination').disabled = false;
        selectDestination(false);
      }
    });
  }
  button.addEventListener('click', function() {
    if (!overlay) create();
    overlay.classList.add('ps-open');
    field('close').focus();
    if (preparing || publishing) return;
    preparing = prepare().finally(function() { preparing = null; });
  });
  try {
    var saved = JSON.parse(window.sessionStorage.getItem(pendingKey));
    if (saved) {
      create(); overlay.classList.add('ps-open'); field('max-edge').value = String(saved.edge);
      field('destination').value = saved.destination || 'public';
      selectDestination(false);
      publishing = true; field('max-edge').disabled = true; field('destination').disabled = true;
      prepare().then(function() { if (!session) throw new Error('无法连接本地发布服务'); return watch(saved.id); })
        .catch(function(error) { pending(); status('生成失败：' + error.message, false, true); })
        .finally(function() { publishing = false; field('max-edge').disabled = false; field('destination').disabled = false; selectDestination(false); });
    }
  } catch (error) {}
})();
