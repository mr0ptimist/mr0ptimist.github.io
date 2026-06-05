+++
date = '2026-06-05T11:30:00+08:00'
draft = false
title = 'Draw.io 架构图集成测试'
tags = ['测试', 'drawio', 'Hugo']
categories = ['工具']
+++

## 背景

这是一篇测试文章，验证 Hugo 博客中集成 draw.io 架构图的效果。

通过自定义的 `drawio` 短代码，我们可以直接在文章中以**交互方式**展示 draw.io 图表——支持缩放、平移、点击节点查看详情。

## 微服务架构示例

以下是使用 `drawio-architect` 技能生成的微服务架构图：

{{< drawio src="microservice.drawio" ratio="3/1" >}}

## 用法说明

### 在文章中使用

1. 将 draw.io XML 文件保存到文章的 Page Bundle 目录中（如 `microservice.drawio`）
2. 在 Markdown 中用短代码引用：`{{</* drawio src="microservice.drawio" */>}}`

你也可以用 `height` 参数控制图表高度（默认 500px）：

```go
{{</* drawio src="microservice.drawio" height="600" */>}}
```

### 图表优势

相比 Mermaid 和 ASCII 图，draw.io 图表有以下优势：

- **交互式**：读者可以缩放、平移，在大图中自由导航
- **专业配色**：使用 Morandi 柔和色板，观感舒适
- **可编辑**：点击工具栏可直接在线编辑
- **精准布局**：正交路由、通道分离，连线不重叠

## 总结

测试验证了 draw.io 图表在 Hugo 文章中的可行性。通过一个轻量短代码即可实现交互式图表嵌入，适合技术文档中的架构图、流程图场景。

## GPU Trace 依赖图测试

RenderDoc 抓帧导出的 GPU 资源依赖图——展示 NaniteBasePass 的 Marker → GPU 操作 → Shader → Buffer/Texture 依赖链：

{{< gputrace src="NaniteBasePass_tree_res.html" height="700" >}}

图中节点可拖拽、缩放、点击高亮上下游依赖，工具栏支持搜索和物理布局切换。

---

*本文图表由 drawio-architect 技能自动生成。*
