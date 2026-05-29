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
hidden = true                         # 可选，密码保护
+++
```

新建时用 `new-post.py`，它会自动扫描已有文章建议标签/分类，优先复用保持聚合页一致。
posts文件夹的文章内容，禁止出现ZR_MOD相关内容，出现了问用户应该怎么办。

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

## 研究类文章规范

- 涉及技术细节、硬件规格、架构原理等非通用知识时，**必须上网搜索验证**，不可凭记忆编写
- 每个关键论据、数据、引用**必须标注来源**，格式如：
  - 正文内：`据 [Qualcomm 官方文档](URL) 描述……`
  - 章节末尾：用 `### 参考` 或 `### 官方文档` 列出所有来源链接
- **严禁幻觉**：不确定的信息不写，查不到权威来源的标注"待验证"
- 优先引用：官方文档 > 官方博客 > 论文/专利 > 知名技术博客 > 社区讨论
- **引用网址必须验证可访问**：每个外链写入文章前必须 curl 或浏览器确认返回 200，404/超时的链接不使用

## Mermaid 图表规范（兼容 11.x）

**写法规则**：
- 直接用 `<<interface>>`，无需手动转义（JS 自动修复）
- flowchart 节点标签含 `()` `,` `:` `@` `→` `×` `+` `=` 等**必须**用 `["..."]` 包裹，否则 Syntax error
- 验证：`npx @mermaid-js/mermaid-cli -i file.mmd -o out.png`

**Dark Reader 兼容**：所有 flowchart 节点必须用 `classDef` 指定 `fill` 和 `color`（mermaid 加 `!important`，Dark Reader 无法覆盖）。不要用 `<style>` 注入或 Shadow DOM。

**标准配色方案**：

| class | fill | 用途 |
|-------|------|------|
| `proc` | `#e1f5fe` | 流程步骤 |
| `dec` | `#fff9c4` | 判断/分支 |
| `data` | `#fff3e0` | 数据/IO |
| `ok` | `#e8f5e9` | 成功/输出 |
| `err` | `#ffebee` | 错误/等待 |
| `out` | `#f3e5f5` | 最终结果 |

每个 classDef 都必须带 `color:#000`，例如 `classDef proc fill:#e1f5fe,color:#000`。

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
