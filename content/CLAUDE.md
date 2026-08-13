---
name: posts 目录写作指南
description: Hugo 博客 content/posts 目录下 Markdown 文章的 front matter 格式与写作规范
type: project
---

# content/posts/ CLAUDE.md

## 文章 Front Matter 格式

使用 **TOML** 格式（`+++` 分隔），**不要用** YAML（`---`）格式。

```toml
+++
date = '2026-04-20T10:00:00+08:00'  # ISO 8601，带时区 +08:00，影响排序
draft = false                         # true=草稿，仅 hugo serve -D 可见
title = '文章标题'
tags = ['标签1', '标签2']
categories = ['分类名']
+++
```

新建时用 `new-post.py`，它会自动扫描已有文章建议标签/分类，优先复用保持聚合页一致。

## 新建文章流程

用 `bat/new-post_新建文章.bat` 或 `python scripts/new-post.py`。所有文章统一建为 Page Bundle：

```
content/posts/{文章名}/
  index.md        ← 正文（文件名不影响 URL，URL 由标题自动生成）
  context.json    ← AI 参考资料索引（见下节）
```

## context.json 规范

每个 Page Bundle 下都有一个 `context.json`，记录续写或修改该文章时 AI 应优先查阅的参考资料。

**处理 `content/posts/` 下的文章时，若目录存在 `context.json`，必须在开始工作前先读取它。**

```json
{
  "rdc_files": [
    {
      "path": "D:/Captures/nanite_cull.rdc",
      "note": "Nanite NodeAndClusterCull 子树，EID 1189 起"
    }
  ],
  "code_refs": [
    {
      "path": "D:/UE5/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp",
      "note": "GPU 裁剪主逻辑，Two-Pass Occlusion 入口"
    }
  ],
  "notes": "自由文本：引擎版本、抓帧条件、关键 Pass 名称等"
}
```
- `rdc_files`：RenderDoc 抓帧文件绝对路径 + 描述
- `code_refs`：源代码文件或目录绝对路径 + 描述
- `notes`：自由文本补充
- 路径为本机绝对路径，换机器失效，但文件名和 note 仍有参考价值


## 正文规范

- 标题用 `##` `###` 逐级递减，不要跳级
- 代码块标注语言：` ```cpp ` ` ```ini ` ` ```bash ` 等
- 表格用 GFM 语法
- 所有 `##` 标题会自动被 JS 渲染为可折叠区块，**不要**在 `##` 前后添加额外的 `<details>` HTML；`###` 及以下不会折叠，正常书写
- **`---` 只允许出现在 `##` 章节之间**（即紧接下一个 `##` 标题之前）。禁止把 `---` 放在同一 `##` 内部的 `###` 小节之间——这会让 JS 提前截断 `##` 的折叠区域，导致该 `##` 及其后续所有同级章节都无法折叠。
- **标题层级不要平铺**：同一 `##` 内若有"流程概述"+ 若干"Phase 步骤"，Phase 必须用 `####` 嵌在一个 `###` 父节点下，不能把 Phase 直接列为 `###` 与概述并排，否则结构语义混乱且折叠失效。
- 图片使用 Page Bundle：文章含图片时，md 和图片放在 `content/posts/{文章名}/`（md 命名为 `index.md`），用相对路径引用
- VSCode 粘贴图片后运行 `organize_post_images.py` 自动压缩整理（PNG→WebP，>1920px 缩放），原图保留为 `.bak` 手动确认后删除
- 中文与英文/数字之间加空格
- **处理文章前，若 `D:\Projects\OtherProjects\GithubIO\content\PRIVATE.md` 存在，必须先读取。**

## 研究类文章规范

- 涉及技术细节、硬件规格、架构原理等非通用知识时，**必须上网搜索验证**，不可凭记忆编写
- 每个关键论据、数据、引用**必须标注来源**，格式如：
  - 正文内：`据 [Qualcomm 官方文档](URL) 描述……`
  - 章节末尾：用 `### 参考` 或 `### 官方文档` 列出所有来源链接
- **严禁幻觉**：不确定的信息不写，查不到权威来源的标注"待验证"
- 优先引用：官方文档 > 官方博客 > 论文/专利 > 知名技术博客 > 社区讨论
- **引用网址必须验证可访问**：每个外链写入文章前必须 curl 或浏览器确认返回 200，404/超时的链接不使用

## Mermaid 图表规范（兼容 11.x）

### 写法规则

- 直接用 `<<interface>>`，无需手动转义（JS 自动修复）
- flowchart 节点标签含 `()` `,` `:` `@` `→` `×` `+` `=` 等**必须**用 `["..."]` 包裹，否则 Syntax error
- **禁止在节点标签中用 HTML 实体**（`&lt;` `&gt;` `&amp;` 等）——浏览器 HTML 解析器会在 JS 修复之前先把它们转成 DOM 元素吃掉，导致标签内容残缺。此问题 JS 修复逻辑无法覆盖，只能用纯文本
- classDiagram 方法签名避免嵌套 `()`：用 `+processImage()` 不要用 `+processImage(img)`；参数说明放在注释或正文中
- classDiagram 关系标签避免 `/`（会被解析为换行符）
- 验证：`npx --yes @mermaid-js/mermaid-cli@11.16.0 -i file.mmd -o out.png`（建议全局装好 `npm install -g @mermaid-js/mermaid-cli@11.16.0`，npx 每次下载很慢）

### 跨图类型语法差异（重要）

| 特性 | flowchart | classDiagram |
|------|-----------|-------------|
| `classDef` / `class` | ✅ 支持 | ❌ **不支持**，会报 Syntax error |
| 节点样式方式 | `classDef name fill:...` + `class nodeList name` | 无需额外样式或使用 `cssClass` / `:::styleClass` |
| 节点形状 | `[...]` `(...)` `{...}` `((...))` 等 | 固定矩形（class box） |

**常见踩坑**：给 classDiagram 加了 `classDef` 和 `class` 试图配色 → Mermaid 11.x 直接 Syntax error。classDiagram 不需要 classDef，默认渲染即可。

### Dark Reader 兼容

所有 **flowchart** 节点必须用 `classDef` 指定 `fill` 和 `color`（mermaid 加 `!important`，Dark Reader 无法覆盖）。不要用 `<style>` 注入或 Shadow DOM。

### 标准配色方案

| class | fill | 用途 |
|-------|------|------|
| `proc` | `#e1f5fe` | 流程步骤 |
| `dec` | `#fff9c4` | 判断/分支 |
| `data` | `#fff3e0` | 数据/IO |
| `ok` | `#e8f5e9` | 成功/输出 |
| `err` | `#ffebee` | 错误/等待 |
| `out` | `#f3e5f5` | 最终结果 |

每个 classDef 都必须带 `color:#000`，例如 `classDef proc fill:#e1f5fe,color:#000`。

> ⚠️ `data`、`out` 等类名在 Mermaid 11.16.0 中可能触发保留字冲突，建议用 `io` 替代 `data`、`result` 替代 `out`。

### 长标签换行规范（wrappingWidth 400）

博客全局 `flowchart.wrappingWidth: 400`——标签超过 400px 会自动折行（14px 字体 ≈ 28 个汉字 / 55 个 ASCII 字符一行）。

- **长文本必须手动加 `<br/>` 引导换行**：自动折行在中文里断点随机（CJK 无词边界，如"纹|理"），观感差
- 分行以语义单元为单位：命令、输入、输出各占一行；括号注释尽量整段同行
- 引导换行后**每行必须短于 400px**，否则仍会被自动折行（白引导）
- **边缘标签**（`A -. "..." .-> B` 的边标签）上限是 mermaid 内部固定的 200px，`wrappingWidth` 不影响——边缘标签每行控制在 ~14 个汉字以内
- **子图（subgraph）标题保持单行**：mermaid 多行子图标题会从集群顶边向下挂进内部，与第一排节点重叠（布局缺陷，无配置可解）。说明文字放正文
- 写完后用 `mmdc` 渲染或浏览器打开验证：确认没有意外折行（行数 = `<br/>` 数 + 1）

## 文章分组（Section 文件夹）

多篇文章需要归类时，用文件夹层级 + 各层 `_index.md`：

```
content/posts/UE/
  _index.md           ← title = 'UE'（TOML front matter，无需正文）
  Landscape/
    _index.md         ← title = 'Landscape 地形'
    文章A/index.md
    文章B/index.md
```

- `_index.md` 让文件夹成为 Hugo section，列表页树形视图自动渲染为可折叠文件夹
- 空 section 自动隐藏；单篇文章用 Page Bundle 即可，不需套 `_index.md`
- 同样适用于 `content/local/`

## 缩略图

列表页自动提取每篇文章首张图片作为缩略图：
- 匹配 `![...](....dds/exr/png/jpg/jpeg/webp)`，相对路径自动补全
- DDS/EXR 由浏览器端 JS 解码为 canvas；无图的文章显示圆点 bullet
- 建议在文章开头放一张有代表性的截图
