# Vendor Libraries

本地托管的第三方库。更新命令使用 `unpkg.com`（jsdelivr 在国内不可用）。

## 当前版本

| 库 | 版本 | 文件 | 大小 |
|---|---|---|---|
| KaTeX | 0.16.11 | `katex/` | 1.5MB |
| Mermaid | 11 | `mermaid.min.js` | 3.4MB |
| vis-network | 9 | `vis-network.min.js` | 606KB |
| html2canvas | 1.4.1 | `html2canvas.min.js` | 194KB |

## 更新命令

```bash
# KaTeX（CSS + JS + 字体，需同步更新 extend_head.html 中版本号注释）
VER=0.16.11
curl -k -L -o static/vendor/katex/katex.min.css "https://unpkg.com/katex@$VER/dist/katex.min.css"
curl -k -L -o static/vendor/katex/katex.min.js "https://unpkg.com/katex@$VER/dist/katex.min.js"
curl -k -L -o static/vendor/katex/auto-render.min.js "https://unpkg.com/katex@$VER/dist/contrib/auto-render.min.js"
# 字体：清空 fonts/ 后重新下载
rm -rf static/vendor/katex/fonts && mkdir -p static/vendor/katex/fonts
for fmt in woff2 woff ttf; do
  for name in KaTeX_AMS-Regular KaTeX_Caligraphic-Bold KaTeX_Caligraphic-Regular KaTeX_Fraktur-Bold KaTeX_Fraktur-Regular KaTeX_Main-Bold KaTeX_Main-BoldItalic KaTeX_Main-Italic KaTeX_Main-Regular KaTeX_Math-BoldItalic KaTeX_Math-Italic KaTeX_SansSerif-Bold KaTeX_SansSerif-Italic KaTeX_SansSerif-Regular KaTeX_Script-Regular KaTeX_Size1-Regular KaTeX_Size2-Regular KaTeX_Size3-Regular KaTeX_Size4-Regular KaTeX_Typewriter-Regular; do
    curl -k -sL -o "static/vendor/katex/fonts/${name}.${fmt}" "https://unpkg.com/katex@$VER/dist/fonts/${name}.${fmt}" &
  done
done
wait

# Mermaid
VER=11
curl -k -L -o static/vendor/mermaid.min.js "https://unpkg.com/mermaid@$VER/dist/mermaid.min.js"

# vis-network
VER=9
curl -k -L -o static/vendor/vis-network.min.js "https://unpkg.com/vis-network@$VER/standalone/umd/vis-network.min.js"

# html2canvas（整页渲染为图片用，仅 dev 配置下的文章页加载）
VER=1.4.1
curl -k -L -o static/vendor/html2canvas.min.js "https://unpkg.com/html2canvas@$VER/dist/html2canvas.min.js"
```

## 注意事项

- Mermaid 大版本升级（如 11→12）需验证 Markdown 中现有图表是否兼容，特别是 classDiagram 语法
- KaTeX 小版本升级通常安全，大版本（如 0.x→1.x）需检查 API 变更
- vis-network 按需加载，升级后抽查 GPU Graph 页面即可
