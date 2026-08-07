#!/bin/bash
# macOS 版启动预览服务器 — 对应 bat/serve_启动预览.bat
cd "$(dirname "$0")/.."

# 若站点已在运行 → 直接打开浏览器,不再起第二个实例(避免重复启动互相杀进程)
if curl -s -o /dev/null --max-time 2 http://localhost:1313/ 2>/dev/null; then
  echo "预览服务器已在运行,直接打开浏览器。"
  open http://localhost:1313/
  exit 0
fi

# 自动生成 development 配置(供页面上"VS Code 打开"按钮使用;config/development/ 已 gitignore)
ROOT_DIR="$(pwd)"
mkdir -p config/development
cat > config/development/hugo.toml <<EOF
# Hugo >=0.161 默认只拒 text/html(allowContent=['! ^text/html$']),
# 会拦掉 content/ 里的 RenderDoc 调用图裸 HTML。显式放行 markdown + html,
# 覆盖本站全部内容类型,与生产环境(0.160.1)行为一致。仅影响本地 dev。
[security]
allowContent = ['^text/markdown$', '^text/html$']

[params]
vscodeContentBase = '$ROOT_DIR'
ignoreFiles = ['\.rdc$', '\.mp4$', '\.pdf$']
EOF

# 后台启动 hugo,窗口关闭/Ctrl+C 时一并结束
hugo server -D -p 1313 &
HUGO_PID=$!
trap 'kill $HUGO_PID 2>/dev/null' INT TERM HUP EXIT

# 等服务器就绪后自动打开浏览器
( for _ in {1..60}; do
    if curl -s -o /dev/null http://localhost:1313/ 2>/dev/null; then
      open http://localhost:1313/
      break
    fi
    sleep 0.5
  done ) &

wait $HUGO_PID
