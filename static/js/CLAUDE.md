# static/js/ — Image Viewer Scripts

这些 JS 文件为博客提供 DDS/EXR 图片解码和交互式查看功能。经典 script 模式（非 ES module），与 Hugo + PaperMod 主题兼容。

## 文件说明

| 文件 | 加载方式 | 用途 |
|------|---------|------|
| `worker-shared.js` | `<script>` / `importScripts()` | 公共工具：二进制读取、half-float、DXGI 表、BC1-5 解码、格式检测。暴露 `self.ImageCodecShared`。 |
| `dds-parser.js` | `<script>`（依赖 worker-shared） | DDS 解析器。mip/array/cubemap 解析、BC6H/BC7 走 WebGL 硬件解码（需要 `document`）。暴露 `window.DDS`。 |
| `exr-parser.js` | `<script>` 或 `importScripts()` | OpenEXR 解析器（仅 uncompressed）。主线程和 Worker 复用同一文件。暴露 `window.EXR`。 |
| `decode-worker.js` | `new Worker(url)` | Web Worker。通过 `importScripts()` 加载 worker-shared + exr-parser。处理 DDS（BC1-5 + 未压缩）和 EXR。BC6H/BC7 返回失败。 |
| `image-viewer.js` | `<script>`（最后加载） | UI 入口：channel viewer、pixel inspector、mip/array slider、lazy load、缓存管理。 |
| `gpu-graph.js` | `<script>`（按需，有 GPU 图页面） | GPU 帧调用图可视化（vis-network）。`GpuGraph.init(...)` |
| `sort-bar.js` | `<script>`（列表页） | 文章列表排序：树形/平铺双模式。通过 `window.SortBarConfig` 配置。 |
| `mermaid-init.js` | `<script>`（按需，有 Mermaid 页面） | Mermaid 图表渲染：初始化配置、`<<interface>>` 修复、Dark Reader 防护。 |
| `color-remap.js` | `<script>` | 颜色通道重映射工具。 |
| `page-shot.js` | `<script>`（仅 dev 配置文章页，header.html） | 「渲染页面为图片」：html2canvas 长图/整页/屏幕截图 + 选项弹窗。`?v=N` 版本号。 |

## 加载顺序

**始终加载**（`extend_footer.html`）：
1. `worker-shared.js` → 定义 `ImageCodecShared`
2. `dds-parser.js` → 定义 `DDS`
3. `exr-parser.js` → 定义 `EXR`
4. `color-remap.js` → 颜色重映射
5. `image-viewer.js` → 初始化全部 UI 逻辑

**按需加载**（`extend_head.html`）：
- `gpu-graph.js` → 页面有 {{< gpugraph >}} 时
- `mermaid-init.js` → 页面有 Mermaid 图表时
- `sort-bar.js` → 列表页（list.html / section/local.html）

**Worker 文件**（由 image-viewer 以 `new Worker()` 加载）：
- `decode-worker.js`

## 架构约束

- **不引入 bundler**，不改成 ES module。保持 classic script + `importScripts()`。
- **BC6H/BC7 不解码进 Worker**，依赖 WebGL context，留在主线程 `dds-parser.js`。
- **DX10 uncompressed 格式必须从 `DXGI_BPP` 表设置 `bpp`**，漏设会导致像素读取偏移错误。
- **`public/js/` 是 Hugo 构建输出**，不手动编辑。源码只维护 `static/js/`。
- **Worker URL** 从 `image-viewer.js` 的 `<script src>` 推导，避免硬编码 `/js/...` 路径。
- **`workingDir`** 通过 `window.ImageViewerConfig.workingDir` 注入（Hugo 模板渲染），静态 JS 不包含 Hugo 模板语法。

## ⚠️ Worker 缓存陷阱

修改 `worker-shared.js` 或 `decode-worker.js` 后，浏览器会强缓存旧版本（`importScripts()` 不随 Hugo 重启刷新）。**必须同时做两件事**：

1. 更新 `image-viewer.js` 中 worker URL 的 `?v=N` 参数（+1）
2. 更新 `decode-worker.js` 中 `importScripts(...)` 的 `?v=N` 参数（+1）

然后让用户 `Ctrl+Shift+R` 硬刷新。漏掉任何一步，改动不会生效。

## ⚠️ mermaid-init.js 缓存纪律

`layouts/_partials/extend_head.html` 加载 `js/mermaid-init.js?v=N`（无 hash URL，版本号手动维护）。
**修改 `mermaid-init.js` 后必须把 `?v=N` 加 1**，否则浏览器缓存旧版（改 mermaid 相关功能无效时先查此项）。
`mermaid.css` 改动与 `mermaid-init.js` 强耦合（布局/查看器），同批修改时两者都要验证。

## ⚠️ page-shot.js 缓存纪律

`layouts/_partials/header.html` 加载 `js/page-shot.js?v=N`（仅 dev + 文章页，html2canvas 紧随其后）。
**修改 `page-shot.js` 后必须把 header.html 里的 `?v=N` 加 1**（现为 19）。
html2canvas 版本记录在 `static/vendor/CLAUDE.md`；升级后需重跑 CDP 实测（参考文件头注释里的兼容性策略）。
