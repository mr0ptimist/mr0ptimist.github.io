# image-viewer 导出 TGA/PNG 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在图片查看器 hover 浮层的「本地路径」旁加「保存TGA」「保存PNG」按钮，把当前 mip/slice 的原始解码帧经另存为对话框导出（不支持时降级下载）。

**Architecture:** 新增无 DOM 依赖的 `static/js/export-texture.js`（TGA 编码器 + blob 落盘，`window.ExportTexture` + `module.exports` 双暴露便于 node 单测）；`image-viewer.js` 的 `processImage` 内按钮行追加两个按钮，点击处理器在闭包内取 `straight`/`curW/curH`（原始解码帧语义）构建像素并调用导出模块；`extend_footer.html` 加载新脚本并把 `image-viewer.js?v=23` bump 到 24。

**Tech Stack:** Classic browser JS（无 bundler/ES module，遵循 static/js/CLAUDE.md）、node（仅跑编码器单测）、File System Access API（Chromium 另存为对话框，AbortError 静默取消，自动降级 `<a download>`）。

**Spec:** `docs/superpowers/specs/2026-09-07-image-viewer-export-tga-png-design.md`

---

### Task 1: 编写 TGA 编码器失败测试

**Files:**
- Create: `scripts/test-export-texture.js`
- Test target（尚不存在，Task 2 创建）: `static/js/export-texture.js`

- [ ] **Step 1: 创建 node 测试脚本**

`scripts/test-export-texture.js`：

```js
// node scripts/test-export-texture.js
// export-texture.js 的编码器单测：验证 TGA 18 字节头 + BGRA 像素序 + bottom-up 行序
const assert = require('assert');
const { encodeTGA } = require('../static/js/export-texture.js');

// ── 32bit，2×2 ──
// 源像素 top-down RGBA：
//   row0: 红 (255,0,0,255)   绿 (0,255,0,255)
//   row1: 蓝 (0,0,255,255)   白 (255,255,255,255)
const px2 = new Uint8Array([
  255,0,0,255,  0,255,0,255,
  0,0,255,255,  255,255,255,255
]);
const t32 = encodeTGA(px2, 2, 2, 32);
// 头 18 字节：type=2、宽 2 LE、高 2 LE、bpp 32、descriptor 0x08
const head32 = [0,0,2, 0,0,0,0,0, 0,0,0,0, 2,0, 2,0, 32, 8];
// 像素区（bottom-up：先 y=1 行；BGRA）：
//   蓝 → B=255,G=0,R=0,A=255 → [255,0,0,255]
//   白 → [255,255,255,255]
//   红 → B=0,G=0,R=255,A=255 → [0,0,255,255]
//   绿 → B=0,G=255,R=0,A=255 → [0,255,0,255]
const px32 = [
  255,0,0,255,  255,255,255,255,
  0,0,255,255,  0,255,0,255
];
assert.strictEqual(t32.length, 18 + 2 * 2 * 4, '32bit 总长度');
assert.deepStrictEqual([...t32.slice(0, 18)], head32, '32bit 头');
assert.deepStrictEqual([...t32.slice(18)], px32, '32bit 像素区');

// ── 24bit，3×1 ──
// 单行（无行序翻转影响），RGBA：红 | 绿 | 蓝
const px3 = new Uint8Array([
  255,0,0,255,  0,255,0,255,  0,0,255,255
]);
const t24 = encodeTGA(px3, 3, 1, 24);
const head24 = [0,0,2, 0,0,0,0,0, 0,0,0,0, 3,0, 1,0, 24, 0];
// BGRA 每像素 3 字节：红 → [0,0,255]；绿 → [0,255,0]；蓝 → [255,0,0]
const px24 = [0,0,255,  0,255,0,  255,0,0];
assert.strictEqual(t24.length, 18 + 3 * 1 * 3, '24bit 总长度');
assert.deepStrictEqual([...t24.slice(0, 18)], head24, '24bit 头');
assert.deepStrictEqual([...t24.slice(18)], px24, '24bit 像素区');

// 非法 bpp 应钳到 24
assert.strictEqual(encodeTGA(px3, 3, 1, 16).length, 18 + 9, '非法 bpp 钳 24bit');

console.log('export-texture tests passed');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test-export-texture.js`
Expected: FAIL，`Cannot find module '../static/js/export-texture.js'`（文件尚未创建，属预期失败）

- [ ] **Step 3: Commit**

```bash
git add scripts/test-export-texture.js
git commit -m "test: TGA 编码器失败测试（导出功能前置）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2: 实现 export-texture.js（encodeTGA + saveBlob）

**Files:**
- Create: `static/js/export-texture.js`

- [ ] **Step 1: 实现模块**

`static/js/export-texture.js`：

```js
// =============================================================================
// export-texture.js — 图片查看器导出工具（TGA 编码 + Blob 落盘）
// =============================================================================
// 依赖：无（经典 script，window.ExportTexture + module.exports 双暴露，
//       后者供 node 单测；不触碰 worker/importScripts 链）
//
// 导出像素语义：调用方传入原始解码帧 RGBA8（top-down），本模块不做任何
// remap/染色/翻转烘焙。TGA 为未压缩 truecolor（24/32bit，bottom-up + BGRA）。
// 落盘：showSaveFilePicker 另存为对话框优先，取消静默，失败降级 <a download>。
// =============================================================================
(function(){
  function encodeTGA(rgba, w, h, bpp) {
    bpp = bpp === 32 ? 32 : 24;
    var bytesPerPx = bpp >> 3;
    var out = new Uint8Array(18 + w * bytesPerPx * h);
    out[2] = 2;                            // image type: uncompressed truecolor
    out[12] = w & 255; out[13] = (w >> 8) & 255;   // width LE
    out[14] = h & 255; out[15] = (h >> 8) & 255;   // height LE
    out[16] = bpp;
    out[17] = bpp === 32 ? 8 : 0;          // descriptor: alpha bits
    var o = 18;
    for (var y = h - 1; y >= 0; y--) {     // TGA origin bottom-left：自末行起
      var row = y * w * 4;
      for (var x = 0; x < w; x++) {
        var i = (row + x * 4) | 0;
        out[o++] = rgba[i + 2];            // B
        out[o++] = rgba[i + 1];            // G
        out[o++] = rgba[i];                // R
        if (bpp === 32) out[o++] = rgba[i + 3];
      }
    }
    return out;
  }

  function download(blob, fname) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
  }

  // cb(status): 'saved'(另存为成功) | 'downloaded'(降级下载已触发)
  //            | 'cancelled'(用户取消，调用方不反馈)
  //            | 'failed'(另存为以外的错误且降级也失败)
  // accept: {'image/png': ['.png']} 或 {'image/x-tga': ['.tga']}
  function saveBlob(blob, fname, accept, cb) {
    var picker = window.showSaveFilePicker;
    if (picker) {
      try {
        picker.call(window, {
          suggestedName: fname,
          types: [{ description: fname.slice(-4) === '.tga' ? 'TGA 图像' : 'PNG 图像',
                    accept: accept }]
        }).then(function(handle) {
          return handle.createWritable()
            .then(function(w) { return w.write(blob); })
            .then(function() { return handle; });
        }).then(function(handle) {
          return handle.close();
        }).then(function() { cb && cb('saved'); })
        .catch(function(e) {
          if (e && e.name === 'AbortError') { cb && cb('cancelled'); return; }
          try { download(blob, fname); cb && cb('downloaded'); }
          catch (err2) { cb && cb('failed'); }
        });
        return;
      } catch (e) { /* picker 调用同步抛错 → 走降级 */ }
    }
    try { download(blob, fname); cb && cb('downloaded'); }
    catch (e) { cb && cb('failed'); }
  }

  var ExportTexture = { encodeTGA: encodeTGA, saveBlob: saveBlob };
  if (typeof window !== 'undefined') window.ExportTexture = ExportTexture;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExportTexture;
})();
```

- [ ] **Step 2: 运行测试确认通过**

Run: `node scripts/test-export-texture.js`
Expected: PASS，输出 `export-texture tests passed`（无断言失败）

- [ ] **Step 3: 语法复核**

Run: `node --check static/js/export-texture.js`
Expected: 无输出、exit 0

- [ ] **Step 4: Commit**

```bash
git add static/js/export-texture.js
git commit -m "feat: export-texture.js — TGA 24/32bit 编码器 + showSaveFilePicker 落盘（降级下载）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3: image-viewer.js 追加「保存TGA」「保存PNG」按钮

**Files:**
- Modify: `static/js/image-viewer.js`（`processImage` 内 `btnRow` 构建区，约 794-810 行——在 `btnRow.appendChild(localBtn);` 之后、`meta.appendChild(btnRow);` 之前插入保存按钮代码）
- Test: `node --check static/js/image-viewer.js`（浏览器行为 Task 5 手动验证）

- [ ] **Step 1: 插入保存按钮与共享导出函数**

在 `static/js/image-viewer.js` 的 `btnRow.appendChild(localBtn);`（第 809 行）之后插入以下代码（闭包内已有 `straight`/`curW/curH`/`isExr`/`ddsCache`/`img`，以及 jsonPromise 回调作用域内的 `curMip`/`curSlice`/`isVolume`/`dSlider`，均可直接引用）：

```js
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

        // 原始帧副本 + alpha 判定：DDS 用 DXGI chMap，EXR 视为含 A
        var px = new Uint8ClampedArray(straight);
        var chm = null;
        var ddsC = ddsCache.get(img.src);
        if (ddsC && ddsC.dds && ddsC.dds.fmt) chm = chMapFromDxgi(ddsC.dds.fmt.dxgi);
        var hasAlpha = isExr || (chm && chm.A);
        if (!hasAlpha) {
          for (var ai = 3; ai < px.length; ai += 4) px[ai] = 255;
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
```

- [ ] **Step 2: 语法复核**

Run: `node --check static/js/image-viewer.js`
Expected: 无输出、exit 0

- [ ] **Step 3: Commit**

```bash
git add static/js/image-viewer.js
git commit -m "feat: image-viewer hover 浮层加保存TGA/保存PNG（导出当前 mip/slice 原始帧）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 4: extend_footer.html 加载 export-texture.js 并 bump 缓存版本

**Files:**
- Modify: `layouts/_partials/extend_footer.html`（第 149-153 行 script 列表）

- [ ] **Step 1: 插入 script 标签并 bump 版本号**

在 `extend_footer.html` 第 153 行 `<script src="{{ "js/image-viewer.js" | relURL }}?v=23"></script>` **之前**插入：

```html
<script src="{{ "js/export-texture.js" | relURL }}?v=1"></script>
```

并把 image-viewer 行改为 `?v=24`：

```html
<script src="{{ "js/image-viewer.js" | relURL }}?v=24"></script>
```

- [ ] **Step 2: 构建确认模板无误**

Run: `hugo --quiet`
Expected: exit 0，无模板报错

- [ ] **Step 3: Commit**

```bash
git add layouts/_partials/extend_footer.html
git commit -m "feat: extend_footer 加载 export-texture.js，image-viewer 缓存版本 v24

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 5: 手动验证（用户执行）

**Files:** 无改动（验证后如需修复回到对应 Task）

- [ ] **Step 1: 启动并硬刷新**

Run: `hugo server -D -p 1313`，浏览器 `Ctrl+Shift+R` 硬刷新（image-viewer.js?v=24 缓存纪律）

- [ ] **Step 2: DDS 含 A 图 → 保存 TGA**

打开含 DDS 文章的含 alpha 图，hover → 浮层按钮行出现 `复制链接 | 本地路径 | 保存TGA | 保存PNG` → 点保存TGA → 系统另存为对话框弹出（suggestedName 为 `原名.tga`）→ 选桌面保存 → 按钮变「已保存」。用 PS/PIL/RenderDoc 打开：尺寸、BGRA 通道、bottom-up 方向与源一致。

- [ ] **Step 3: 纯 RGB / 单通道图 → 24bit TGA**

无 alpha 图（或 BC4 单通道）：保存 TGA 后文件为 24bit（PIL 读 `mode=='RGB'` 或文件头 `byte[16]==24`）。单通道导出为灰度内容。

- [ ] **Step 4: PNG + mip/slice 后缀**

点保存PNG → PNG 打开尺寸正确、alpha 正确。多 mip 图切到 Lv.2 → 文件名含 `_Lv2`，尺寸为该 mip 尺寸。多 array slice 切 F.1 → 含 `_F1`。

- [ ] **Step 5: 取消与降级**

另存为对话框点取消 → 按钮无变化（静默）。若浏览器无 showSaveFilePicker（或 file:// 打开页面）→ 点击直接触发下载到下载目录，按钮变「已下载」。

- [ ] **Step 6: 回归**

确认现有「复制链接」「本地路径」按钮行为不变；DDS/EXR/PNG hover 浮层其余部分（mip 滑杆、像素检查、meta）无回归。

---

## 执行说明

- 项目在 Windows + Git Bash，node 命令直接可用（mmdc/npx 既有使用史）
- 全部 commit 追加 `Co-Authored-By: Claude <noreply@anthropic.com>`（各 Task 已含）
- 本功能不触碰 worker 文件 → 不触发 static/js/CLAUDE.md 的 worker `?v` 双更新纪律；image-viewer 自身 `?v=23→24` 已覆盖浏览器缓存
- spec 中「不做」清单：无 RLE/16bit TGA、不导出 HDR rawPixels、无新 toast 弹层
