# DDS/EXR 编解码器怎么验收

本文记录 2026-09-29 修复时实际使用的方法。具体改动、结果和源码哈希见 [验收记录](codec-repair-checkpoint.md)。本文关注如何得出结论，以及每种证据能说明什么。

## 先确定期望值从哪里来

实现者写的测试也可能错。期望值优先来自格式规则、手工构造的已知输入或独立解码器；旧版本用于比较行为变化，不能自动当成正确答案。

这次 EXR 修复中，执行者曾把 RGB=1 的显示期望写成 255，再加入逐像素归一化让测试通过。独立验收保留了原有逐分量 Reinhard + gamma 规则：RGB 的 1、0.5、0.25 应映射为 186、155、123，而 alpha 的 1、0.5 应映射为 255、128。这组不同亮度的输入拦住了“测试全绿，但图像明暗被改变”的回归。

实用做法：在修改实现前写下输入、预期输出和依据；遇到失败时，同时检查实现与测试，不能只调整实现去迎合断言。

## 分层检查，避免一层通过代表全部通过

| 层次 | 观测什么 | 本次实例 | 不能单独证明什么 |
|---|---|---|---|
| 字节和像素算法 | 精确通道值、插值、alpha | BC1 透明索引、BC2 显式 alpha、BC4/5 SNORM | 文件头、Worker、UI 正确 |
| 容器解析 | 尺寸、偏移、mip/array 边界、拒绝行为 | EXR offset table；截断 DX10 文件 | 显示结果正确 |
| 帧接口 | pixels、rawPixels、尺寸和范围属于同一帧 | mip0→mip1；数组切片；抽样输出 | 页面正确消费这些字段 |
| 实际 Worker | 消息能否结算，错误后能否继续处理 | 错误 DDS 后再解码合法 EXR | 所有浏览器和线程调度情况 |
| 浏览器 UI | 用户操作后的像素与 DOM 尺寸 | 调范围、切 mip、滚动触发缓存命中 | 所有 CSS、布局和交互 |
| GPU 路径 | 上传、shader、FBO、readPixels 输出 | BC7 逐像素对照、BC6H 正负 HDR | 所有物理显卡驱动的兼容性 |
| 真实素材与构建 | 兼容性变化、加载链、部署产物 | DDS/EXR 素材扫描、Hugo 构建 | 每张素材都已逐像素核对 |

## 用很小的合成文件触发特定分支

合成夹具直接写文件字节，不调用被测编码/解析函数生成期望结果。让一个夹具尽量只回答一个问题，失败后能立即缩小范围。

- **BC1–3**：设置透明索引、全零 alpha、颜色端点反序，检验透明度是否被覆盖，以及 BC2/3 是否错误进入 BC1 的三色模式。
- **BC4/5**：遍历 3-bit 索引，包含跨字节边界的位置；R/G 使用不同索引，避免两个通道都错却相互掩盖。
- **BC6H**：构造 mode 11 的常量块，分别产生 +65504 和 -65504；必须断言 `rawPixels`，因为只看 RGBA8 已无法知道是否提前裁剪。
- **EXR**：让扫描行 y 恰好等于某个 chunk 的文件偏移，诱发“把 offset table 当扫描行”的错误；再加入负 dataWindow、物理乱序 chunk、缺 alpha、额外通道及截断块。
- **DDS 帧切换**：mip0 使用 0.1/0.9，mip1 使用 0.5。切到 mip1 后调整显示范围，断言输出像素，验证 UI 没继续用 mip0 的原始值和归一化范围。
- **非法输入**：验证返回失败、错误原因和有限时间内结束；不能只断言“没有抛异常”，更不能把黑图或紫图视为成功解码。

## 用独立解码器比较实际像素

BC7 对照采用 Python `texture2ddecoder`，被测路径采用浏览器 WebGL。比较前统一通道顺序：本次参考输出按 BGRA→RGBA 交换 R/B；宽高、mip、切片和颜色空间含义也必须一致。

逐字节比较 `max(abs(actual-reference))`，本次允许最大误差 1，实测为 0。容差应先确定，不能看到失败后不断放宽。

上下翻转是本次最典型的漏检点：RGB 最小值、最大值、均值完全可能不变。旧输出与正常参考的最大误差为 250，与上下翻转后的参考比较却为 0，由此定位额外的行翻转。修正后正常参考误差为 0。翻转参考用于诊断，最终通过标准始终是正常方向的参考。

同理，不能仅凭“readPixels 是从底部开始读”就决定翻转；还要核对上传数据与 shader 纹理坐标形成的完整映射。这次 shader 已使纹理第 0 行对应回读第 0 行。

## 测状态变化和故障后的恢复

浏览器验收启动本地 HTTP 服务，加载实际脚本，通过 CDP 操作页面并读取结果。它不依赖截图是否“看起来正常”。

Worker 检查包括：合法请求、损坏文件失败、紧接着的合法请求恢复，以及构造器抛错、Worker 脚本加载后抛错、Worker 收到消息但永不响应。最后一种走真实超时，不通过缩短生产超时参数来获得通过。

缓存检查先显示大图，再滚动让相同 URL 的第二张图进入视口；比较两次 canvas 尺寸，并确认都使用实际抽样尺寸。只看缓存 Map 中有没有记录，发现不了“像素是缩小的、尺寸仍是原图”的问题。

主线程与 Worker 输出相等，是检查两条入口一致性的证据；如果它们共用同一个错误算法，也会一起错，因此仍需要上面的独立像素期望。

## 用真实素材发现兼容性边界

真实 DDS 扫描比较新旧版本能否解析，EXR 额外比较完整原始 Float32 像素字节。DDS 的“221 张通过”指容器解析通过，不能写成“221 张像素逐一正确”。

本次 223 张 DDS 中有 2 张各缺少 20 字节。它们声明 DX10 BGRA8，所需大小应为 `148 + width × height × 4`；旧 Worker 回退到 128，实际把扩展头当成像素。新版本明确拒绝。原来的严格差分脚本因此仍返回退出码 1，这两个差异要逐个记录原因，而不是为了全绿恢复错误回退。

EXR 的新旧像素一致只能证明没有改变这些样本的原始数据，不能证明旧版本本来就没有错。合成 offset 碰撞等夹具负责检验旧素材没触发的分支。

## SwiftShader 验证的边界

本次日志报告的 renderer 是 ANGLE/Vulkan SwiftShader，BPTC 和浮点 framebuffer 扩展可用。测试确实经过 WebGL API、shader、FBO 和读回流程；实际运算由软件渲染器执行。

它适合可重复的功能与像素验证，不能代表 NVIDIA、AMD、Intel 物理显卡驱动，也不能据此评价硬件性能。测试报告必须同时写浏览器版本、renderer 和所需扩展，不能只写“GPU 测试通过”。

当前 [CDP 助手](../scripts/cdp/cdp.js) 固定带 `--disable-gpu` 和 `--enable-unsafe-swiftshader`。设置 `CHROME_PATH` 只会换浏览器程序，不会把测试变成硬件验证。以后补硬件验收时，需要明确的硬件启动配置，并以实际 renderer 确认没有回退；再复跑同一套像素断言。仅删除启动参数还不算完成验证。

## 可复用入口与命令

独立验收脚本已从临时目录保存到 [scripts/codec-tests](../scripts/codec-tests/)。目录层级保持一致，三个脚本仍通过自身位置定位仓库根。旧修复日志继续保留在被 Git 忽略的 `.tmp-localcheck/codec-repair/` 中；新克隆不会自动带上这些历史日志或本地素材。

在仓库根执行以下 PowerShell 命令。基础测试只需要 Node；浏览器测试还需要 Chrome/Edge（可用 `CHROME_PATH` 指定）。本次实际环境为 Node 24.14.0、Chrome 154、Python 3.12、Hugo 0.160.1 extended。

```powershell
$codecTests = @(
  'scripts/test-dds-codec.js',
  'scripts/test-exr-codec.js',
  'scripts/test-codec-worker.js',
  'scripts/test-export-texture.js',
  'scripts/codec-tests/acceptance.js'
)
foreach ($codecTest in $codecTests) {
  node $codecTest
  if ($LASTEXITCODE -ne 0) { throw "测试失败：$codecTest" }
}
```

不使用外部素材，运行浏览器合成夹具、Worker、mip 和缓存检查：

```powershell
Remove-Item Env:CODEC_GPU_FILE -ErrorAction SilentlyContinue
node scripts/codec-tests/browser-acceptance.js
if ($LASTEXITCODE -ne 0) { throw '浏览器验收失败' }
```

增加真实 BC7 逐像素对照：本机 Python 需能 `import texture2ddecoder`，并具备指定的 DX10 BC7 素材。下面使用本次 Snow 样本；也可换成自己的完整 BC7 文件。

```powershell
$env:CODEC_GPU_FILE = (Resolve-Path 'content/local/Endfield/Snow_d3d11_frame2274_deepseek-v4.1-flash/images/ResourceId-7281_SnowHeightGradientMap.dds').Path
try {
  node scripts/codec-tests/browser-acceptance.js
  if ($LASTEXITCODE -ne 0) { throw 'BC7/浏览器验收失败' }
} finally {
  Remove-Item Env:CODEC_GPU_FILE -ErrorAction SilentlyContinue
}
```

真实素材比较需要 `content/local/` 数据集及 Git 中的历史基线 `a67d136959ccbe6c188e0a6cabf2e7e2c88f632a`。EXR 会读取并比较大块浮点数据，耗时和内存高于合成测试。

```powershell
node scripts/codec-tests/corpus-acceptance.js
# 本次数据集预期报告两个已审查的损坏 DDS，退出码 1；逐项检查 JSON。
node scripts/codec-tests/corpus-acceptance.js --exr
```

补充构建与已有 GPU 统计检查：

```powershell
hugo --destination .tmp-localcheck/codec-repair/site
python scripts/test-dds-decoder.py
```

后者是通道统计检查，不能替代逐像素方向检查。它仅在素材 SHA-256 与内置 golden 相符，或显式传入期望 JSON 时作相应判定；无匹配期望时只打印结果。期望值不能因为文件大小相同就套给另一张图。

## 让证据可以追溯

每次结果至少保留：实际命令与退出码、Git revision、未提交源码的 SHA-256、输入 SHA-256、mip/slice/抽样参数、采样阶段、容差，以及运行环境。区分压缩数据、原始浮点、归一化 RGBA8 和 canvas 显示像素，不能在不同阶段之间直接比较。

源码变化后，旧结果只能作为历史证据。记录哈希时还应说明取的是工作区文件字节；不同换行符会改变文件哈希。

自动执行结束不等于验收成功。此次曾遇到 shell 包装把实际失败显示为退出码 0，因此 PowerShell 应在每条关键命令后立即检查 `$LASTEXITCODE`；不仅看最后一条命令，也不只搜索输出中的 PASS。

执行者负责修复与自测，验收者保留独立期望、审查测试本身，并检查实际失败日志。最终结论应写清通过项、已解释的行为变化和未覆盖环境，而不是用测试数量替代覆盖范围。
