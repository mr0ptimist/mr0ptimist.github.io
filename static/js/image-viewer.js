// =============================================================================
// image-viewer.js — 图片查看器 UI 入口
// =============================================================================
// 最后加载的 JS 文件，初始化所有图片交互功能。
// 依赖：worker-shared.js > dds-parser.js > exr-parser.js > decode-worker.js
//
// 本文件负责：
//   - Worker 池管理（4 个 Worker，round-robin 调度）
//   - 图片懒加载（IntersectionObserver，800px rootMargin）
//   - Channel viewer 工具栏（R/G/B/A/RGB/RGBA 按钮）
//   - Pixel inspector（中键点击固定像素值、右键拖拽浮动查看）
//   - Mip level / Array slice 滑杆（从 DDS header + JSON sidecar 读取）
//   - 本地路径复制按钮（依赖 window.ImageViewerConfig.workingDir）
//   - 缓存管理（ddsCache / exrCache / pxCache / jsonCache）
//
// 新增功能的正确姿势：
//   1. 新 UI 控件 → 在 processImage() 里仿照 toolbar/meta 模式添加
//   2. 新图片格式（如 KTX/HDR）→ 在 loadImage() 加扩展名分支，解析器放独立 JS 文件
//   3. 新工具栏按钮 → 在 channels.forEach 之后加，参考 flipBtn 的写法
//   4. 新缓存策略 → 修改 ddsCache/exrCache/pxCache/jsonCache 的使用方式
//   5. 配置项 → 通过 window.ImageViewerConfig 传入（在 extend_footer.html 注入）
//   6. 不要往 extend_footer.html 里加 JS 代码，只通过 ImageViewerConfig 传配置
// =============================================================================
(function(){
  var c = document.querySelector('.post-content');
  var listThumbs = document.querySelectorAll('.entry-thumb img');

  // 列表页缩略图：解码后缩到显示尺寸（≤200px），小图存入 Cache Storage
  // 缓存键 = 图片 URL，值 = 小图 blob（几 KB~几十 KB）。刷新时命中直接画，跳过下载与解码。
  // 想强制失效旧缓存（如重新导出了同名 DDS）时，升 THUMB_CACHE 版本号。
  var THUMB_CACHE = 'blog-thumb-v2';
  var thumbCachePromise = null;
  function thumbCache() {
    if (typeof caches === 'undefined') return Promise.resolve(null);
    if (!thumbCachePromise) thumbCachePromise = caches.open(THUMB_CACHE).catch(function () { return null; });
    return thumbCachePromise;
  }
  function cacheThumb(url, cv) {
    if (!cv.toBlob) return;
    cv.toBlob(function (blob) {
      if (!blob) return;
      thumbCache().then(function (c) { if (c) c.put(url, new Response(blob)).catch(function () { }); });
    }, 'image/webp', 0.9);
  }

  // Simple thumbnail render — just a canvas, no channel UI
  // 大图先全尺寸中转再缩放：画布只保留显示尺寸（原实现保留全尺寸画布，11352² 一张就 515MB 常驻）
  function renderThumb(img, w, h, pixels) {
    // Strip alpha: force RGB view
    for (var i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    var cap = 200, maxDim = Math.max(w, h);
    var cv = document.createElement('canvas');
    cv.className = 'thumb-canvas';
    if (maxDim > cap) {
      var s = cap / maxDim, dw = Math.round(w * s), dh = Math.round(h * s);
      var big = document.createElement('canvas');   // 全尺寸中转，缩放后立刻释放
      big.width = w; big.height = h;
      big.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
      cv.width = dw; cv.height = dh;
      cv.getContext('2d').drawImage(big, 0, 0, dw, dh);
      big.width = big.height = 0;
    } else {
      cv.width = w; cv.height = h;
      cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
    }
    cv.style.width = cv.width + 'px';
    cv.style.height = cv.height + 'px';
    cv.style.borderRadius = '4px';
    img.parentNode.insertBefore(cv, img);
    img.style.display = 'none';
    return cv;
  }

  // 把竖直翻转烘进像素（原为 CSS scaleY(-1)；缓存条目不带 CSS 变换，两者必须一致）
  function bakeFlip(cv) {
    var tmp = document.createElement('canvas');
    tmp.width = cv.width; tmp.height = cv.height;
    tmp.getContext('2d').drawImage(cv, 0, 0);
    var ctx = cv.getContext('2d');
    ctx.save(); ctx.scale(1, -1); ctx.drawImage(tmp, 0, -cv.height); ctx.restore();
    tmp.width = tmp.height = 0;
  }

  // 缓存命中：blob → Image → 画布，不发起任何解码相关请求
  function drawCachedThumb(img, blob) {
    var objUrl = URL.createObjectURL(blob);
    var im = new Image();
    im.onload = function () {
      var cv = document.createElement('canvas');
      cv.className = 'thumb-canvas';
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      cv.getContext('2d').drawImage(im, 0, 0);
      cv.style.width = cv.width + 'px';
      cv.style.height = cv.height + 'px';
      cv.style.borderRadius = '4px';
      img.parentNode.insertBefore(cv, img);
      img.style.display = 'none';
      URL.revokeObjectURL(objUrl);
    };
    im.onerror = function () { URL.revokeObjectURL(objUrl); };
    im.src = objUrl;
  }

  // Process list-page thumbnails (lightweight, no channel UI)
  listThumbs.forEach(function(img) {
    if (!/\.(dds|exr)(\?|$)/i.test(img.src)) return;   // 普通图片浏览器原生显示，不走解码/缓存路径
    var jsonUrl = img.src.replace(/\.[^.]+$/, '.json');
    var flipY = false;
    var done = false;

    function doThumb(pixels, w, h) {
      if (done) return; done = true;
      var cv;
      if (flipY) {
        // Flip vertically in-place
        var row = new Uint8ClampedArray(w * 4);
        for (var y = 0; y < h / 2; y++) {
          var top = y * w * 4, bot = (h - 1 - y) * w * 4;
          row.set(new Uint8ClampedArray(pixels.buffer, top, w * 4));
          new Uint8ClampedArray(pixels.buffer, top, w * 4).set(new Uint8ClampedArray(pixels.buffer, bot, w * 4));
          new Uint8ClampedArray(pixels.buffer, bot, w * 4).set(row);
        }
        cv = renderThumb(img, w, h, pixels);
        bakeFlip(cv);
      } else {
        cv = renderThumb(img, w, h, pixels);
      }
      cacheThumb(img.src, cv);
    }

    function decodeThumb() {
      // Check JSON sidecar for flip_y
      fetch(jsonUrl).then(function(r) { if (r.ok) return r.json(); }).then(function(d) {
        if (d && d.flip_y) flipY = true;
      }).catch(function(){});

      if (/\.dds$/i.test(img.src)) {
        fetch(img.src).then(function(r) { if (!r.ok) return; return r.arrayBuffer(); }).then(function(buf) {
          if (!buf) return;
          var dds = DDS.parse(buf);
          if (!dds) { console.warn('[thumb] DDS.parse 失败: ' + img.src.split('/').pop()); return; }
          var mip0 = dds.getMip(0);
          if (!mip0) { console.warn('[thumb] getMip(0) 为空: ' + img.src.split('/').pop()); return; }
          // 单通道缩略图同样按 R 通道着色（与文章内查看器一致）
          var chm = chMapFromDxgi(dds.fmt.dxgi);
          if (chm.R && !chm.G && !chm.B) {
            for (var gi = 1; gi < mip0.length; gi += 4) { mip0[gi] = 0; mip0[gi+1] = 0; }
          }
          // Wait a tick for JSON to arrive
          setTimeout(function(){ doThumb(mip0, dds.w, dds.h); }, 50);
        }).catch(function(e){ console.warn('[thumb] DDS 缩略图异常: ' + img.src.split('/').pop() + ' — ' + e); });
      } else if (/\.exr$/i.test(img.src)) {
        fetch(img.src).then(function(r) { if (!r.ok) return; return r.arrayBuffer(); }).then(function(buf) {
          if (!buf) return;
          var exr = EXR.parse(buf);
          if (!exr) return;
          var rgba8 = EXR.toRGBA8(exr);
          if (!rgba8) return;
          setTimeout(function(){ doThumb(rgba8, exr.w, exr.h); }, 50);
        }).catch(function(e){ console.warn('[thumb] EXR 缩略图异常: ' + img.src.split('/').pop() + ' — ' + e); });
      }
    }

    // 先查缓存：命中直接画（不下载、不解码）；未命中才走解码路径
    thumbCache().then(function (c) {
      if (!c) { decodeThumb(); return; }
      c.match(img.src).then(function (res) {
        if (!res) { decodeThumb(); return; }
        res.blob().then(function (blob) {
          if (done) return;
          done = true;
          drawCachedThumb(img, blob);
        });
      }).catch(function () { decodeThumb(); });
    }).catch(function () { decodeThumb(); });
  });

  // ---- Worker pool (off-main-thread DDS/EXR decode) ----
  // 不变量：每个请求恰好结算一次（each request settles exactly once）。6 条结束路径（回包 / onerror /
  // messageerror / 超时 / 构造失败 / postMessage 抛错）都只摘自己那条 pending，绝不静默挂起、绝不替别人收尾。
  var WORKER_REQUEST_TIMEOUT_MS = 15000; // 单请求超时：正常数秒内回包，超时即判死走失败分支

  var decodeWorker = (function(){
    var NUM_WORKERS = 4;
    var workerStates = [];  // 每个实例一份状态：{w, pending:{id:1}, dead, failReason}
    var pendingById = {};   // id -> {callback, owner, timer}；条目里带 owner 归属，便于按 worker 批量结算
    var nextId = 0;
    var nextWorker = 0;

    var myScript = document.querySelector('script[src*="image-viewer.js"]');
    var workerUrl = myScript ? myScript.src.replace(/image-viewer\.js(\?[^"]*)?$/, 'decode-worker.js?v=25') : '/js/decode-worker.js?v=25';

    // onerror 事件里能拿到的信息优先用于错误显示，拿不到就用通用文案
    function workerErrorText(ev, fallback) {
      var parts = [];
      if (ev && ev.message) parts.push(String(ev.message));
      if (ev && ev.filename) {
        var f = String(ev.filename).split('/').pop();
        parts.push(f + (ev.lineno ? ':' + ev.lineno : ''));
      }
      return parts.length ? parts.join(' @ ') : fallback;
    }

    // 唯一结算入口：同一个 id 只有第一次调用生效，之后一律忽略（恰好一次）
    function settleOnce(id, result) {
      if (id === undefined || id === null) return false;
      var entry = pendingById[id];
      if (!entry) return false;   // 已被其它路径结算（超时/错误/回包抢跑）→ 忽略
      delete pendingById[id];
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      if (entry.owner && entry.owner.pending) delete entry.owner.pending[id];
      try { entry.callback(result); } catch (err) { /* 调用方自身异常不牵连其它请求 */ }
      return true;
    }

    // worker 级故障：只结算这个实例名下的请求，其它 worker 上排队的请求不受影响
    function failWorker(owner, reason) {
      owner.dead = true;
      owner.failReason = reason;
      var ids = Object.keys(owner.pending);
      for (var k = 0; k < ids.length; k++) settleOnce(ids[k], {id: +ids[k], ok: false, error: reason});
    }

    for (var i = 0; i < NUM_WORKERS; i++) {
      var owner = {w: null, pending: {}, dead: false, failReason: null};
      workerStates.push(owner);
      var w = null;
      try {
        w = new Worker(workerUrl);
      } catch (err) {
        // 构造失败（URL 非法 / CSP 拦截等）：实例标死，轮到它的请求异步失败
        owner.dead = true;
        owner.failReason = 'worker init failed: ' + ((err && err.message) ? err.message : String(err));
        continue;
      }
      owner.w = w;
      w.onmessage = (function(o) {
        return function(e) { settleOnce(e && e.data ? e.data.id : undefined, e.data); };
      })(owner);
      w.onerror = (function(o) {
        return function(ev) {
          if (ev && ev.preventDefault) ev.preventDefault();  // 阻止冒泡成全局 error
          failWorker(o, workerErrorText(ev, 'worker error'));
        };
      })(owner);
      w.onmessageerror = (function(o) {
        return function(ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          failWorker(o, 'worker messageerror (回包无法反序列化)');
        };
      })(owner);
    }

    return {
      decode: function(type, buffer, callback, transfer, typeOverride, targetDim) {
        var id = ++nextId;
        // 轮询挑下一个存活实例（全活时等价于原来的 round-robin；死掉的槽位直接跳过）
        var owner = null;
        for (var k = 0; k < NUM_WORKERS; k++) {
          var cand = workerStates[(nextWorker + k) % NUM_WORKERS];
          if (cand && !cand.dead && cand.w) { owner = cand; nextWorker = (nextWorker + k + 1) % NUM_WORKERS; break; }
        }
        if (!owner) {
          // 实例不可用：异步失败（保持回调时序一致），绝不静默挂起
          var why = (workerStates[0] && workerStates[0].failReason) ? workerStates[0].failReason : 'worker unavailable';
          setTimeout(function() { callback({id: id, ok: false, error: why}); }, 0);
          return id;
        }
        var entry = {callback: callback, owner: owner, timer: null};
        pendingById[id] = entry;
        owner.pending[id] = 1;
        // 兜底超时：前 3 条路径都没触发时也必须给这条请求一个了结
        entry.timer = setTimeout(function() {
          settleOnce(id, {id: id, ok: false, error: 'decode timeout (' + (WORKER_REQUEST_TIMEOUT_MS / 1000) + 's)'});
        }, WORKER_REQUEST_TIMEOUT_MS);
        var msg = {id:id, type:type, buffer:buffer};
        if (typeOverride) msg.typeOverride = typeOverride;
        if (targetDim) msg.targetDim = targetDim;
        try {
          if (transfer) owner.w.postMessage(msg, [buffer]);
          else owner.w.postMessage(msg);
        } catch (err) {
          settleOnce(id, {id: id, ok: false, error: 'postMessage failed: ' + ((err && err.message) ? err.message : String(err))});
        }
        return id;
      }
    };
  })();

  // ---- Decode Cache ----
  var ddsCache = new Map();
  var exrCache = new Map();
  var pxCache = new Map();
  var jsonCache = new Map();

  // Fast pixel read via Canvas 2D
  function readPixels2D(img, w, h) {
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  }

  // Channel map from DXGI format code
  var DXGI_CHANNELS = {
    2:'RGBA', 6:'RGB', 10:'RGBA', 11:'RGBA', 13:'RGBA', 16:'RG',
    20:'R', 24:'RGBA', 26:'RGB', 27:'RGBA', 28:'RGBA', 29:'RGBA', 31:'RGBA', 45:'R', 87:'RGBA',
    34:'RG', 35:'RG', 36:'RG', 37:'RG',
    40:'R', 41:'R',
    49:'RG', 51:'RG', 68:'RGB', 69:'RGB',
    53:'R', 54:'R', 55:'R', 56:'R', 57:'R', 58:'R',
    61:'R', 65:'R', 67:'RGB',
    70:'RGB', 71:'RGB', 72:'RGB',
    73:'RGBA', 74:'RGBA', 75:'RGBA', 76:'RGBA', 77:'RGBA', 78:'RGBA', 79:'RGBA',
    80:'R', 81:'R', 82:'RG', 83:'RG', 84:'RG',
    85:'RGB', 86:'RGBA',
    94:'RGB', 95:'RGB', 96:'RGB',
    97:'RGBA', 98:'RGBA', 99:'RGBA'
  };
  function chMapFromDxgi(dxgi) {
    var ch = DXGI_CHANNELS[dxgi] || '';
    return {R:ch.indexOf('R')>=0, G:ch.indexOf('G')>=0, B:ch.indexOf('B')>=0, A:ch.indexOf('A')>=0};
  }

  // 列表页没有 .post-content：提前 return 保护 worker 池/查看器，但它必须排在缩略图路径用到的
  // 符号之后——缩略图回调是异步的，return 排在 DXGI_CHANNELS 之前曾让所有 DDS 缩略图静默失败
  if (!c) return;

  // ---- Process single image ----
  function processImage(img, w, h, ddsPixels) {
    var straight = ddsPixels || null;
    var curW = w, curH = h;
    // Range remap state
    var normMin = 0, normMax = 1, curLo = 0, curHi = 1;
    var rawPixels = null; // Float32Array (EXR only)
    var ddsInfo0 = ddsCache.get(img.src);
    var exrInfo0 = exrCache.get(img.src);
    var fam0 = '';
    var isExr = !!exrInfo0;
    if (ddsInfo0) { normMin = ddsInfo0.normMin || 0; normMax = Number.isFinite(ddsInfo0.normMax) ? ddsInfo0.normMax : 1; rawPixels = ddsInfo0.rawPixels; fam0 = ddsInfo0.dds ? ddsInfo0.dds.fmt.family : ''; }
    else if (exrInfo0) { normMin = exrInfo0.normMin || 0; normMax = Number.isFinite(exrInfo0.normMax) ? exrInfo0.normMax : 1; rawPixels = exrInfo0.rawPixels; fam0 = 'EXR'; }
    curLo = normMin; curHi = normMax;
    // 单通道格式（BC4/R8/R16/R32F/D32S8 等）：按 R 通道着色（RenderDoc 风格）——
    // G/B 清零，默认 RGB 视图呈红色，点 R 通道按钮才看灰度
    if (ddsInfo0 && ddsInfo0.dds && straight) {
      var chm0 = chMapFromDxgi(ddsInfo0.dds.fmt.dxgi);
      if (chm0.R && !chm0.G && !chm0.B) {
        for (var gi = 1; gi < straight.length; gi += 4) { straight[gi] = 0; straight[gi+1] = 0; }
      }
    }
    var wrapper = document.createElement('div');
    wrapper.className = 'channel-container';

    var displayW = w, displayH = h;
    var maxDim = Math.max(w, h);
    var tinyDim = Math.min(w, h) <= 4;
    var inTable = img.closest('td') || img.closest('th');
    if (inTable) {
      wrapper.style.width = '100%';
      var tbl = img.closest('table');
      if (tbl) {
        var firstRow = tbl.querySelector('tr');
        if (firstRow) {
          var numCols = firstRow.querySelectorAll('th, td').length;
          var cell = img.closest('th') || img.closest('td');
          if (cell && !cell.style.width) cell.style.width = (100 / numCols) + '%';
        }
      }
    } else {
      if (maxDim > 1000) {
        var ds = 1000 / maxDim;
        displayW = Math.round(w * ds); displayH = Math.round(h * ds);
      } else if (maxDim < 540) {
        var us = 540 / maxDim;
        displayW = Math.round(w * us); displayH = Math.round(h * us);
        wrapper.classList.add('channel-small');
      }
      if (Math.min(displayW, displayH) > 500) {
        var s = 500 / Math.min(displayW, displayH);
        displayW = Math.round(displayW * s); displayH = Math.round(displayH * s);
      }
      if (tinyDim) {
        if (displayW < 20) displayW = 20;
        if (displayH < 20) displayH = 20;
      }
      if (displayW !== w && !ddsPixels) {
        img.style.width = displayW + 'px';
      }
    }
    if (inTable && !ddsPixels) img.style.width = '100%';

    var tb = document.createElement('div');
    tb.className = 'channel-toolbar';

    function sizeCanvas(cv, cw, ch) {
      var maxD = Math.max(cw, ch);
      var dw = cw, dh = ch;
      var tin = Math.min(cw, ch) <= 4;
      if (inTable) {
        cv.style.width = '100%';
        cv.style.height = is1D ? '30px' : 'auto';
      } else {
        if (maxD > 1000) { var ds = 1000 / maxD; dw = Math.round(cw * ds); dh = Math.round(ch * ds); }
        else if (maxD < 540) { var us = 540 / maxD; dw = Math.round(cw * us); dh = Math.round(ch * us); }
        if (Math.min(dw, dh) > 500) { var s2 = 500 / Math.min(dw, dh); dw = Math.round(dw * s2); dh = Math.round(dh * s2); }
        if (tin) { if (dw < 20) dw = 20; if (dh < 20) dh = 20; }
        if (is1D) dh = 30;
        cv.style.width = dw + 'px';
        cv.style.height = dh + 'px';
      }
      return {dw: dw, dh: dh};
    }

    var channels = ['RGB','R','G','B','A','RGBA'];
    channels.forEach(function(ch) {
      var b = document.createElement('button');
      b.className = 'channel-btn'; b.textContent = ch; b.dataset.ch = ch;
      if (ch === 'RGB') b.classList.add('active');

      b.addEventListener('click', function() {
        tb.querySelectorAll('.channel-btn').forEach(function(x) { x.classList.remove('active'); });
        b.classList.add('active');
        if (!straight) {
          straight = pxCache.get(img.src);
          if (!straight) {
            straight = readPixels2D(img, w, h);
            pxCache.set(img.src, straight);
          }
        }
        // Apply range remap first (DDS/EXR only)
        var remapPx = straight;
        if (ddsPixels || isExr) {
          var needsRemap = curLo !== normMin || curHi !== normMax;
          if (needsRemap && window.ColorRemap) {
            remapPx = ColorRemap.remapPixels(straight, curLo, curHi, normMin, normMax, rawPixels);
          } else {
            remapPx = new Uint8ClampedArray(straight);
          }
        }
        var px = new Uint8ClampedArray(remapPx);
        if (ch === 'RGB') {
          for (var i = 3; i < px.length; i += 4) px[i] = 255;
          tb.classList.remove('pinned');
        } else if (ch === 'A') {
          for (var i = 0; i < px.length; i += 4) { var a = px[i+3]; px[i]=a; px[i+1]=a; px[i+2]=a; px[i+3]=255; }
          tb.classList.add('pinned');
        } else if (ch === 'RGBA') {
          tb.classList.add('pinned'); // Canvas 自行合成透明度，保留独立 RGB。
        } else {
          var ci = {'R':0,'G':1,'B':2}[ch];
          for (var i = 0; i < px.length; i += 4) { var v = px[i+ci]; px[i]=v; px[i+1]=v; px[i+2]=v; px[i+3]=255; }
          tb.classList.add('pinned');
        }
        if (!ddsPixels) img.style.display = 'none';
        var cv = wrapper.querySelector('canvas');
        if (!cv) { cv = document.createElement('canvas'); cv.className = 'channel-canvas'; if (samplingNearest) cv.classList.add('sampling-nearest'); wrapper.appendChild(cv); }
        cv.width = curW; cv.height = curH;
        sizeCanvas(cv, curW, curH);
        cv.getContext('2d').putImageData(new ImageData(px, curW, curH), 0, 0);
      });
      tb.appendChild(b);
    });

    // Flip Y button
    var flipBtn = document.createElement('button');
    flipBtn.className = 'channel-btn flip-btn';
    flipBtn.textContent = '\u2195';
    flipBtn.title = '\u5782\u76f4\u7ffb\u8f6c';
    flipBtn.addEventListener('click', function() {
      var el = wrapper.querySelector('canvas') || wrapper.querySelector('img');
      if (!el) return;
      var flipped = el.style.transform === 'scaleY(-1)';
      el.style.transform = flipped ? '' : 'scaleY(-1)';
      flipBtn.classList.toggle('active', !flipped);
    });
    tb.appendChild(flipBtn);

    // --- Range remap sliders (DDS/EXR only) ---
    var rangeRow = null, loSlider = null, hiSlider = null, loLabel = null, hiLabel = null;
    var publishedData = jsonCache.get(img.src.replace(/\.[^.]+$/, '.json'));
    var publishedPng = /\.png$/i.test(img.src) && publishedData && publishedData.publication;
    var showRange = !publishedPng && ColorRemap && ColorRemap.needsRange(fam0, isExr);
    if (showRange) {
      var rangeSpacer = document.createElement('div');
      rangeSpacer.style.cssText = 'flex-basis:100%;height:0';
      tb.appendChild(rangeSpacer);
      rangeRow = document.createElement('div');
      rangeRow.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:2px 3px;background:rgba(0,0,0,0.45);border-radius:3px;margin:1px 0;width:auto';

      loLabel = document.createElement('span');
      loLabel.style.cssText = 'color:#aaa;font-size:10px;min-width:28px;text-align:center';
      loLabel.textContent = curLo.toFixed(2);

      loSlider = document.createElement('input');
      loSlider.type = 'range';
      loSlider.min = normMin; loSlider.max = normMax; loSlider.step = (normMax - normMin) / 200; loSlider.value = curLo;
      loSlider.style.cssText = 'width:50px;height:10px;cursor:pointer;accent-color:#666';
      loSlider.title = 'Black point (Lo)';
      loSlider.addEventListener('input', function(e) {
        e.stopPropagation();
        curLo = parseFloat(loSlider.value);
        if (curLo > curHi) { curLo = curHi; loSlider.value = curLo; }
        loLabel.textContent = curLo.toFixed(2);
        renderRemapped();
      });

      hiLabel = document.createElement('span');
      hiLabel.style.cssText = 'color:#fff;font-size:10px;min-width:28px;text-align:center';
      hiLabel.textContent = curHi.toFixed(2);

      hiSlider = document.createElement('input');
      hiSlider.type = 'range';
      hiSlider.min = normMin; hiSlider.max = normMax; hiSlider.step = (normMax - normMin) / 200; hiSlider.value = curHi;
      hiSlider.style.cssText = 'width:50px;height:10px;cursor:pointer;accent-color:#e8eaed';
      hiSlider.title = 'White point (Hi)';
      hiSlider.addEventListener('input', function(e) {
        e.stopPropagation();
        curHi = parseFloat(hiSlider.value);
        if (curHi < curLo) { curHi = curLo; hiSlider.value = curHi; }
        hiLabel.textContent = curHi.toFixed(2);
        renderRemapped();
      });

      loSlider.addEventListener('mousedown', function() {
        for (var c = tb.firstChild; c; c = c.nextSibling) { if (c !== rangeRow) c.style.opacity = '0'; }
        var m = wrapper.querySelector('.channel-meta'); if (m) m.style.opacity = '0';
      });
      loSlider.addEventListener('mouseup', function() {
        for (var c = tb.firstChild; c; c = c.nextSibling) { c.style.opacity = ''; }
        var m = wrapper.querySelector('.channel-meta'); if (m) m.style.opacity = '';
      });
      hiSlider.addEventListener('mousedown', function() {
        for (var c = tb.firstChild; c; c = c.nextSibling) { if (c !== rangeRow) c.style.opacity = '0'; }
        var m = wrapper.querySelector('.channel-meta'); if (m) m.style.opacity = '0';
      });
      hiSlider.addEventListener('mouseup', function() {
        for (var c = tb.firstChild; c; c = c.nextSibling) { c.style.opacity = ''; }
        var m = wrapper.querySelector('.channel-meta'); if (m) m.style.opacity = '';
      });

      var resetBtn = document.createElement('button');
      resetBtn.className = 'channel-btn';
      resetBtn.textContent = '↺';
      resetBtn.title = 'Reset range';
      resetBtn.addEventListener('click', function() {
        curLo = normMin; curHi = normMax;
        loSlider.value = curLo; hiSlider.value = curHi;
        loLabel.textContent = curLo.toFixed(2); hiLabel.textContent = curHi.toFixed(2);
        renderRemapped();
      });

      rangeRow.appendChild(loLabel);
      rangeRow.appendChild(loSlider);
      rangeRow.appendChild(hiSlider);
      rangeRow.appendChild(hiLabel);
      rangeRow.appendChild(resetBtn);
      tb.appendChild(rangeRow);
    }

    function renderRemapped() {
      var activeBtn = tb.querySelector('.channel-btn.active');
      if (activeBtn) activeBtn.click();
    }

    // --- bottom toolbar row (sampling) ---
    var bottomRow = document.createElement('div');
    bottomRow.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:3px;width:100%';

    var samplingBtn = document.createElement('button');
    samplingBtn.className = 'channel-btn sampling-btn';
    samplingBtn.textContent = '\u70b9';
    samplingBtn.title = '\u70b9\u91c7\u6837 / \u7ebf\u6027\u91c7\u6837';
    var samplingNearest = false;
    samplingBtn.addEventListener('click', function() {
      samplingNearest = !samplingNearest;
      samplingBtn.classList.toggle('active', samplingNearest);
      var cvs = wrapper.querySelectorAll('canvas');
      cvs.forEach(function(cv) { cv.classList.toggle('sampling-nearest', samplingNearest); });
    });
    bottomRow.appendChild(samplingBtn);

    // DDS/EXR: create canvas immediately
    var is1D = h === 1 && ddsPixels && ddsCache.get(img.src) && ddsCache.get(img.src).dds && ddsCache.get(img.src).dds.resDim === 2;
    if (is1D) displayH = 30;
    var initialSize = null;
    if (ddsPixels) {
      var cv = document.createElement('canvas');
      cv.className = 'channel-canvas'; cv.width = w; cv.height = h;
      cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(straight), w, h), 0, 0);
      initialSize = sizeCanvas(cv, w, h);
      var parent = img.parentNode;
      if (parent.tagName === 'P') {
        parent.parentNode.insertBefore(wrapper, parent);
        wrapper.appendChild(cv);
        if (!parent.textContent.trim() && parent.children.length === 0) parent.remove();
      } else {
        img.parentNode.insertBefore(wrapper, img);
        wrapper.appendChild(cv);
      }
      img.style.display = 'none';
    } else {
      var parent = img.parentNode;
      if (parent.tagName === 'P') {
        parent.parentNode.insertBefore(wrapper, parent);
        wrapper.appendChild(img);
        if (!parent.textContent.trim() && parent.children.length === 0) parent.remove();
      } else {
        img.parentNode.insertBefore(wrapper, img);
        wrapper.appendChild(img);
      }
    }
    wrapper.appendChild(tb);

    // Display size badge (bottom-right corner)
    var sizeBadge = document.createElement('div');
    sizeBadge.className = 'channel-size-badge';
    if (initialSize) {
      sizeBadge.textContent = initialSize.dw + '\u00d7' + initialSize.dh + (initialSize.dw !== w || initialSize.dh !== h ? '  (' + w + '\u00d7' + h + ')' : '');
    } else {
      sizeBadge.textContent = displayW + '\u00d7' + displayH + (displayW !== w || displayH !== h ? '  (' + w + '\u00d7' + h + ')' : '');
    }
    wrapper.appendChild(sizeBadge);

    // Timing badge (bottom-left corner)
    if (img._t0) {
      var ms = (performance.now() - img._t0).toFixed(0);
      var timeBadge = document.createElement('div');
      timeBadge.className = 'channel-time-badge';
      timeBadge.textContent = ms + 'ms';
      wrapper.appendChild(timeBadge);
    }

    // Pixel inspector
    var pxPinnedList = [];
    var pxFloat = document.createElement('div');
    pxFloat.style.cssText = 'display:none;position:fixed;z-index:999;background:rgba(0,0,0,0.85);color:#e8eaed;font-size:11px;padding:4px 8px;border-radius:3px;pointer-events:none;white-space:nowrap;font-family:monospace';
    document.body.appendChild(pxFloat);
    var pxTracking = false;
    var _img = img;
    function readPixel(e, el) {
      var cv = wrapper.querySelector('canvas');
      var wImg = wrapper.querySelector('img');
      var src = cv || wImg; if (!src) return null;
      var rect = src.getBoundingClientRect();
      var sx = src.width / rect.width;
      var sy = src.height / rect.height;
      var px = Math.floor((e.clientX - rect.left) * sx);
      var py = Math.floor((e.clientY - rect.top) * sy);
      var ctx = (cv || document.createElement('canvas')).getContext('2d');
      if (!ctx) return null;
      if (wImg && !cv) { ctx.canvas.width = wImg.naturalWidth; ctx.canvas.height = wImg.naturalHeight; ctx.drawImage(wImg, 0, 0); }
      try {
        var d = ctx.getImageData(Math.min(px, src.width-1), Math.min(py, src.height-1), 1, 1).data;
        var isFloat = false, isSNorm = false;
        var ddsC = ddsCache.get(_img.src);
        var exrC = exrCache.get(_img.src);
        if (ddsC && ddsC.dds) {
          var fam = ddsC.dds.fmt.family;
          var ddsType2 = ddsC.dds.fmt.type || '';
          isFloat = fam==='R16F'||fam==='R32F'||fam==='BC6H'||fam==='R11G11B10'||fam==='R16G16F'||fam==='RGB9E5'||fam==='RGBA128F'||fam==='RGB96F'||fam==='RGBA64F'||fam==='R32G32F';
          isSNorm = ddsType2.indexOf('SNORM')>=0;
        } else if (exrC) {
          isFloat = true;
        }
        var txt;
        if (isSNorm) {
          txt = 'R:' + (d[0]/127.5-1).toFixed(3) + ' G:' + (d[1]/127.5-1).toFixed(3) + ' B:' + (d[2]/127.5-1).toFixed(3) + ' A:' + d[3] + ' @' + px + ',' + py;
        } else if (isFloat) {
          txt = 'R:' + (d[0]/255).toFixed(3) + ' G:' + (d[1]/255).toFixed(3) + ' B:' + (d[2]/255).toFixed(3) + ' A:' + (d[3]/255).toFixed(3) + ' @' + px + ',' + py;
        } else {
          txt = 'R:' + d[0] + ' G:' + d[1] + ' B:' + d[2] + ' A:' + d[3] + ' @' + px + ',' + py;
        }
        el.textContent = txt; el.style.display = 'block';
        el.style.left = (e.clientX + 12) + 'px';
        el.style.top = (e.clientY - 10) + 'px';
        return txt;
      } catch(ex) { return null; }
    }
    function makePxPin(x, y, txt) {
      var pin = document.createElement('div');
      pin.style.cssText = 'position:fixed;z-index:998;background:rgba(0,0,0,0.82);color:#8ab4f8;font-size:11px;padding:3px 7px;border-radius:3px;border:1px solid rgba(74,158,255,0.3);pointer-events:none;white-space:nowrap;font-family:monospace';
      pin.textContent = txt;
      pin.style.left = (x + 12) + 'px';
      pin.style.top = (y - 10) + 'px';
      document.body.appendChild(pin);
      pxPinnedList.push(pin);
      pin.addEventListener('dblclick', function() { pin.remove(); pxPinnedList = pxPinnedList.filter(function(p) { return p !== pin; }); });
    }
    function clearAllPins() { pxPinnedList.forEach(function(p) { p.remove(); }); pxPinnedList = []; }
    wrapper.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    wrapper.addEventListener('mousedown', function(e) {
      if (e.button !== 2) return;
      e.preventDefault(); e.stopPropagation();
      pxTracking = true; pxFloat.style.display = 'block';
      readPixel(e, pxFloat);
      wrapper._pxStartX = e.clientX; wrapper._pxStartY = e.clientY;
    });
    document.addEventListener('mousemove', function(e) {
      if (!pxTracking) return;
      readPixel(e, pxFloat);
    });
    document.addEventListener('mouseup', function(e) {
      if (!pxTracking || e.button !== 2) return;
      var dx = e.clientX - (wrapper._pxStartX || 0);
      var dy = e.clientY - (wrapper._pxStartY || 0);
      var txt = pxFloat.textContent;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5 && txt) {
        makePxPin(e.clientX, e.clientY, txt);
      }
      pxFloat.style.display = 'none';
      pxTracking = false;
    });
    wrapper.addEventListener('click', function(e) {
      if (e.target && (e.target.closest('.channel-toolbar') || e.target.closest('.channel-meta'))) clearAllPins();
    });
    document.addEventListener('scroll', function() { clearAllPins(); });

    // Auto-detect channels from DDS DXGI header
    var cachedForCh = ddsCache.get(img.src);
    if (cachedForCh && cachedForCh.dds && cachedForCh.dds.fmt.dxgi) {
      var chMap = chMapFromDxgi(cachedForCh.dds.fmt.dxgi);
      tb.querySelectorAll('.channel-btn').forEach(function(btn) {
        var ch = btn.textContent;
        if (ch === 'RGB' || btn.classList.contains('flip-btn') || btn.classList.contains('sampling-btn')) return;
        if (!(ch === 'RGBA' ? chMap.A : chMap[ch])) btn.style.display = 'none';
      });
      var defBtn = tb.querySelector('[data-ch=RGB]');
      if (defBtn) defBtn.click();
    } else {
      var defBtn = tb.querySelector('[data-ch=RGB]');
      if (defBtn) defBtn.click();
    }

    // Auto-detect point sampling for integer formats
    var ddsFmtType = '';
    if (cachedForCh && cachedForCh.dds && cachedForCh.dds.fmt.type) ddsFmtType = cachedForCh.dds.fmt.type;
    var intType = /UINT|INT|SINT/i.test(ddsFmtType);
    if (intType) {
      var cvs = wrapper.querySelectorAll('canvas');
      cvs.forEach(function(cv) { cv.classList.add('sampling-nearest'); });
      samplingNearest = true;
      samplingBtn.classList.add('active');
    }

    // Fetch JSON sidecar for metadata overlay
    var jsonUrl2 = img.src.replace(/\.[^.]+$/, '.json');
    var jsonPromise;
    if (jsonCache.has(jsonUrl2)) {
      jsonPromise = Promise.resolve(jsonCache.get(jsonUrl2));
    } else {
      jsonPromise = fetch(jsonUrl2).then(function(r) { if (!r.ok) throw r.status; return r.json(); });
    }
    jsonPromise.then(function(data) {
      if (!data) return;
      var rd = data.renderdoc || {}, ai = data.ai || {};

      if (data.publication && data.publication.channels) {
        var publishedChannels = data.publication.channels;
        tb.querySelectorAll('[data-ch]').forEach(function(btn) {
          var ch = btn.dataset.ch;
          if (ch === 'RGB') return;
          if (ch === 'RGBA' ? publishedChannels.indexOf('A') < 0 : publishedChannels.indexOf(ch) < 0) btn.style.display = 'none';
        });
      }

      if (data.flip_y) {
        var el = wrapper.querySelector('canvas') || wrapper.querySelector('img');
        if (el) { el.style.transform = 'scaleY(-1)'; }
        var fb = tb.querySelector('.flip-btn');
        if (fb) fb.classList.add('active');
      }
      // JSON sidecar sampling override
      var sampling = data.sampling || (data.renderdoc || {}).sampling || '';
      if (sampling === 'nearest' || sampling === 'linear') {
        var useNearest = sampling === 'nearest';
        if (useNearest !== samplingNearest) samplingBtn.click();
      }
      var lines = [];
      var fname = img.src.split('/').pop();
      if (fname) lines.unshift(fname);
      ['event_id','resource_name'].forEach(function(k) { if (data[k] !== undefined) lines.push(k + ': ' + data[k]); });
      var cachedFmt = ddsCache.get(img.src);
      var ddsFmt = cachedFmt && cachedFmt.dds ? cachedFmt.dds.fmt : null;
      if (data.publication) lines.push('PNG preview: mip 0 / slice 0');
      if (rd.format) lines.push((data.publication ? 'source format: ' : 'format: ') + rd.format);
      else if (data.publication && data.publication.source_format) lines.push('source format: ' + data.publication.source_format);
      else if (ddsFmt) lines.push('format: ' + (ddsFmt.type || '') + ' (DXGI ' + ddsFmt.dxgi + ')');
      if (data.publication) {
        lines.push('size: ' + w + 'x' + h);
        if (rd.size) lines.push('source size: ' + rd.size);
        else if (data.publication.source_size) lines.push('source size: ' + data.publication.source_size.join('x'));
      }
      else if (rd.size) lines.push('size: ' + rd.size);
      else lines.push('size: ' + w + 'x' + h);
      if (rd.mips !== undefined) lines.push('mips: ' + rd.mips);
      else if (cachedFmt && cachedFmt.dds) lines.push('mips: ' + cachedFmt.dds.mips);
      var cachedDds = ddsCache.get(img.src);
      if (cachedDds && cachedDds.dds && cachedDds.dds.mipList) {
        cachedDds.dds.mipList.forEach(function(m, i) {
          var sizeKB = (m.size / 1024).toFixed(1);
          lines.push('  Lv' + i + ': ' + m.w + '\u00d7' + m.h + '  ' + (m.size >= 1048576 ? (m.size / 1048576).toFixed(1) + ' MB' : sizeKB + ' KB'));
        });
      }
      if (rd.array_size !== undefined) lines.push('array_size: ' + rd.array_size);
      var alphaNames = ['unknown','straight','premultiplied','opaque','custom'];
      if (cachedDds && cachedDds.dds && cachedDds.dds.alphaMode) lines.push('alpha: ' + (alphaNames[cachedDds.dds.alphaMode] || cachedDds.dds.alphaMode));
      if (cachedDds && cachedDds.dds && cachedDds.dds.resDim === 2) lines.push('type: 1D texture');
      var cachedM = ddsCache.get(img.src);
      var ddsMips = cachedM && cachedM.dds ? cachedM.dds.mips : 1;
      var totalMips = cachedFmt && cachedFmt.dds ? (parseInt(rd.mips) || ddsMips) : 1;
      if (ai.content || ai.pipeline_stage) {
        if (ai.pipeline_stage) lines.push('[AI] stage: ' + ai.pipeline_stage);
        if (ai.content) lines.push('[AI] ' + ai.content);
      }
      if (!lines.length) return;
      var meta = document.createElement('div'); meta.className = 'channel-meta';
      var inner = document.createElement('div'); inner.className = 'channel-meta-inner';
      inner.textContent = lines.join('\n');
      var cachedDdsArr = ddsCache.get(img.src);
      var totalArray = cachedDdsArr && cachedDdsArr.dds ? cachedDdsArr.dds.arraySize : 1;
      if (totalArray <= 1 && cachedDdsArr && cachedDdsArr.dds) totalArray = parseInt(rd.array_size) || 1;
      var curSlice = 0;

      // 当前帧（mip × slice）的原子切换（缺陷 8）：整帧算好后一次性替换全部状态
      function buildFrame(cached) {
        if(curMip===0&&curSlice===0&&cached.mip0) {
          return {px:cached.mip0,w:cached.w,h:cached.h,rawPixels:cached.rawPixels,
            normMin:cached.normMin,normMax:cached.normMax,cache:cached};
        }
        var f=cached.dds.getFrame(curMip,curSlice);
        return f ? {px:f.pixels,w:f.w,h:f.h,rawPixels:f.rawPixels,
          normMin:f.normMin,normMax:f.normMax,cache:cached} : null;
      }

      function applyFrame(frame) {
        straight = frame.px;
        curW = frame.w; curH = frame.h;
        normMin = frame.normMin; normMax = frame.normMax;
        curLo = normMin; curHi = normMax;
        rawPixels = frame.rawPixels;
        ddsInfo0 = frame.cache;   // 下游读 ddsInfo0 时必须已是当前帧的信息
        fam0 = frame.cache.dds ? frame.cache.dds.fmt.family : fam0;
        pxCache.set(img.src, frame.px);
        var cv = wrapper.querySelector('canvas');
        if (!cv) { cv = document.createElement('canvas'); cv.className = 'channel-canvas'; if (samplingNearest) cv.classList.add('sampling-nearest'); wrapper.appendChild(cv); }
        cv.width = frame.w; cv.height = frame.h;
        cv.getContext('2d').putImageData(new ImageData(frame.px, frame.w, frame.h), 0, 0);
        var sz = sizeCanvas(cv, frame.w, frame.h);
        if (sizeBadge) sizeBadge.textContent = sz.dw + '×' + sz.dh + (sz.dw !== frame.w || sz.dh !== frame.h ? '  (' + frame.w + '×' + frame.h + ')' : '');
        syncRangeSliders();
        // 重绘必须等上面所有帧状态落定（按钮回调读的是闭包变量）
        renderRemapped();
      }

      // 范围滑块跟随当前帧的 norm 范围
      function syncRangeSliders() {
        if (loSlider) { loSlider.min = normMin; loSlider.max = normMax; loSlider.step = (normMax - normMin) / 200; loSlider.value = curLo; loLabel.textContent = curLo.toFixed(2); }
        if (hiSlider) { hiSlider.min = normMin; hiSlider.max = normMax; hiSlider.step = (normMax - normMin) / 200; hiSlider.value = curHi; hiLabel.textContent = curHi.toFixed(2); }
      }

      var renderSliceMip = function(s, n) {
        var previousSlice = curSlice, previousMip = curMip;
        if (s !== undefined) curSlice = s;
        if (n !== undefined) curMip = n;
        var cached = ddsCache.get(img.src);
        if (!cached || !cached.dds) return;  // EXR 无 mip/slice：保持原行为，什么都不做
        var frame = buildFrame(cached);
        if (!frame) {
          curSlice = previousSlice; curMip = previousMip;
          if (sizeBadge) sizeBadge.textContent = '解码失败：' + (DDS.lastError || '无效 mip / slice');
          return;
        }
        applyFrame(frame);
      };
      var curMip = 0;

      var rowStyle = 'display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:2px 3px;background:rgba(0,0,0,0.45);border-radius:3px;margin:1px 0;width:auto';
      var dSlider = null, dLabel = null;
      var isVolume = cachedDdsArr && cachedDdsArr.dds && cachedDdsArr.dds.resDim === 4 && cachedDdsArr.dds.depth > 1;
      if (totalMips > 1) {
        var mipSpacer = document.createElement('div');
        mipSpacer.style.cssText = 'flex-basis:100%;height:0';
        tb.appendChild(mipSpacer);
        var mipRow = document.createElement('div');
        mipRow.style.cssText = rowStyle;
        var mipLabel = document.createElement('span');
        mipLabel.style.cssText = 'color:#e8eaed;font-size:10px;min-width:32px;text-align:center';
        mipLabel.textContent = 'Lv.' + curMip + ' / ' + (totalMips-1);
        var mipSlider = document.createElement('input');
        mipSlider.type = 'range'; mipSlider.min = 0; mipSlider.max = totalMips - 1; mipSlider.value = curMip;
        mipSlider.style.cssText = 'width:60px;height:10px;cursor:pointer;accent-color:#4a9eff';
        mipSlider.addEventListener('input', function(e) {
          e.stopPropagation();
          var newMip = parseInt(mipSlider.value);
          renderSliceMip(undefined, newMip);
          mipLabel.textContent = 'Lv.' + newMip + ' / ' + (totalMips-1);
          if (isVolume && dSlider && cachedDdsArr.dds.mipList[newMip]) {
            var newDepth = cachedDdsArr.dds.mipList[newMip].depth;
            dSlider.max = newDepth - 1;
            if (parseInt(dSlider.value) >= newDepth) { dSlider.value = newDepth - 1; renderSliceMip(parseInt(dSlider.value), undefined); }
            dLabel.textContent = 'D.' + dSlider.value + '/' + dSlider.max;
          }
        });
        mipSlider.addEventListener('mousedown', function() {
          meta.style.opacity = '0';
          for (var c = tb.firstChild; c; c = c.nextSibling) { if (c !== mipRow) c.style.opacity = '0'; }
        });
        mipSlider.addEventListener('mouseup', function() {
          meta.style.opacity = '';
          for (var c = tb.firstChild; c; c = c.nextSibling) { c.style.opacity = ''; }
        });
        mipRow.appendChild(mipLabel);
        mipRow.appendChild(mipSlider);
        tb.appendChild(mipRow);
      }
      if (isVolume) {
        var dSpacer = document.createElement('div');
        dSpacer.style.cssText = 'flex-basis:100%;height:0';
        tb.appendChild(dSpacer);
        var dRow = document.createElement('div');
        dRow.style.cssText = rowStyle;
        dLabel = document.createElement('span');
        dLabel.style.cssText = 'color:#e8eaed;font-size:10px;min-width:32px;text-align:center';
        var volDepth0 = cachedDdsArr.dds.mipList[0].depth;
        dLabel.textContent = 'D.0/' + (volDepth0 - 1);
        dSlider = document.createElement('input');
        dSlider.type = 'range'; dSlider.min = 0; dSlider.max = volDepth0 - 1; dSlider.value = 0;
        dSlider.style.cssText = 'width:60px;height:10px;cursor:pointer;accent-color:#f0a030';
        dSlider.addEventListener('input', function(e) {
          e.stopPropagation();
          renderSliceMip(parseInt(dSlider.value), undefined);
          dLabel.textContent = 'D.' + dSlider.value + '/' + dSlider.max;
        });
        dSlider.addEventListener('mousedown', function() {
          meta.style.opacity = '0';
          for (var c = tb.firstChild; c; c = c.nextSibling) { if (c !== dRow) c.style.opacity = '0'; }
        });
        dSlider.addEventListener('mouseup', function() {
          meta.style.opacity = '';
          for (var c = tb.firstChild; c; c = c.nextSibling) { c.style.opacity = ''; }
        });
        dRow.appendChild(dLabel);
        dRow.appendChild(dSlider);
        tb.appendChild(dRow);
      }
      if (totalArray > 1) {
        var arrSpacer = document.createElement('div');
        arrSpacer.style.cssText = 'flex-basis:100%;height:0';
        tb.appendChild(arrSpacer);
        var arrRow = document.createElement('div');
        arrRow.style.cssText = rowStyle;
        var arrLabel = document.createElement('span');
        arrLabel.style.cssText = 'color:#e8eaed;font-size:10px;min-width:28px;text-align:center';
        arrLabel.textContent = 'F.' + curSlice + '/' + (totalArray-1);
        var arrSlider = document.createElement('input');
        arrSlider.type = 'range'; arrSlider.min = 0; arrSlider.max = totalArray - 1; arrSlider.value = 0;
        arrSlider.style.cssText = 'width:60px;height:10px;cursor:pointer;accent-color:#f0a030';
        arrSlider.addEventListener('input', function(e) { e.stopPropagation(); renderSliceMip(parseInt(arrSlider.value), undefined); arrLabel.textContent = 'F.' + arrSlider.value + '/' + (totalArray-1); });
        arrSlider.addEventListener('mousedown', function() {
          meta.style.opacity = '0';
          for (var c = tb.firstChild; c; c = c.nextSibling) { if (c !== arrRow) c.style.opacity = '0'; }
        });
        arrSlider.addEventListener('mouseup', function() {
          meta.style.opacity = '';
          for (var c = tb.firstChild; c; c = c.nextSibling) { c.style.opacity = ''; }
        });
        arrRow.appendChild(arrLabel);
        arrRow.appendChild(arrSlider);
        tb.appendChild(arrRow);
      }
      tb.appendChild(bottomRow);
      meta.appendChild(inner);
      var btnRow = document.createElement('div');
      btnRow.className = 'channel-meta-btns';
      var browserBtn = document.createElement('button');
      browserBtn.className = 'channel-meta-copy';
      browserBtn.textContent = '\u590d\u5236\u94fe\u63a5';
      browserBtn.addEventListener('click', function(e) {
        e.stopPropagation(); e.preventDefault();
        navigator.clipboard.writeText(img.src).then(function() {
          browserBtn.textContent = '\u5df2\u590d\u5236';
          browserBtn.classList.add('copied');
          setTimeout(function() { browserBtn.textContent = '\u590d\u5236\u94fe\u63a5'; browserBtn.classList.remove('copied'); }, 1500);
        });
      });
      var localBtn = document.createElement('button');
      localBtn.className = 'channel-meta-copy';
      localBtn.textContent = '\u672c\u5730\u8def\u5f84';
      localBtn.addEventListener('click', function(e) {
        e.stopPropagation(); e.preventDefault();
        var cfg = window.ImageViewerConfig || {};
        var workingDir = cfg.workingDir || '';
        var localPath = (workingDir + '/content' + decodeURI(new URL(img.src).pathname)).replace(/\//g, '\\');
        navigator.clipboard.writeText(localPath).then(function() {
          localBtn.textContent = '\u5df2\u590d\u5236';
          localBtn.classList.add('copied');
          setTimeout(function() { localBtn.textContent = '\u672c\u5730\u8def\u5f84'; localBtn.classList.remove('copied'); }, 1500);
        });
      });
      btnRow.appendChild(browserBtn);
      btnRow.appendChild(localBtn);

      // ── 保存当前帧为 TGA / PNG（导出原始解码帧，不烘焙染色/remap/翻转）──
      var fbReset = null;
      function saveFeedback(btn, msg) {
        btn.textContent = msg;
        btn.classList.add('copied');
        if (fbReset) clearTimeout(fbReset);
        fbReset = setTimeout(function() {
          btn.textContent = btn.dataset.label;
          btn.classList.remove('copied');
          fbReset = null;
        }, 1500);
      }
      function exportFrame(btn, format) {
        if (!straight) { saveFeedback(btn, '失败'); return; }
        // 源文件名（与 meta 浮层 fname 同源）
        var srcName = decodeURIComponent(img.src.split('/').pop() || 'image');
        var base = srcName.replace(/\.[^.]+$/, '');
        // 当前帧非默认 mip/slice/depth 时加后缀（0 不加，与 meta 术语一致）
        var suffix = '';
        if (curMip > 0) suffix += '_Lv' + curMip;
        if (curSlice > 0) suffix += '_F' + curSlice;
        if (isVolume && dSlider && parseInt(dSlider.value, 10) > 0) suffix += '_D' + parseInt(dSlider.value, 10);
        var fname = base + suffix + (format === 'tga' ? '.tga' : '.png');

        // 原始帧副本 + alpha 判定：DDS 用 DXGI chMap，EXR 视为含 A，普通图实测像素
        var px = new Uint8ClampedArray(straight);
        var chm = null;
        var ddsC = ddsCache.get(img.src);
        if (ddsC && ddsC.dds && ddsC.dds.fmt) chm = chMapFromDxgi(ddsC.dds.fmt.dxgi);
        var hasAlpha = isExr || (chm && chm.A);
        if (!hasAlpha) {
          for (var ai = 3; ai < px.length; ai += 4) {
            if (px[ai] !== 255) { hasAlpha = true; break; }
          }
        }
        var onResult = function(status) {
          if (status === 'saved') saveFeedback(btn, '已保存');
          else if (status === 'downloaded') saveFeedback(btn, '已下载');
          else if (status === 'failed') saveFeedback(btn, '失败');
          // 'cancelled' 静默
        };
        if (format === 'tga') {
          var bpp = hasAlpha ? 32 : 24;
          var tga = ExportTexture.encodeTGA(px, curW, curH, bpp);
          var blob = new Blob([tga], { type: 'image/x-tga' });
          ExportTexture.saveBlob(blob, fname, { 'image/x-tga': ['.tga'] }, onResult);
        } else {
          var cv = document.createElement('canvas');
          cv.width = curW; cv.height = curH;
          cv.getContext('2d').putImageData(new ImageData(px, curW, curH), 0, 0);
          cv.toBlob(function(b) {
            if (b) ExportTexture.saveBlob(b, fname, { 'image/png': ['.png'] }, onResult);
            else saveFeedback(btn, '失败');
          }, 'image/png');
        }
      }
      var saveTgaBtn = document.createElement('button');
      saveTgaBtn.className = 'channel-meta-copy';
      saveTgaBtn.textContent = '保存TGA';
      saveTgaBtn.dataset.label = '保存TGA';
      saveTgaBtn.title = '保存 TGA 到桌面（另存为对话框）';
      saveTgaBtn.addEventListener('click', function(e) {
        e.stopPropagation(); e.preventDefault();
        exportFrame(saveTgaBtn, 'tga');
      });
      var savePngBtn = document.createElement('button');
      savePngBtn.className = 'channel-meta-copy';
      savePngBtn.textContent = '保存PNG';
      savePngBtn.dataset.label = '保存PNG';
      savePngBtn.title = '保存 PNG 到桌面（另存为对话框）';
      savePngBtn.addEventListener('click', function(e) {
        e.stopPropagation(); e.preventDefault();
        exportFrame(savePngBtn, 'png');
      });
      btnRow.appendChild(saveTgaBtn);
      btnRow.appendChild(savePngBtn);
      meta.appendChild(btnRow);
      wrapper.appendChild(meta);
    }).catch(function(){});
  }

  // ---- Image loader ----
  // detail：可选的失败原因（worker onerror 的 message/filename/lineno、请求超时、
  // postMessage 异常等）。能拿到就画在占位图上（画布太窄时退回通用文案），
  // 完整原因同时写进 title，拿不到就只显示通用文案。
  function showErrorPlaceholder(img, w, h, detail) {
    w = w || 64; h = h || 64;
    var cv = document.createElement('canvas');
    cv.className = 'channel-canvas'; cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    var text = 'decode error';
    if (detail) {
      var d = String(detail);
      cv.title = 'decode error: ' + d;
      if (d.length > 48) d = d.slice(0, 45) + '...';
      if (ctx.measureText(text + ' (' + d + ')').width <= w) text += ' (' + d + ')';
    }
    ctx.fillText(text, w/2, h/2);
    cv.style.width = Math.min(w, 400) + 'px';
    cv.style.height = Math.min(h, 400) + 'px';
    cv.style.opacity = '0.6';
    var parent = img.parentNode;
    if (parent.tagName === 'P') {
      parent.parentNode.insertBefore(cv, parent);
    } else {
      img.parentNode.insertBefore(cv, img);
    }
    img.style.display = 'none';
  }

  function loadImage(img) {
    if (img.closest('.channel-container') || img.closest('a')) return;
    img._processed = true;
    img._t0 = performance.now();

    // DDS
    if (/\.dds$/i.test(img.src)) {
      var ddsCached = ddsCache.get(img.src);
      // 缓存条目里的 w/h 是该帧**实际**尺寸（worker 可能已降采样，≠ dds.w/dds.h）；
      // 老条目没有 w/h 时才退回 dds 的逻辑尺寸
      if (ddsCached) { processImage(img, ddsCached.w || ddsCached.dds.w, ddsCached.h || ddsCached.dds.h, ddsCached.mip0); return; }
      var jsonUrl = img.src.replace(/\.dds$/i, '.json');
      if (!jsonCache.has(jsonUrl)) {
        fetch(jsonUrl).then(function(r) { if (r.ok) return r.json(); }).then(function(d) { if (d) jsonCache.set(jsonUrl, d); }).catch(function(){});
      }
      img.style.outline = '1px dashed #555';
      img._t0 = performance.now();
      fetch(img.src).then(function(r) { if (!r.ok) throw r.status; return r.arrayBuffer(); }).then(function(buf) {
        if (!buf) throw 'empty';
        var dds = DDS.parse(buf);
        if (!dds) throw 'parse';
        var dfam = dds.fmt.family;
        if (dds.fmt.isComp && dfam!=='BC1'&&dfam!=='BC3'&&dfam!=='BC4'&&dfam!=='BC5') {
          var frame = dds.getFrame(0);
          if (!frame) throw new Error(DDS.lastError || 'DDS decode failed');
          var mip0 = frame.pixels;
          ddsCache.set(img.src, {dds:dds, mip0:mip0, w:frame.w, h:frame.h, normMin:frame.normMin, normMax:frame.normMax, rawPixels:frame.rawPixels});
          img.style.outline = '';
          processImage(img, dds.w, dds.h, mip0);
          return;
        }
        var typeOverride = null;
        var jsonData = jsonCache.get(jsonUrl);
        if (jsonData) {
          var rdFmt = (jsonData.renderdoc || {}).format || '';
          if (/TYPELESS/i.test(rdFmt) && dds.fmt.family === 'R16F') { typeOverride = 'R16'; dds.fmt.type='R16_UNORM'; dds.fmt.family='R16'; }
        }
        var targetDim = (img.closest('td') || img.closest('th')) ? 800 : 1000;
        decodeWorker.decode('dds', buf, function(result) {
          img.style.outline = '';
          if (!result.ok) { showErrorPlaceholder(img, dds.w, dds.h, result.error); return; }
          // w/h 存解码结果的实际尺寸：targetDim 降采样后 result.w/h 小于 dds.w/h，
          // 缓存命中时必须用这个尺寸重放，否则画布尺寸与像素数据不匹配
          ddsCache.set(img.src, {dds:dds, mip0:result.pixels, w:result.w, h:result.h, normMin:result.normMin, normMax:result.normMax, rawPixels:result.rawPixels});
          processImage(img, result.w, result.h, result.pixels);
        }, false, typeOverride, targetDim);
      }).catch(function(e){ img.style.outline = ''; showErrorPlaceholder(img, null, null, e.message || String(e)); });
      return;
    }

    // EXR
    if (/\.exr$/i.test(img.src)) {
      var exrCached = exrCache.get(img.src);
      if (exrCached) { processImage(img, exrCached.exr.w, exrCached.exr.h, exrCached.rgba8); return; }
      var jsonUrlExr = img.src.replace(/\.exr$/i, '.json');
      if (!jsonCache.has(jsonUrlExr)) {
        fetch(jsonUrlExr).then(function(r) { if (r.ok) return r.json(); }).then(function(d) { if (d) jsonCache.set(jsonUrlExr, d); }).catch(function(){});
      }
      img.style.outline = '1px dashed #555';
      img._t0 = performance.now();
      fetch(img.src).then(function(r) { if (!r.ok) throw r.status; return r.arrayBuffer(); }).then(function(buf) {
        if (!buf) throw 'empty';
        decodeWorker.decode('exr', buf, function(result) {
          img.style.outline = '';
          if (!result.ok) { showErrorPlaceholder(img, 0, 0, result.error); return; }
          exrCache.set(img.src, {exr:{w:result.w,h:result.h}, rgba8:result.pixels, rawPixels:result.rawPixels, normMin:result.normMin, normMax:result.normMax});
          processImage(img, result.w, result.h, result.pixels);
        }, true);
      }).catch(function(){ img.style.outline = ''; showErrorPlaceholder(img); });
      return;
    }

    // Standard (PNG/JPEG/WebP)
    var onload = function() {
      if (img.closest('.channel-container')) return;
      img.removeEventListener('load', onload);
      processImage(img, img.naturalWidth, img.naturalHeight, null);
    };
    if (window.ImageViewerConfig && ImageViewerConfig.publishedLocal && /\.png$/i.test(img.src) && window.PublishedTexture) {
      var publishedJsonUrl = img.src.replace(/\.png$/i, '.json');
      fetch(publishedJsonUrl).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }).then(function(data) {
        if (data) jsonCache.set(publishedJsonUrl, data);
        if (data && data.publication && (data.publication.rgb_png || data.publication.rgba_png)) {
          return PublishedTexture.load(img.src, data.publication)
            .then(function(frame) { processImage(img, frame.w, frame.h, frame.pixels); });
        }
        if (img.complete && img.naturalWidth > 0) onload();
        else img.addEventListener('load', onload);
      }).catch(function(e) { showErrorPlaceholder(img, img.naturalWidth, img.naturalHeight, e.message); });
    } else if (img.complete && img.naturalWidth > 0) { onload(); }
    else { img.addEventListener('load', onload); }
  }

  // ---- Lazy Loading via IntersectionObserver ----
  var imgs = c.querySelectorAll('img');
  if (!imgs.length) return;

  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          loadImage(entry.target);
        }
      });
    }, { rootMargin: '800px' });

    imgs.forEach(function(img) { observer.observe(img); });
  } else {
    imgs.forEach(function(img) { loadImage(img); });
  }
})();
