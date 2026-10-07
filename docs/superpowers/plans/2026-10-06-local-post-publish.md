# 本地文章发布实现计划

目标：在本地文章顶部一键生成 content/posts 下的公开副本，local 为唯一源；重复发布完整替换目标文件夹，包括手工修改和旧附件。

架构：配置面板通过本机 HTTP 服务提交任务，Python 整理 Page Bundle，Node/CDP 复用现有 DDS/EXR 解码器。先在 .tmp-localcheck 下完成转换，再替换已校验的公开目录，失败保留之前的版本。预览启动器由 Python 同时运行 Hugo 和发布服务。暂不提交或推送 Git。

## 已确认规则

- 保持分组层级，补齐缺失的 _index.md；TOML front matter 保留，draft=false。
- DDS/EXR 导出 mip 0 / slice 0 PNG；可选原尺寸、最长边 2048、最长边 1024，默认原尺寸。保持宽高比，不放大小图，不烘焙浏览器临时通道、亮度和翻转状态。
- 图片、源码附件的 JSON sidecar 和 context.json 保留；图片 sidecar 更新文件名并记录原格式和导出范围。
- 源码附件不发布，相关链接转为普通文字；正文内代码块保持原样。
- 只收集正文、封面及所引用资料需要的附件，不复制整个本地研究目录。
- 正式副本不做手工修改保护：每次发布都以 local 源重新生成。
- 开发预览的 local 文章显示发布按钮；存在对应文章时，local / posts 顶部提供双向跳转。生产页面隐藏这些按钮；协议注册不写入项目绝对路径。
- 顶部按钮先打开配置面板，显示目标路径、图片和源码链接数量、原始体积及 PNG 预算。确认后显示任务进度及生成结果，成功在当前标签打开公开版；确认前关闭或取消不发布。

## 任务与文件

- [x] scripts/tests/test_publish_local_post.py：19 项接口验收，覆盖 dry-run、目录替换、坏纹理保留、路径边界、正文引用、分组、尺寸限制、入口日志和 source hash。
- [x] scripts/publish_local_post.py：输入文章路径，准备输出、转换附件、校验、替换文件夹；支持 --dry-run / --json / --max-edge。
- [x] scripts/cdp/export_texture_png.js：批量解码清单，保存无损 RGBA PNG，输出尺寸、通道、原格式与归一化范围；复用 cdp.js。
- [x] static/js/image-viewer.js、static/js/published-texture.js 与加载版本：PNG 元信息及透明处 RGB 保留，mip/array 控件只供实际 DDS 使用。
- [x] scripts/publish-local-article.ps1：协议入口与结果提示，成功打开公开版预览。
- [x] scripts/protocol-relay.ps1、scripts/setup_winfs_protocol.ps1、bat/serve_启动预览.bat：注册 postpub 协议，通过载荷定位项目根。
- [x] scripts/local_publish_server.py、scripts/tests/test_local_publish_server.py：替换按钮的协议传输，提供只监听本机的发布任务接口、结果查询、来源和会话令牌校验；六项真实 HTTP 与预览启动检查。
- [x] bat/serve_启动预览.bat：直接运行 Python 与 Hugo，撤掉被安全软件删除的 start-local-publish.ps1 启动入口；支持复用相同项目的已运行服务。
- [x] layouts/_partials/header.html、layouts/_partials/local_publish_files.html、static/js/publish-local.js、assets/css/extended/publish-local.css：文件大小与资源 URL 清单、配置弹窗、读取 DDS/EXR 头预估以及确认发布。
- [x] scripts/cdp/publish_viewer_check.js、scripts/test-publish-local.js：临时文章配置面板、预算联动、图片去重、无空白新标签以及双向跳转。
- [x] scripts/README-publish-local.md、static/js/AGENTS.md：使用、依赖、整包覆盖规则和验证说明。

## 验收

- CLI 自动化：公开目录包含转换后的 PNG / sidecar、正文、必要资料；不含 DDS/EXR/源码；原始 local 文件 hash 不变。
- 重复发布：手改正文、额外附件与不再引用的图片全部消失，最终副本符合新的 local 源。
- 失败：缺失文件、损坏纹理、输出冲突及不合法目标不删除之前的公开目录。
- 图片：已知 RGBA8、alpha=0、R32_FLOAT 和现有 BC7/EXR 样本对照尺寸、像素、翻转及默认显示。
- 页面：开发 local 文章有发布按钮，配对的 local / posts 文章有双向跳转；缺少另一版本及 production 时隐藏跳转按钮。PNG sidecar 不产生无效 mip/array 滑杆。
- Hugo production 构建通过；DSH 只读审查路径删除、协议参数和引用边界。本 Agent 负责全部文件修改。

## 验证结果（2026-10-06）

- `python -X utf8 -m unittest discover -s scripts/tests -p test_publish_local_post.py`：19 项通过，包含尺寸缩小与 sidecar 源/输出尺寸、Unicode 协议参数、成功与失败日志、临时文章的配置弹窗以及 Chrome 实际点击 local → posts → local，验证自定义 slug、无对应版本和 production 隐藏。
- `node scripts/test-publish-local.js`：通过，验证先配置后确认、原尺寸默认、尺寸预算联动、图片去重、资源 URL 与 slug，以及确认不创建新标签。
- `node scripts/test-dds-codec.js`：23 项通过；`node scripts/test-exr-codec.js`：38 项通过；`node scripts/test-codec-worker.js`：11 项通过。
- `hugo --minify --destination .tmp-localcheck/publish-production-build`：成功，204 页。Python / Node / PowerShell 语法、PS BOM、bat CRLF 和 `git diff --check` 均通过。
- 本机 postpub 注册成功，四个协议的注册命令和安装中继 hash 已核对。没有可用的 IDE MCP 连接，因此语法与页面验证使用本地工具和 Chrome。
- DSH 只读审查会话 `e7abb1c2-b24b-4849-acab-461e9999282d` 已关闭并释放。实际文章仅执行 dry-run；发布和替换测试使用临时文章，未提交或推送 Git。
- 指定 Lighting 文章：27 图、26 DDS，原始引用资源约 529.6 MiB；PNG 像素预算原尺寸约 461.8 MiB、2048 约 127.5 MiB、1024 约 33.9 MiB（另加小附件与元数据）。local index.md 的 SHA256 保持不变，正式目标未生成。
- 实际页面的浏览器自动点击被安全策略拒绝；未绕过限制触发协议，已请求用户刷新后检查真实配置面板。临时文章及纯脚本验证不触发真实文章发布。
- 用户在普通 Chrome/Edge 中确认后没有弹窗：当时未发现发布进程或正式目录，旧入口不留持久日志。现已添加并安装中继/发布器阶段日志，等待刷新后的实际点击记录；新安装中继与源码 hash 一致。
- 控制台明确报告 `scheme does not have a registered handler`。注册脚本已补齐 PowerShell 完整路径、Shell 关联通知和处理程序名称校验；Windows 32/64 位 `AssocQueryStringW` 均能返回 postpub 的 Windows PowerShell 名称和 ProgID。用户重启 Edge 后仍失败，缓存推测未获支持；同页 winfs 资源管理器按钮可正常打开目录。Edge 与注册脚本为同一用户、相同中等完整性级别。临时关联查询跟踪未取得可确定原因的结果，调试器已清除断点并正常脱离 Edge。

## 发布服务验证（2026-10-07）

- 新增 HTTP 接口测试先执行失败，再实现服务；原有 19 项发布器测试及 6 项 HTTP / 启动测试均通过。真实临时文章验证了 PNG 与 sidecar 生成、重复发布整包覆盖、失败保留旧版、来源/令牌/路径边界、CORS，以及 Hugo 启动失败退出和不同项目不能复用服务。
- 前端脚本检查通过，验证配置后确认、一次提交、等待结果、显示实际体积以及当前标签打开公开版；Hugo 自动刷新时通过 sessionStorage 恢复任务查询。
- Hugo production 构建成功，204 页；Node / Python 语法、bat CRLF 和 git diff --check 通过。当前没有可用的 Rider / JetBrains IDE MCP 连接。
- 安全软件将新增的 start-local-publish.ps1 判定为 HEUR:TrojanDownloader/PS.NetLoader.ae 并删除。该文件未恢复，启动器已撤掉对它的调用，改为前台 Python 运行；没有修改安全软件设置或添加排除项。
- 发布服务已在 127.0.0.1:1314 运行，health 返回当前项目 D:\GithubIO；实际 Lighting 页面返回 200，并加载 publish-local.js?v=7 和本机服务地址，不再包含 postpub 入口。
- 自动审批此前拒绝代理点击真实文章的发布入口。实际文章最终确认由用户手动完成；代理仅启动服务和读取状态，未通过其他通道触发真实发布。

后续用户实际生成了 Lighting 公开版（26 张 PNG，约 47.4 MiB）。逐张进度、PowerShell 迁移及重复发布目录占用修复的最终验收见 [2026-10-07 发布进度与 Python 工具迁移](2026-10-07-publish-progress-python-tools.md)；当前脚本版本为 v8，生产构建为 223 页。
