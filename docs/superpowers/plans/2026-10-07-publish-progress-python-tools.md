# 发布进度与 Python 工具迁移

用户要求：每完成一张贴图更新生成进度；把项目内可替代的 PowerShell 功能迁到 Python。

实现范围：

- `publish_local_post.py` 增加可选进度回调，Node 转换器按行输出完成事件；保留超时、失败回滚和正常 JSON 结果。
- `local_publish_server.py` 把完成数量、总数和文件名写入任务状态；面板显示数量、文件名和进度条，最后单独显示文章写入阶段。
- `dev_actions.py` 集中实现资源管理器、Claude 项目/文章启动和旧发布入口；Claude 使用原生 CLI 和参数数组，读取现有 prompts.json。
- `protocol-relay.py` 保留从 URL 向上查找项目根的行为；安装副本位于 LOCALAPPDATA，注册表不写项目路径。
- `setup_winfs_protocol.py` 用 winreg/ctypes 注册和通知 Windows；预览 bat 改用 Python，六个旧 ps1 源文件在替代完成后删除。
- 更新项目说明、模块索引及相关测试。

验证：临时文章检查逐张回调与 HTTP 可见状态、转换失败保留旧版、原有整包替换；模拟 Explorer/Claude 启动检查 Unicode 和参数完整性；临时注册表分支检查注册值与安装中继；Python/Node 语法、bat CRLF、Hugo 构建。IDE 已连接时补充 IDE 语法检查。实际发布入口不由代理自动触发。

主 Agent 修改所有源文件，DSH 只读审查 Windows 参数、路径和进程生命周期。用户没有请求提交或推送。

## 实现与验收

- 转换器写完每张 PNG 后输出并刷新完成事件；Python 服务即时记录数量和文件名，页面每 750ms 查询任务状态并更新进度条。全部贴图完成后单独显示文章和 sidecar 写入阶段。
- 六个旧 PowerShell 入口已删除，Python 协议中继已安装。四个 HKCU 协议的实际命令均为项目外的 pythonw.exe 和 LOCALAPPDATA 下的 protocol-relay.py，保留带引号的 `%1`，Windows 关联查询均返回 Python。
- Windows 原生 Hugo 监听持有文章目录句柄，真实临时文章复现重复生成时的 WinError 5；同父目录备份无法解决。预览启动器改用 `--poll 500ms`，保留整包替换与临时目录备份，短暂目录占用最多重试两秒。相同 Hugo 预览场景下的重复生成测试已通过，旧附件被移除。
- 公开文中指向草稿文章的 ref 会使生产构建失败；发布器将正式可用 ref 解析为公开链接，将未公开目标的链接改为文字。真实公开版仅同步修正该链接，local 源不变。
- `python -X utf8 -m unittest discover -s scripts/tests -p 'test_*.py' -v`：40 项通过（24.869 秒），含逐张回调、生成未完成时 HTTP 能查询到 1/2 进度、失败保留旧版、监听期间重复生成、公开/草稿引用、Unicode 参数及临时注册表安装。
- `node scripts/test-publish-local.js`：通过，含进度条、一次 HTTP 提交、尺寸预算和当前标签跳转。生产 Hugo 构建成功，223 页；Python/Node 语法、bat CRLF 和 git diff --check 通过。未发现可连接的 Rider/JetBrains IDE MCP。
- 新预览和发布服务已运行，health 返回 texture_progress=true、busy=false，Hugo 子进程带 `--poll 500ms`。真实 local/posts 页面均返回 200，加载 publish-local.js?v=8，双向入口存在。
- 真实 Lighting 文章由用户完成的首次发布有 26 张 PNG；当前目录合计 49,681,942 字节，context 与 local 一致，未包含 DDS/EXR 或源码附件，local index.md 的 SHA256 仍为 `9F08C8B4E6C85C5C1DC179FD22B6216EB80AC7667E6268D6294194978A015A39`。后一次用户发布曾遇到目录占用，旧版得到保留；本轮修复后的重复生成只在临时文章验收，没有代理触发真实文章发布。

## DSH 只读审查记录

会话 `cf1835e7-7aa8-42ad-bd39-986d1423a37d`，run `dsh-run-muwxci51-4`，deepseek-official / deepseek-v4-flash / high，单轮三分钟预算内完成，已关闭并释放。只读检查流式进度、参数数组、Unicode、无 PowerShell/EncodedCommand、路径约束和进程生命周期。

审查快照之后补充了 Hugo 轮询、ref 解析、项目内 venv 的注册路径保护、注册值读回校验和相应测试；这些变更由主 Agent 检查并通过上述最终验证，不视为 DSH 对最终完整快照的再次审查。超时终止 Node 可能遗留浏览器子进程、退出预览等待已提交任务等意见保留为现有生命周期限制，本轮没有增加取消功能或全局杀浏览器行为。

## 文章大小与 RGB/Alpha 后续修正

- 文章顶部字数/图数之后新增 Page Bundle 全部文件大小，递归包含子目录、未引用文件与 Hugo 忽略的附件。真实 local/posts 页面显示的字节数分别为 555,541,181（529.8 MiB）和 49,681,942（47.4 MiB），与独立文件系统统计一致。
- 用户指出 ResourceId-27378 GBuffer PNG 看起来被 Alpha 预乘。与原 DDS 的全部 3840×2160 像素对照，原 PNG 的 RGBA8 值完全一致，未发生预乘；7,502,989 像素 Alpha 为 0，直接打开 PNG 时透明合成隐藏了其 RGB。
- 用户选择主 PNG 默认不透明 RGB，并另存 Alpha 图。转换器输出 RGB8 主图和必要时的 8 位灰度 `.alpha.png`，sidecar 记录 alpha_file；发布查看器组装 RGBA，保留旧版 RGBA PNG 兼容。RGBA 按钮移除手动预乘，避免 Canvas 再次合成导致透明度应用两遍。预算、成功提示和脚本版本同步更新。
- 该 GBuffer 的新版样张生成到 `.tmp-localcheck/rgb-alpha-preview/`，主图 6,804,917 字节、Alpha 图 197,077 字节，两个文件的全部像素分别与原 RGB/A 对照一致。真实公开版未触发重新发布。
- 最新完整 Python 回归 43 项通过（83.891 秒），新增不透明主图/独立 Alpha、全白 Alpha 不生成额外文件、输出命名冲突保留旧版和旧 RGBA PNG 浏览器兼容；Chrome 检查 RGB/A/RGBA 像素，RGBA 的 RGB 保持原值（Canvas 8 位往返误差不超过 1）。Node 发布面板检查通过，生产 Hugo 223 页构建通过，语法与 diff 检查通过。
- 服务空闲时已正常退出并重启，真实页面加载 publish-local v9、published-texture v2、image-viewer v33，文件夹大小可见。没有可连接的 IDE MCP。源文章不变；旧公开版需要用户手动重新生成，沿用此前真实发布入口自动审批拒绝的限制。
