# CLAUDE.md

## 项目概述

Hugo 静态博客（https://mr0ptimist.github.io/），使用 PaperMod 主题（git submodule）。内容为中文，聚焦图形渲染、GPU 优化、游戏引擎内部原理。推送到 `main` 分支后通过 GitHub Actions 部署到 GitHub Pages。

## 开发命令

```bash
hugo server -D -p 1313                  # 本地预览（含草稿，固定端口）
hugo                                    # 构建到 public/
python scripts/new-post.py              # 交互式创建文章 — 生成 Page Bundle（文章名/index.md + context.json）
python scripts/organize_post_images.py           # 整理文章图片到 Page Bundle，自动压缩
python scripts/organize_post_images.py --dry-run # 预览整理计划，不执行
python scripts/organize_post_images.py --post "文章名"  # 只处理指定文章
```

`bat/` 目录下的等效 `.bat` 文件：`serve_启动预览.bat`、`build_构建发布.bat`、`new-post_新建文章.bat`、`clean_清除输出.bat`、`organize_images_整理贴图.bat`。

Hugo 版本：0.160.1 extended。

## 架构

- **主题**：PaperMod，以 git submodule 形式位于 `themes/PaperMod` — 禁止直接修改主题文件
- **定制覆盖**：统一放在 `layouts/_partials/`、`layouts/`（根级模板）、`assets/css/extended/`、`archetypes/`
- **客户端功能**（`layouts/_partials/extend_footer.html`）：
  - `##` 标题自动折叠为 details/summary，禁止手动包裹 `<details>` 标签
  - 文章宽度 / TOC 宽度可拖拽滑块调整
  - TOC 自动过滤深层标题、高亮当前激活章节
- **DDS/EXR 直接查看器**：浏览器端像素解码 + WebGL 显示，无需生成预览 PNG。详情见 `static/js/CLAUDE.md`
- **KaTeX 数学公式**：本地托管（`static/vendor/katex/`），全站加载。`$...$` 行内、`$$...$$` 块级，初始化在 `extend_footer.html`
- **Mermaid 图表**：本地托管（`static/vendor/mermaid.min.js`），按需加载。初始化在 `static/js/mermaid-init.js`
- **GPU 调用图**：vis-network 短代码（`{{< gpugraph >}}`），本地托管（`static/vendor/vis-network.min.js`）
- **列表排序**：`static/js/sort-bar.js` 共享模块，`list.html` 和 `section/local.html` 通过 `window.SortBarConfig` 配置
- **404 页面**：`layouts/404.html`，中文友好提示
- **第三方库**：全部本地托管在 `static/vendor/`，零 CDN 依赖。版本和更新命令见 `static/vendor/CLAUDE.md`
- **树形列表视图**：`layouts/_partials/post_tree.html` 递归 partial，基于 Hugo `.Sections` 渲染文件夹层级。`list.html`（`/posts/`）和 `section/local.html`（`/local/`）均已接入。需在分组文件夹中添加 `_index.md`（含 `title`）使其成为 Hugo section。样式：`assets/css/extended/post-tree.css`
- **缩略图预览**：树形视图中自动提取每篇文章首张图片（DDS/EXR/PNG/JPG/WebP），DDS/EXR 由 `image-viewer.js` 转为 canvas 显示
- **自定义头部**：`layouts/_partials/header.html`（主题切换、宽度控制、VS Code/资源管理器/Claude Code 快捷按钮）
- Hugo server 在 watch 模式下自动重载，无需手动重启

## 内容规则

**详细规范见 [`content/CLAUDE.md`](content/CLAUDE.md)**。关键底线：

- Front matter 必须用 **TOML**（`+++` 分隔符），禁止 YAML（`---`）
- 处理任何文章前，必须先读取其所在目录的 `context.json`
- 禁止在 `##` 外包裹 `<details>` 标签；禁止在同一 `##` 内的 `###` 小节之间放 `---`
- 分组文件夹需添加 `_index.md`（含 `title`），空文件夹自动隐藏