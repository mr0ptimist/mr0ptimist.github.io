# scripts/cdp — 列表页树形视图回归检查

验证 `/local/`、`/posts/` 的树形视图：**分组守恒** + **排序正确**。这两个行为都由
`static/js/sort-bar.js` 在浏览器里完成，服务端 HTML 看不出来——所以用「服务端渲染结果
作期望值、headless Chrome 执行后的 DOM 作实际值」对比。

## 依赖

- Node ≥ 21（用内置 `fetch` / `WebSocket`，无需 npm 安装）
- 本机 Chrome 或 Edge（可用环境变量 `CHROME_PATH` 指定）
- 站点已构建且能被 HTTP 访问：

```bash
hugo -e development -D -d .tmp-localcheck          # 必须 -e development：生产配置 ignoreFiles 会剔除 local/
python -m http.server 8899 --directory .tmp-localcheck
```

## 用法

```bash
# 1) 从构建产物提取期望结构（列表 → 直属文章标题）
python scripts/cdp/parse_expected.py .tmp-localcheck/local/index.html expected.json

# 2) 分组守恒：JS 执行后每个列表的文章集合必须与期望一致
node scripts/cdp/tree_check.js http://127.0.0.1:8899/local/ expected.json

# 3) 排序与交互：加载即排序、按钮 asc/desc 互逆、日期单调、集合始终一致
node scripts/cdp/order_check.js http://127.0.0.1:8899/local/ expected.json

# 4) 缩略图渲染 + 缓存：冷启动写缓存 → 刷新 0 请求、耗时骤降、画面一致
node scripts/cdp/thumb_check.js http://127.0.0.1:8899/local/ 16
```

`/posts/` 同理（把 URL 和期望值的路径换掉即可）。三个脚本失败时退出码均为 1。

## 这些断言挡住的真实事故

- **分组塌陷**（2026-09 修）：`sort-bar.js` 用递归 `querySelectorAll('.ptree-article')` 抓全树
  文章，再整体 `insertBefore` 到"排序第一名"的父 `<ul>`——列表页每次加载都会触发，所有分组
  塌进同一个文件夹（`tree_check` 会 FAIL）。
- **排序失效**：只验证"集合守恒"不够，还要验证排序真的发生且方向正确（`order_check`）。
- **缩略图静默失败**：`DXGI_CHANNELS` 定义在列表页的提前 return 之后，`chMapFromDxgi` 抛错被
  `.catch(){}` 吞掉，DDS 缩略图全变碎图且控制台无输出（`thumb_check` 会 FAIL）。
- **缓存回归**：刷新后仍在下载/解码（缓存未命中）、或缓存版与解码版画面不一致（如翻转改回 CSS
  变换）——`thumb_check` 的 0 请求 + RGB 均值断言会挡住。

## 注意

- `parse_expected.py` 只解析 `<ul class="ptree-list">` 结构；改动 `post_tree.html` 的输出结构后
  两个 checker 的 CSS 选择器要同步。
- 断言与排序**规则**无关：JS 用 `localeCompare`、Hugo 用 Go 字符串比较，中文顺序本就不同，
  所以只断言"同键反向 = 精确逆序"和"单调性"，不断言与期望值顺序相同（日期有并值时稳定排序
  保持原序，逆序断言跳过）。
