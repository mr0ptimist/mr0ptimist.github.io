# 图片查看器：保存 TGA / PNG 到桌面

日期：2026-09-07
状态：已确认
范围：image-viewer 导出功能（客户端 JS，无 Hugo 模板改动量）

## 目标

解码图片（DDS/EXR/PNG/JPG/WebP）的 `.channel-meta` 悬浮信息层中，在「本地路径」按钮旁新增「保存 TGA」「保存 PNG」按钮。点击后将该图**当前 mip/array/volume slice 的原始解码帧**导出为 TGA 或 PNG 文件，通过系统「另存为」对话框落盘（可导航到桌面）；不支持 File System Access API 时自动降级为标准浏览器下载。

## 背景（现状）

- `static/js/image-viewer.js`：每张解码图片包装为 `.channel-container`；hover 时 `.channel-meta` 浮层淡入（channel-viewer.css）。浮层底部 `.channel-meta-btns` 按钮行现有「复制链接」「本地路径」（本地路径按钮点击复制 `workingDir + /content + src路径` 的 Windows 绝对路径）。
- `processImage(img, w, h, ddsPixels)` 闭包内持有：`straight`（当前显示帧的原始解码 RGBA8，mip/array/volume 滑杆切换时通过 `renderSliceMip()` 更新并同步 `straight`、`curW/curH`）、`curW/curH`、`ddsCache/exrCache`（含格式元数据：DXGI、family、chMap）。
- 单通道格式（BC4/R8/R16F…）解码后输出即 R 灰度数据（G/B 已按格式语义清零或复制）；BC6H/BC7/R16F 等需 range remap 的格式有 `rawPixels`（Float32 原始值），但导出按**解码后 RGBA8 显示值**（straight 像素经 clamp 后的 0-255），不导出 HDR 原始值。
- 加载链：`extend_footer.html` → worker-shared / dds-parser / exr-parser / color-remap / image-viewer.js（`?v=23`）。

## UI 设计

- `.channel-meta-btns`（channel-meta-btns）按钮行顺序变为：`复制链接 | 本地路径 | 保存TGA | 保存PNG`
- 新按钮复用 class `channel-meta-copy`（含 `.copied` 反馈态样式），文本「保存TGA」「保存PNG」，`title` 分别为「保存 TGA 到桌面（另存为对话框）」/「保存 PNG 到桌面（另存为对话框）」
- 反馈：点击后按钮文本瞬时切换——成功「已保存」；降级下载完成「已下载」；失败「失败」，1.5s 复原（沿用 `.copied` class + setTimeout 模式，同现有复制按钮）
- 按钮在 `.channel-meta` 浮层内，浮层本就 hover 显示，无需额外显隐逻辑

## 导出像素语义

- 像素来源：闭包内 `straight` + `curW/curH`（当前 mip/slice 的**原始解码 RGBA8**）
- **不烘焙**：通道视图染色（R/G/B/A/RGB alpha 抹白）、亮度 remap 滑杆、翻转（CSS scaleY）
- 用户需求确认：「保存到桌面」落盘 = 系统另存为对话框（showSaveFilePicker 优先，a.download 降级）

## 格式适配规则

| 源格式 | 导出通道 | TGA bpp | PNG |
|--------|----------|---------|-----|
| 含 A 通道（DDS chMap.A 或 EXR） | RGBA | 32 | RGBA |
| 纯 RGB（含单通道灰度） | RGB（A 置 255） | 24 | RGBA（A 恒 255） |

单通道格式无需特判——解码输出已为 R 灰度（数据在 R），导出 RGB 视图即灰度图。

> PNG 经 canvas `toBlob` 输出时恒为 RGBA 通道（canvas 4 通道本性，无法去除）；无 A 源在像素层把 A 置 255，PNG 文件 alpha 全 255，与 RGB PNG 视觉/内容等价。24/32bit 判定只影响 TGA。

## TGA 编码（export-texture.js 内实现）

未压缩 truecolor TGA，无颜色表：

```
Offset  Size  Field        值
0       1     ID length    0
1       1     Color map    0（无）
2       1     Image type   2（未压缩 truecolor）
3-7     5     Color map spec 全 0
8       2     X origin     0
10      2     Y origin     0
12      2     Width        LE
14      2     Height       LE
16      1     Pixel depth  24 | 32
17      1     Descriptor   24bit → 0x00；32bit → 0x08（8 alpha bits）
```

- 像素区：bottom-up 行序（TGA 原点左下），第一行写的是图像最后一行；逐行反向输出，像素顺序 BGRA
- 无 RLE、无 ID/扩展区，输出即输入（含 A 时 A 在后）

## PNG 生成

临时 canvas：`putImageData(new ImageData(px, w, h))` → `canvas.toBlob('image/png')`。无 A 源在像素层已把 A 置 255，输出 PNG 带 alpha=255（canvas 本性，可接受）；有 A 源输出真实 alpha。

## 保存流程（export-texture.js）

```
saveBlob(blob, suggestedName):
  if window.showSaveFilePicker 存在:
    try:
      handle = await showSaveFilePicker({
        suggestedName,
        types: [{description, accept: {'image/png':['.png']} | {'image/x-tga':['.tga']}}]
      })
      writable = await handle.createWritable()
      await writable.write(blob); await writable.close()
      → 'saved'
    catch e:  AbortError（用户取消）→ 静默；其他 → 降级 a.download
  else: 降级 a.download（objectURL + <a download> click + revoke）→ 'downloaded'
```

## 文件名

- 基名：`img.src` basename 去扩展名（含 sidecar 文件名场景，basename 与 meta 层 fname 一致）
- 后缀（当前帧非默认时）：mip > 0 → `_Lv{n}`；array slice > 0 → `_F{n}`；volume depth > 0 → `_D{n}`（与 meta 浮层 Lv/F/D 术语一致；0 值不加）
- 最终：`{base}[后缀].tga` / `.png`

## 文件改动清单

1. **新增 `static/js/export-texture.js`**（~120 行，classic script，无 DOM/无依赖，暴露 `window.ExportTexture`）：
   - `encodeTGA(rgba, w, h, bpp)` → Uint8Array
   - `saveBlob(blob, suggestedName, ext, onResult)`（onResult: 'saved'|'downloaded'|'failed'|'cancelled'）
   - 建议浏览器能力检测内部完成降级
2. **`static/js/image-viewer.js`**：在 btnRow 追加两按钮，点击处理器：
   - 取闭包 `straight`/`curW/curH`；判定 hasAlpha（ddsCache chMap.A / exrCache）
   - bpp 32 时直通 straight；bpp 24 时把 A 抹 255 复制一份
   - PNG：临时 canvas toBlob → `ExportTexture.saveBlob(blob, name, '.png')`
   - TGA：`ExportTexture.encodeTGA(px, w, h, bpp)` 包 Blob → `saveBlob`
   - 按钮反馈文本按 onResult 切换
3. **`layouts/_partials/extend_footer.html`**：在 image-viewer.js 之前加 `<script src="...export-texture.js?v=1">`；`image-viewer.js?v=23` → `?v=24`（仅浏览器缓存刷新，不影响 worker URL 推导——workerUrl 正则固定拼 `decode-worker.js?v=23`）

不改：worker 文件（不触发 worker ?v 纪律）、channel-viewer.css（复用既有 class）、header.html、page-shot。

## 测试

1. **node 单测编码器**（export-texture.js 无 DOM，可 `node -e "require/load"`）：
   - 已知 2×2 像素 → 校验 18 字节头（type=2、宽高 LE、bpp、descriptor）与像素区 BGRA、bottom-up 行序
   - 24bit 与 32bit 各一组
2. **浏览器手动**（hugo server + localhost）：DDS 含 A / 无 A、EXR、单通道各一张，hover → 点保存 TGA → 另存为对话框出现，选桌面保存；PIL 或图像工具打开验证尺寸/通道/内容；PNG 同验
3. 非 Chromium / file:// 降级路径：代码审阅 + （可选）无 showSaveFilePicker 环境验证 a.download 触发

## 不做（YAGNI）

- 不做 RLE 压缩 TGA、不做 16bit/HDR TGA、不做批量导出
- 不导出 `rawPixels` HDR 原始值（当前导出语义为解码后 RGBA8 视图）
- 不新增 toast/弹层，复用按钮文本反馈
