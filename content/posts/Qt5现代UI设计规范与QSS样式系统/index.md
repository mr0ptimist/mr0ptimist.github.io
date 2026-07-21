+++
date = '2026-07-16T18:00:00+08:00'
draft = false
title = 'Qt5 现代 UI 设计规范与 QSS 样式系统调研'
tags = ['Qt5', 'PyQt5', 'QSS', 'GUI', '设计规范', '主题', '暗色模式']
categories = ['桌面开发']
+++

## 1. 调研背景

为 ToolsPlay 工具集建立统一的 UI 设计语言，本文系统调研了 Qt5 生态中的现代 UI 设计规范，覆盖官方指南、第三方主题库、主流设计系统的通用原则。

---

## 2. Qt 官方设计指南

### 2.1 Qt Quick Controls Guidelines

Qt 官方为各类控件提供了明确的使用指南 [Qt Quick Controls Guidelines](https://doc.qt.io/qt-5/qtquickcontrols2-guidelines.html)：

| 控件类型 | 核心原则 |
|----------|---------|
| **Button** | 文本用动词描述动作；不要用 Button 设状态（用 Switch） |
| **CheckBox** | 标签是"勾选后为真的陈述"，不含否定句 |
| **RadioButton** | 列表纵向排列，确保有默认选中项 |
| **ToolButton** | 外观图形化，适合嵌入 ToolBar |
| **ProgressBar** | 表示确定性进度，须定期更新值 |
| **Dialog** | 用于多步骤确认和焦点操作；按钮文案须明确（不要"是/否"） |

**通用原则**：使用默认字体（除非有 UI 规范明确指定），考虑翻译后长文本对布局的影响，操作列靠右对齐。

### 2.2 Qt 官方 UI Design Skill（Agentic Tools）

从 Qt 6.7 起，Qt 官方推出了 [Agentic Tools UI Design Skill](https://doc.qt.io/agentictools/skills/qt-ui-design/)，规定设计前必须确认的 **7 项前置信息**：

1. **目标平台**：Windows / macOS / Linux / 嵌入式
2. **屏幕几何**：分辨率、缩放比例
3. **Design System**：项目是否已有设计系统；没有则推荐 Fusion / Material / FluentWinUI3
4. **内容优先级**：首要 / 次要 / 三级信息
5. **观看距离**：手持 ~30cm / 桌面 ~60cm / 面板 ~1.5m / 墙面 ~3m
6. **语言与输入**：语言方向（RTL/LTR）、触摸/键盘/鼠标/语音
7. **动画时长**：图标/徽章 100-150ms，卡片/面板 200-300ms，大过渡 300-400ms

### 2.3 QSS 盒模型

QSS 完全兼容 CSS Box Model [QSS Reference](https://doc.qt.io/qt-6/stylesheet-reference.html)：

```
margin → border → padding → content
```

四层同心矩形，默认值均为 0（四矩形完全重合）。还支持 CSS2 标准属性 `border-image`（九宫格缩放）、`background-image`、`image`（可放 SVG 自动缩放）。

---

## 3. 第三方主题与样式库

### 3.1 QDarkStyleSheet

[GitHub](https://github.com/ColinDuquesnoy/QDarkStyleSheet)

最成熟的 Qt 通用暗/亮主题框架，支持 PyQt4/5/6 + PySide2/6 + C++。v3 重构为可扩展主题框架，9 色调色板，SCSS 辅助生成，SVG 图标系统。

```python
import qdarkstyle
app.setStyleSheet(qdarkstyle.load_stylesheet(qt_api='pyqt5'))
```

### 3.2 Qt-Material

[GitHub](https://github.com/UN-GCPDS/qt-material) · [文档](https://qt-material.readthedocs.io/)

Material Design 风格完整实现，20+ 内置主题（dark/light 各十余种）。

```python
from qt_material import apply_stylesheet
apply_stylesheet(app, theme='dark_teal.xml')
```

**亮点**：
- 运行时热切换主题（`apply_stylesheet(app, theme='light_red.xml')`）
- 自定义 accent 颜色与字体
- Density scaling（`extra={'density_scale': -1}` 实现紧凑布局）
- 导出 `.qss + .rcc` 供 C++ 项目使用

### 3.3 Enhanced Qt StyleSheets Collection

[GitHub](https://github.com/hammam999/Enhanced-Qt-StyleSheets-Collection)

基于 GTRONICK 原版的增强型 QSS 合集，新增自定义 SVG 图标系统。提供 MacOS-Enhanced、MaterialDark-Enhanced、Ubuntu-Enhanced 等 12+ 主题，覆盖全部主流 Qt Widget。

### 3.4 QtModernRedux

[GitHub](https://github.com/robertkist/qtmodernredux)

现代暗色主题 + 无边框窗口框架。支持跨平台一致外观（Win/Mac/Ubuntu），自定义标题栏（可嵌入 Chrome 式 Tab），8 方向窗口缩放，矢量高 DPI 图标，窗口投影。

### 3.5 QtNovaUI

[GitHub](https://github.com/MrAhmedSayedAli/QtNovaUI)

C++ 手绘控件库，用 `QPainter` + QSS 实现像素级自定义控件：
- 带阴影动画的按钮
- 自定义 ComboBox（淡入淡出动画）
- 自定义 CheckBox（hover 状态）
- 圆角卡片容器
- 毛玻璃菜单
- 渐隐滚动条
- 拖影与模糊效果

---

## 4. 主流设计系统的通用规范

以下规范来自 Ant Design、ArcoDesign、Microsoft Fluent，均为框架无关的设计原则，完全可以在 QSS 中实现。

### 4.1 间距与网格

| 来源 | 基数 | 体系 |
|------|------|------|
| **Ant Design** | 8px | 24 栅格，Gutter 固定 / Column 弹性 |
| **Microsoft Fluent** | 4px | 间距和尺寸应为 4 的倍数 |
| **ArcoDesign** | 4px / 8px | 同推网格体系 |

**实践结论**：4px 最小栅格，8px 主栅格。布局边距建议 8/12/16/24/32px（8 倍数），控件间距 4/8/12px（4 倍数）。

### 4.2 字体层级

| 来源 | 最小字号 | 主字号 | 层级差距 | 行高 |
|------|---------|--------|---------|------|
| **Ant Design** | 12px | 14px | 2-4px | — |
| **ArcoDesign** | 12px | 14px | 2-4px | 1.4× |
| **Microsoft Fluent** | 12px (Caption) | 14px (Body) | — | 20px (Body) |

**层级建议**（Windows 中文界面）：

| 层级 | 字号 | 用途 |
|------|------|------|
| Caption | 12px | 辅助文字、脚注 |
| Body | 14px | 正文、表单、列表 |
| Subtitle | 16px | 卡片标题、小标题 |
| Title | 20px | 面板标题 |
| Heading | 24-28px | 页面主标题 |

**注意事项**：
- 中文行高需 1.4-1.6 倍（中文字符密集无 ascender/descender），西文 1.2 倍即可
- 段落间距 ≥ 字号的 1.5 倍（WCAG AAA 标准）
- 一个产品中字体层级控制在 3-5 种，需要强调的文本通过字重（bold）而非字号区分
- 最小可识别文字 12px，低于此值时不应承载关键信息

### 4.3 颜色与对比度

- 暗色背景用深灰（`#0d1117` / `#1e1e1e`）而非纯黑 `#000`，减少视觉疲劳
- 确保 WCAG AA 对比度：正文 ≥ 4.5:1，大字（≥ 18px bold 或 ≥ 24px）≥ 3:1
- 亮/暗双主题用 CSS 变量或 QSS property 切换，不维护两份独立 QSS
- 交互状态至少覆盖：默认 / hover / pressed / disabled / focus
- Accent 色推荐蓝色系（`#1f6feb` 附近），红色系用于 destructive 操作

### 4.4 布局原则

- 明确动态布局范围：哪些区块随窗口缩放，哪些固定
- 表格中列宽与内容一致（`resizeColumnsToContents()`），操作列固定宽度靠右
- 页面主操作按钮放顶部，有且只有一个 primary 按钮，位置在第一个
- 删除/危险类按钮默认禁用，勾选数据后启用
- 前后端交互按钮要有 loading 状态
- 弹窗：单列 520px，双列 1000px

### 4.5 按钮尺寸

| 规格 | 高度 | 用途 |
|------|------|------|
| Small | 24-28px | 工具栏操作、标签关闭 |
| Medium | 32-36px | 标准操作（默认） |
| Large | 40-48px | 主 CTA |

按钮间距 ≥ 8px，同一水平行中按钮高度必须一致。

---

## 5. 对 ToolsPlay 的启示

### 5.1 已有基础设施

ToolsPlay 的 `_shared/theme_config.py` 已实现了 Catppuccin Mocha 暗色 + Latte 亮色双主题，对标上述标准：

| 已有 | 评价 |
|------|------|
| `Colors` + `LightColors` 双色板 | ✅ 完整，含 semantic 颜色（danger/accent/claude/warning） |
| QSS 缩放引擎 `scale_qss()` | ✅ 覆盖 75%-150% |
| `StyledButton` 禁止固定尺寸 | ✅ 强制执行，对齐官方 Button Guidelines |
| `make_sized_button(sm/md/lg)` | ✅ 24/32/44px 三档，与 Fluent/Ant Design 对齐 |
| `ui_lint.py` 运行时扫描 | ✅ 4px 网格检查、内联 QSS 检查、字体检查 |
| 暗标题栏 `apply_dark_titlebar()` | ✅ Windows DWM API |

### 5.2 可改进方向

1. **字号基准上调**：当前 `BASE_FONT_PT = 10.0`，而主流中文桌面正文为 14px（≈10.5pt in 96dpi but 14px at higher DPI）。建议基准 12-14px，SM/LG 比例从 0.8/1.2 调至 0.85/1.3
2. **Density scaling**：参考 Qt-Material 的三档密度（紧凑/标准/宽松），通过 `scale_qss()` 已可覆盖，但需在 UI 中暴露开关
3. **按钮 loading 状态**：当前无内置 loading spinner，可参考 QtNovaUI 的内置 loader 模式
4. **焦点环（focus ring）**：当前 QSS 仅处理 border-color on focus，建议为键盘导航增加 visible focus indicator

---

## 参考

- [Qt Quick Controls Guidelines](https://doc.qt.io/qt-5/qtquickcontrols2-guidelines.html) — Qt 官方控件使用指南
- [Qt Agentic Tools UI Design Skill](https://doc.qt.io/agentictools/skills/qt-ui-design/) — Qt 官方 UI 设计前置检查清单
- [Qt Style Sheets Reference](https://doc.qt.io/qt-6/stylesheet-reference.html) — QSS 属性/伪状态/子控件完整参考
- [Qt Layout Management](https://doc.qt.io/qt-6/layout.html) — 布局系统 sizePolicy / stretch 机制
- [QDarkStyleSheet](https://github.com/ColinDuquesnoy/QDarkStyleSheet) — 最成熟的 Qt 暗/亮主题框架
- [Qt-Material](https://qt-material.readthedocs.io/) — Material Design 风格完整实现
- [Enhanced Qt StyleSheets Collection](https://github.com/hammam999/Enhanced-Qt-StyleSheets-Collection) — 12+ 主题 QSS 合集
- [QtModernRedux](https://github.com/robertkist/qtmodernredux) — 现代暗色主题 + 无边框窗口
- [QtNovaUI](https://github.com/MrAhmedSayedAli/QtNovaUI) — C++ 手绘自定义控件库
- [Ant Design 布局](https://ant.design/docs/spec/layout-cn/) — 8px 网格 + 24 栅格体系
- [ArcoDesign 样式指南](https://www.arco.design/docs/spec/style-guideline) — 字体层级与可读性规范
- [Windows Widgets 设计基础](https://learn.microsoft.com/zh-cn/windows/apps/design/widgets/widgets-design-fundamentals) — Microsoft Fluent 小组件规范

> **📋 事实核查**：本文于 2026-07-16 经 exa 多源核查，共 45 条陈述（✅ 35 正确 / ❌ 10 有误 / ❓ 0 存疑，已修正 10 处）。
