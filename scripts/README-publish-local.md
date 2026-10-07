# 本地文章发布

本地预览的 local 文章顶部有「生成文章副本」按钮。点击先打开配置面板，可选择 public 或 protect，显示目标文件夹、图片数量、源码链接数量、引用资源原始体积和所选目标已有版本的实际文件夹体积。点「确认生成」后，以该文章为源重新生成相同分组和名称的 Page Bundle，成功后打开所选版本的预览并显示转换数量和实际体积。

public 生成到 `content/posts/`，随后随公开博客发布；protect 生成到 `content/protect/`，沿用项目现有的 Git 忽略和生产构建排除规则。默认 public，切换目标会同步更新路径、已有版本体积和覆盖提示。两份副本可同时存在；重复生成只替换选中的目标文章文件夹。生成期间锁定目标与尺寸，Hugo 自动刷新后继续跟踪同一目标的任务。

贴图尺寸可选原尺寸、最长边 2048、最长边 1024，默认原尺寸。尺寸预估只读取 DDS/EXR 文件头，不下载整个纹理；面板提示中的未压缩数据量按 RGB+Alpha 最多 4 字节/像素，加附件和少量余量计算，仅作上限参考，不代表 PNG 输出体积。所选目标已有版本的体积是其整个文件夹的实测值；首次生成显示「尚未生成」，切换尺寸不会改变这项历史参考。本次实际体积取决于画面内容和 PNG 压缩率，生成完成后统计。确认前取消或关闭面板不会写入文章。确认后每完成一张 PNG，面板更新“已完成 / 总数”、文件名和进度条；最后显示文章与 sidecar 写入阶段。完成后在当前标签打开所选版本；Hugo 自动刷新页面时会继续查看已提交任务的状态。

存在对应文章时，local 顶部显示「打开公开版」和／或「打开 protect 版」，posts 与 protect 顶部显示「打开本地版」。配对使用源文件路径，跳转使用 Hugo 生成的链接，因此支持自定义 slug。这些按钮仅在本地开发预览中显示。

贴图转换使用 Node.js 工作线程池，默认同时处理最多 4 张，受 CPU 数量和贴图数量限制。每个工作线程完成一张后领取下一张，分别执行解码、缩放、PNG 压缩和写入；BC6H/BC7 的解码页由各线程独立持有并复用。进度按实际完成顺序累计，最终结果保持输入顺序。转换失败时停止分派新贴图并关闭工作线程，随后由发布器保留已有目标版本。Python 服务仍同时执行一个整篇发布任务。

## 生成规则

- 每次生成完整替换所选目标文章文件夹，包括手工修改、额外文件和已经不再引用的附件。local 和另一个目标版本保持原样。
- 保留 TOML front matter，并设置 `draft = false`。沿用分组层级，补齐缺失的 `_index.md`；已有分组文件保持原样。
- 仅收集正文、封面和引用资料需要的附件。DDS/EXR 导出不透明 RGB8 PNG，取 mip 0、slice 0，使用现有解码器默认显示映射。存在非全白 Alpha 时另存同尺寸的 `文件名.alpha.png` 灰度图；Alpha 全为 255 时省略。RGB 不乘 Alpha，直接打开主 PNG 也能看到完整颜色。可选最长边限制保持宽高比，不放大小图；缩小采用最近邻采样以保留被采样像素的独立 RGBA 通道。已有 PNG/JPG 等图片原样复制。浮点原值和其他 mip/slice 不包含在 PNG 中。
- 不烘焙浏览器临时通道、亮度或翻转设置。图片 JSON sidecar 保留，并更新文件名、记录原格式、源尺寸、输出尺寸、导出范围和 `publication.alpha_file`。查看器加载 RGB 与 Alpha 图组装独立 RGBA 数据，仍支持 A/RGBA 模式，兼容旧版 RGBA PNG；透明度由 Canvas 合成一次。按 sidecar 应用翻转，显示实际 PNG 尺寸，隐藏不存在的 mip/array 控件。Alpha 图是附件，不增加正文的图数统计。
- 源码附件不复制，相关本地链接改成普通文字；同目录的同名 JSON sidecar 保留。正文中的代码块和外部网站链接保持原样。
- `context.json` 原样保留，其中的源码引用仅作为研究记录，不触发源码文件复制。
- 正文中的 `ref` / `relref` 解析为正式构建可用的文章链接；指向草稿等未公开文章时只保留链接文字，避免公开构建失败。
- 缺失资源、损坏纹理、文件名冲突或越出文章目录的资源会中止生成。先在 `.tmp-localcheck/` 中完成转换，再替换所选目标目录；失败保留已有目标版本。

## 运行环境与命令

需要 Python、`tomlkit`、Node.js，以及已安装的 Chrome/Edge。复用 `scripts/cdp/cdp.js` 寻找浏览器，也可通过 `CHROME_PATH` 指定浏览器路径。当前验证环境为 Python 3.12.7、Node.js 24.14.0、Hugo 0.160.1 extended。

`bat/serve_启动预览.bat` 同时运行 Hugo（1313）和 Python 发布服务（1314）。发布服务只监听 `127.0.0.1`，仅接受本机 1313 预览页面的请求；发布和任务查询使用随机会话令牌，目标限定在当前项目的 `content/local/`。退出 Hugo 预览时同步关闭它启动的服务；已有相同项目的独立服务会直接复用，其他项目的服务会报错。

Windows 预览启动器使用 `--poll 500ms`，避免 Hugo 持有文章目录句柄导致重复发布时报 `WinError 5`。手动启动 Hugo 时也需要该参数；自动刷新仍然有效。文件夹替换遇到短暂占用会重试，持续占用则报错并保留旧版。

已有 Hugo 预览正在运行时，可以单独启动发布服务：

```powershell
python -X utf8 scripts/local_publish_server.py
```

发布按钮通过 HTTP 提交任务，无需浏览器启动自定义协议。原有资源管理器和 Claude 快捷按钮仍使用协议中继。服务从脚本位置定位项目根，移动项目后重新启动即可；不要将其他项目的服务复用于当前文章。

命令行可先查看收集计划，再执行发布：

```powershell
python scripts/publish_local_post.py "content/local/分组/文章/index.md" --dry-run
python scripts/publish_local_post.py "content/local/分组/文章/index.md" --json
python scripts/publish_local_post.py "content/local/分组/文章/index.md" --max-edge 2048 --json
python scripts/publish_local_post.py "content/local/分组/文章/index.md" --destination protect --json
```

按钮只生成文章源文件，不提交或推送 Git。public 之后随博客正常构建和部署；protect 不进入公开博客的生产构建。

## 任务状态与日志

服务将项目根、时间、进程号、文章、所选尺寸、转换数量、输出体积和错误写入 `%LOCALAPPDATA%/GithubIO/protocols/publish-server.log`，日志自动轮转。前端收到任务后在浏览器控制台输出 `[local-publish] 发布任务已接收` 和任务编号。

配置面板无法连接服务时会禁用确认，并提示检查本地预览启动器。收到任务后可沿 `publish start`、`publish success` 或 `publish failed` 查看结果；转换失败保留此前的公开版。`http://127.0.0.1:1314/health` 可检查服务是否启动及对应项目，不返回会话令牌。

如果仍看到 `postpub:` 或 `scheme does not have a registered handler`，说明页面仍加载旧版按钮脚本，请硬刷新文章。当前按钮脚本版本为 `publish-local.js?v=11`。旧发布服务未支持 protect 时，面板会禁用该目标的确认按钮并提示重启本地预览启动器；不会把 protect 请求默默生成到 posts。RGB/Alpha 导出规则变更后，已有版本需要重新生成。

## Python 快捷工具

项目原有六个 PowerShell 入口已迁到 `dev_actions.py`、`protocol-relay.py` 和 `setup_winfs_protocol.py`。资源管理器选择当前文章；Claude 项目入口在项目根启动，文章入口在文章目录启动，单文件文章会转换为 Page Bundle 并补齐 context.json。原生 `claude.exe` 接收独立参数，提示词和模型保持现有配置，窗口使用 Python 控制台。

预览 bat 自动注册 Python 中继。手动注册或查看计划：

```console
python -X utf8 scripts/setup_winfs_protocol.py
python -X utf8 scripts/setup_winfs_protocol.py --dry-run
```

中继安装在 LOCALAPPDATA 下，使用 pythonw.exe，注册表不包含项目位置。`winfs/cc/cca` 按钮保持原协议，旧 `postpub` 链接由 Python 兼容；当前发布面板始终走 HTTP。中继错误写入同目录 relay.log，并显示错误提示。

## 验证

```powershell
python -X utf8 -m unittest discover -s scripts/tests -p "test_*publish*.py"
python -X utf8 -m unittest discover -s scripts/tests -p test_dev_actions.py
node scripts/test-publish-local.js
node scripts/test-texture-pool.js
hugo --minify --destination .tmp-localcheck/publish-production-build
```

测试需要 Pillow，覆盖目录替换、失败保留、源文件 hash、路径边界、源码 sidecar、子目录 HTML、浮点贴图、真实 BC6H/BC7/EXR、尺寸限制、Unicode 参数以及 Chrome 中的 PNG 通道、配置面板和双向按钮。HTTP 测试覆盖真实请求生成、重复生成、转换失败、来源与令牌校验；前端脚本测试覆盖先预估后确认、图片去重、尺寸联动、任务结果和当前标签跳转。测试仅在临时目录生成公开副本。
