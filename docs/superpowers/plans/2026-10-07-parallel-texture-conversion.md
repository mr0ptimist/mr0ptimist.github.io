# 贴图并行转换与验收记录

用户要求将本地文章发布时的贴图转换改为并行。沿用现有 DDS/EXR 解码、尺寸限制、RGB/Alpha 导出和整包替换规则。

## 实现

- `export_texture_png.js` 管理持久 Node.js 工作线程池，默认数量为 `min(4, CPU 可用并行数, 图片数)`；空清单不启动线程。转换清单可指定 `workers: 1..4`，用于调试和串行对照。
- `texture_worker.js` 在各自线程中执行解码、缩放、PNG 过滤、zlib level 9 压缩和文件写入。各线程持有独立 VM；BC6H/BC7 按需创建并复用独立的浏览器解码页与本机 HTTP 服务。
- 一张完成后领取下一张；主线程统一输出完成事件，计数严格递增，文件名取实际完成的图片。最终 `images` 仍保持输入顺序。
- 解码或进度回调失败时停止派发并清理线程；清理等待有 10 秒上限。Python 发布器继续使用临时目录，失败保留已有公开版。Python 服务仍同时处理一个整篇发布任务。
- `cdp.js` 的浏览器 profile 使用进程号、线程号与随机标识，避免并发启动碰撞。
- 同步旧的浏览器面板断言：已有公开版体积须与完整目录实测字节数一致，未压缩数据量显示为上限参考。

## 本机验收

环境：Windows、Intel Core i9-13900K（32 个逻辑处理器）、Python 3.12.7、Node.js 24.14.0、Chrome 154.0.8037.98、Hugo 0.160.1 extended。

| 检查 | 结果 |
| --- | --- |
| `node scripts/test-texture-pool.js` | PASS；覆盖串行/并行 RGB、Alpha、浮点 PNG 与元数据一致性，线程上限，参数校验，逐张进度，损坏输入与回调异常；完成后进程自然退出 |
| `python -X utf8 -m unittest discover -s scripts/tests` | 46 项全部通过，67.429 秒；包含真实 BC6H/BC7/EXR、浏览器通道、重复发布、HTTP 逐张进度和 Windows 超时/无效输出的子进程清理 |
| `node scripts/test-publish-local.js` | 两种场景通过：首次发布与已有公开版 |
| Node 语法检查 | 转换器、工作线程、CDP 助手和线程池测试通过 |
| Hugo production 构建 | 成功，223 页；输出至 `.tmp-localcheck/parallel-conversion-build-20261007/` |
| `git diff --check` | 通过 |
| IDE 检查 | 未提供 Rider/JetBrains IDE 连接工具；使用 Node 语法检查与实际运行验证 |

实测文章为 `content/local/Endfield/Lighting_d3d11_frameunknown_gpt-6/` 的 26 张 DDS，原尺寸、相同 sidecar。先运行修改前保存的串行转换器，再运行最终并行转换器，两次转换未与其他测试同时执行。

| 指标 | 串行 | 4 线程 |
| --- | ---: | ---: |
| 转换耗时 | 104.250 秒 | 38.407 秒 |
| PNG（含 Alpha） | 35 个 | 35 个 |
| PNG 总字节数 | 44,862,911 | 44,862,911 |

该次测量加速 2.714 倍，耗时减少约 63%。35 个 PNG 的 SHA-256 与全部图片元数据完全一致。26 张源图的完成事件均为 1..26，每个来源只出现一次；返回结果按原输入顺序。测试前后对真实 local 与已有 posts 目录逐文件计算 hash，均未变化。测试结束后无本次 CDP profile 对应的浏览器主进程。

计时只包含贴图转换，不包含文章收集、目录替换、Hugo 刷新或打开页面。不同文章和机器的速度取决于图片数量、格式、分辨率与负载；自动化正确性测试记录计时，不使用固定加速倍数作为通过条件。

详细输入、参数、逐张事件、PNG hash、元数据与输出在 `.tmp-localcheck/parallel-conversion-20261007/`：`serial.evidence.json`、`parallel.evidence.json`、对应 manifest、stdout JSONL 和 stderr 日志。`benchmark.py compare` 校验完整结果一致性。所有转换输出位于该临时目录。

## 最终代码标识

Git HEAD 为 `82fbfc7115f4b59f729e73605de6b92aa7d91b28`；以下包含未提交修改的文件 hash 才是本次验证版本。

| 文件 | SHA-256 |
| --- | --- |
| `scripts/cdp/export_texture_png.js` | `85eedc681da861d1e55bd872ddf63f7ad743b7f52de1c1e29bcde3295ff4e037` |
| `scripts/cdp/texture_worker.js` | `47621f670a98cc34bbd8e33f939ace281c76235ebec77337f79084d8b45b0149` |
| `scripts/cdp/cdp.js` | `c77fcc93eb1cd7e35c6f7b6469b30d58e74f5e29f3d16ee301b2084d0095cf75` |
| `scripts/cdp/publish_viewer_check.js` | `b837793c0e3de22c0f931629edd82bdd51b688865c4886253acf47bba35f0b62` |
| `scripts/test-texture-pool.js` | `6b363a88a9429851c0f5d8e5fbec1656d28f1d1c1f89ea2e986030fcd21ec6a6` |
| `scripts/tests/test_publish_local_post.py` | `00115f7bf569883d44a220bc62b94fdabec11aefaacc07d593867660399f85f0` |
| `scripts/tests/test_local_publish_server.py` | `51504f33a7f6ed368103a4a5f3c42d7755a6a0e4985895cecdf54c06dd754ccd` |
| `scripts/tests/test_texture_timeout.py` | `1ed58eae7e1dca2aa8fedce3f5b3b7fc4cb75408927ebb056b5b7ab49344601a` |

并行基准中的转换器 hash 与上述最终版本相同。没有提交、推送或替换真实文章目录；下一次发布会启动当前转换器，无需重启预览服务。

## DSH 协作

使用 dsh-orchestration 技能委派转换器与相关测试实现，根会话负责验收与真实文章基准。DSH session 为 `422392ac-9ca6-47a0-b652-5db7723e6853`，run 为 `dsh-run-muxlnan9-5`。执行预算为最多 3 回合 / 20 分钟；实际执行 1 回合，约 12 分钟，未继续派发；桥未提供 token 用量。

DSH 自身环境无法启动 Chrome，其原始报告标为历史版本，保存在临时目录的 `dsh-report.md`。根会话在本机补齐浏览器验证，并修复空清单参数校验与进度回调异常的清理；没有修改权限策略。会话已交接并关闭，工具返回 `closed=true, released=true`。
