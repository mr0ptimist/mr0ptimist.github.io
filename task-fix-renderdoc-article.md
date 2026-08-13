# 任务：修正《RenderDoc逆向分析工具链盘点》文章事实错误

## 任务目标

依据 RDC 工具链核验报告（**代码是真理源**），修正文章 bundle 中 3 处 doc↔code 不一致，并收尾。

### 修正 1 — rename_semantic.py 拷贝数 4 → 5

- 文件：`content/posts/RenderDoc逆向分析工具链盘点/index.md`（约第 320 行）
- 原文：`注意 rename_semantic.py 在 4 个 proj 目录各有一份拷贝（endfield×2 / 苍穹玻璃×2），改动需同步四处。`
- 修正为：`注意 rename_semantic.py 在 5 个 proj 目录各有一份拷贝（endfield-deferred / endfield-transparent / genshin-firmament-glass / genshin-firmament-glass-f20157 / flow-e2e-5999），改动需同步五处。`
- 证据：`D:\ClaudeProjects\RDC\ShaderRE\proj\` 下实测 5 份 `_src/rename_semantic.py`（flow-e2e-5999 为 2026-08-12 新建的苍穹玻璃 E2E 验收工程，复用 f20157 映射）

### 修正 2 — urp_verify_dxc.py 编译目标不是 SM5.0

- 文件：`content/posts/RenderDoc逆向分析工具链盘点/index.md`（约第 327 行）
- 原文：`urp_verify_fxc.py / urp_verify_dxc.py — fxc / dxc 编译验证（D3D11 SM5.0）`
- 修正为：`urp_verify_fxc.py（fxc 编译验证 D3D11 SM5.0）/ urp_verify_dxc.py（dxc 预检，SM6.0 出 DXIL）`
- 证据：`ShaderRE/_src/ToUnity/URP/urp_verify_dxc.py:111` 用 `-T {stage}_6_0`；`urp_verify_fxc.py:67` 用 `/T {stage}_5_0`

### 修正 3 — flow-reverse-engineering.mmd 的 RENAMES 不是真实 dict 名

- 文件：`content/posts/RenderDoc逆向分析工具链盘点/flow-reverse-engineering.mmd`
- 原文：`rename_semantic.py（RENAMES + CBUFFER_RENAMES）`
- 修正为：`rename_semantic.py（MEMBER/ARRAY/ACCESS/RESOURCE_RENAMES + CBUFFER_RENAMES）`
- 证据：`ShaderRE/proj/genshin-firmament-glass-f20157/_src/rename_semantic.py:16,30,154,161,174`

### 收尾（按 fact-check-report skill 惯例）

1. 更新 `context.json` 的 `notes` 字段：追加本轮核验记录（2026-08-13 以代码为基准第三轮核查：73 条陈述 71 证实 / 2 驳斥，已修正上述 2 处正文 + 1 处 mermaid 图）
2. 在 `index.md` 末尾追加核查签章（若已有以 `> **📋 事实核查**` 开头的旧签章，先删旧再追加；签章与正文间空一行）：

   `> **📋 事实核查**：本文于 2026-08-13 经 fact-check-report 核查（以代码为真理源），共 73 条陈述（✅ 71 正确 / ❌ 2 有误），已修正 2 处 + mermaid 图 1 处。`

3. 修改完成后执行 `git diff --stat` 和 `git diff` 把结果展示给用户，**询问用户是否提交，不要擅自 commit**。

## 约束与验收标准

- 只改上述 3 处正文 + context.json notes + 签章，**不得改动文章其他内容**
- 修改前先 Read 确认原文，用 Edit 工具精确替换
- 验收：`git diff --stat` 仅含 3 个文件（index.md / context.json / flow-reverse-engineering.mmd）；grep 确认旧表述（"4 个 proj 目录"、"D3D11 SM5.0"、单独的 "RENAMES"）已不在
- 只改 `content/posts/RenderDoc逆向分析工具链盘点/` 下的文件，不动博客其他内容

## 项目背景

- 项目：`D:\Projects\OtherProjects\GithubIO`（Hugo 博客，git 仓库）
- 文章 bundle：`content/posts/RenderDoc逆向分析工具链盘点/`（index.md + context.json + flow-reverse-engineering.mmd）
- 核验依据来自 RDC monorepo（`D:\ClaudeProjects\RDC`）；改动前如存疑，可回 RDC 代码复核证据行号

## 本次配置

- 目标目录：`D:\Projects\OtherProjects\GithubIO`
- 模型：`deepseek-v4-flash[1m]`

## 汇报要求

完成后向用户汇报：修改了哪几处、diff 摘要、是否已提交（按用户指示）。

## 上下文摘要（发起 session 的核验结论）

2026-08-13 以代码为真理源核验整条 RDC 工具链 + 本文。文章 73 条技术陈述：71 证实、2 驳斥——
(1) rename_semantic.py 实际 5 份拷贝（文章写 4 份/同步四处）；
(2) urp_verify_dxc.py 实际 SM6.0 DXIL（文章归入 SM5.0）。
另 flow-reverse-engineering.mmd 中 "RENAMES" 非真实 dict 名（实为 MEMBER/ARRAY/ACCESS/RESOURCE_RENAMES 四 dict + CBUFFER_RENAMES）。
已确认健康、**无需改动**的锚点：29 GLSL + 40 HLSL pass 数、RenderdocMCP 11 模块 53 工具、Patcher 170/4 规则、三层验证 verdict、tolerance=4 均实测一致。
