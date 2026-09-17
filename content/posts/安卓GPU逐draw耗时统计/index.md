+++
date = '2026-09-17T18:30:00+08:00'
draft = false
title = '安卓 GPU 逐 draw 耗时：为什么测不准，以及到底能测到什么粒度'
tags = ['Android', 'GPU', '性能', 'Adreno', 'Vulkan', 'TBDR', 'RenderDoc']
categories = ['图形渲染']
+++

## 引子：同一份抓帧，两台手机两个结果

同一个 Unity 手游包、同一套 RenderDoc 工具链、同样在设备端回放，逐 draw 的 GPU 耗时表现却是：

- 老机型（骁龙 865 / Adreno 650）：每个 draw 的耗时各不相同，能看出谁贵谁便宜
- 新机型（骁龙 8 Elite / Adreno 830）：**41 个 draw 全部是 1.198 µs**，最大值和最小值只差 13%

后者显然不是"这个游戏每个 draw 一样快"，因为那 41 个 draw 里有画全屏后处理的，也有画几十个三角形的。

顺着这条线查下去，最后得到的结论比"某台手机有问题"要大得多：**在 Adreno 上，「逐 draw 的 GPU 时间」这个粒度的数据，本来就不是一个能可靠拿到的东西**——而新一代硬件把它推到了彻底不可用的程度。

这篇文章把测量机制、规范依据、官方文档说明、以及我在真机上做的对照实验完整记录一遍。

---

## 逐 draw 耗时是怎么算出来的

### Vulkan：两次写时间戳相减

Vulkan 里测一段 GPU 工作的时间，标准做法是在这段命令前后各写一个时间戳，然后相减：

```cpp
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,    pool, i * 2 + 0);
// ... 被测的 draw ...
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, pool, i * 2 + 1);
```

读回来之后乘上设备的 `timestampPeriod`（每个 tick 多少纳秒）：

```cpp
duration_seconds = (ts_end - ts_start) * limits.timestampPeriod / 1e9;
```

RenderDoc 就是这么做的：它在回放时，对每一个 draw（或 dispatch）在前后各插一个时间戳，成对写入 query pool 的 `2i` / `2i+1` 槽位，事件浏览器里的 Duration 列就是这两个值的差。

### GLES：另一条链路

OpenGL ES 走的是 `GL_EXT_disjoint_timer_query`（`GL_TIME_ELAPSED_EXT`）。这条是驱动**通用扩展**，不需要厂商 SDK，所以 RenderDoc 在 GLES 路径上取耗时的门槛比 Vulkan 低。

而 Vulkan 上的**厂商硬件计数器**是另一回事：上游 RenderDoc 只为 AMD / Samsung（走 AMD GPA）和 NVIDIA（走 NvPerfKit）初始化硬件计数器，其余厂商一律落到：

```
"%s GPU detected - no counters available"
```

也就是说 **Qualcomm 的 Vulkan 路径上，Performance Counter 视图天然是空的**——但这不等于拿不到 `GPU Duration`，因为后者用的是时间戳，与厂商计数器无关。

### 一个前置结论

所以"逐 draw 耗时"这件事，最终完全押在两个时间戳上。**这两个时间戳准不准，就是一切。**

---

## 第一次撞墙：规范允许驱动"换个地方"打戳

`vkCmdWriteTimestamp` 的规范里有一句关键的话：

> Implementations may write the timestamp at any stage that is logically later than `stage`.

意思是：你指定 `TOP_OF_PIPE` 希望它在管线最前端打点，如果驱动做不到（或者不想做），**它可以合法地把这个点挪到后面任何一个阶段**。同一份规范还说明，"不能按指定阶段精确锁存"的实现是允许存在的。

如果驱动把一对 `TOP_OF_PIPE` / `BOTTOM_OF_PIPE` 都锁在了同一处，那么 `ts_end - ts_start` 就是 0。

另外，随着 `VK_KHR_synchronization2` 落地，`vkCmdWriteTimestamp` 已被标记为 legacy：

> This functionality is superseded by vkCmdWriteTimestamp2.

而在 synchronization2 里，`VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT` 和 `VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT` **被标记为 deprecated**。RenderDoc 1.43 用的正是 legacy 函数 + 这两个已废弃的 stage。

### 一个真实世界的同症状案例

RenderDoc issue #3230 记录过一模一样的现象：抓帧里所有 draw 的 duration 显示为 0（而不是"—"），维护者的结论是：

> the device itself is just broken - it does not report a valid timestamp period so durations can't be calculated ... so 0 ends up being displayed.

即 `timestampPeriod` 无效时，乘出来恒为 0。不过这个原因在本文讨论的机型上**不成立**——实测该机型 `timestampPeriod = 52.0833 ns`，`timestampValidBits = 48`，两个值都正常。

---

## 第二次撞墙：Adreno 的分桶与 FlexRender

### 官方文档直接说明了为什么不准

Qualcomm 现行的 Game Developer Guide（文档号 80-78185-2）在最佳实践里写得很直白：

> **Timer queries are calculated over the entire set of binned tiles when in binning mode.** For example, let's assume that we have 50 draw calls and a render target that requires 8 tiles to render. Let's also assume we want to measure draw call 10 and instrument it with timer queries.
>
> The entire command stream of 50 draws will be captured and run through the binning process to generate the visibility streams. During the rendering pass, the draw calls will be rendered according to the visibility stream of each tile. Even if the geometry for draw call 10 only contributes to one tile, it will incur a small overhead for each tile (while processing the visibility stream). **This overhead and the actual rendering time will be accumulated and presented in the resulting timer query.**
>
> The overhead mentioned above is small (**2-5µs**) but can add up if the draw call count is high and draws are present in many tiles.

也就是说：**在分桶（binning）模式下，逐 draw 的时间戳查询统计的是"整个 binned tile set"，而不是单个 draw**。一帧 50 个 draw、8 个 tile，你给第 10 个 draw 插查询，拿回来的是它在所有 tile 上的累计开销 + 渲染时间。

文档同时提到，从 A5x 起高通对可见性流做了优化（把不贡献该 tile 的尾部 draw 裁掉），但这个优化**会被"最后一个 draw 是全屏"这种情况抵消**。

### FlexRender：binning 还是 direct，是驱动选的

同系列文档还讲了一个容易被忽略的机制：

> **FlexRender** allows Adreno GPUs to switch between tile-based binned rendering and direct rendering to a frame buffer – since depending on workload, direct or binned rendering may provide superior performance. **The driver and GPU analyze the rendering parameters for a given render target and selects the mode automatically.**

> The driver heuristics that determine which mode are not exposed to the developer, but generally these scenarios trigger direct mode:
> - High ratio of texture samples in vertex shaders to vertices
> - Small number of vertices and/or draws
> - Use of tessellation or geometry shaders

关键点是：**选择权在驱动手里，开发者看不到也控制不了**。timer query 的行为又是和渲染模式绑定的。所以"同一个 app 在两台机器上耗时数据的可用性不同"，从机制上就是可能的——即使两边的 API、引擎、提交方式完全一样。

### Concurrent Binning：A7xx 开始 CP 有了并发

Adreno 的分桶和渲染原本由同一个命令处理器串行完成。从 A7xx 起，SQE 被拆成两个微控制器：**BV 负责 binning pass，BR 负责逐 tile 渲染**。两者读同一条命令流，BV 通常跑在 BR 前面——这就是 Concurrent Binning。

（这一代的文档里已经明确出现 "A740 devices and higher" 这样的表述，并提到 Adreno 750；结合站点页脚版权 © 2026，这份文档描述的就是当代架构，不是历史遗留说明。）

---

## 实测：在新一代 Adreno 上会塌成什么样

下面是我在一台骁龙 8 Elite（Adreno 830）设备上做的对照实验。探针是一个几百行的裸 Vulkan 程序，用 NDK 交叉编译后推到设备上直接跑，绕开所有工具链，只看驱动本身的行为。

### 实验一：换遍所有打点 stage，都一样

在同一个 render pass 内，每次迭代做**不同量的工作**（clear 面积逐次减半，4 档），每档前后各打一个时间戳。如果某个 stage 的打点能跟上工作量，它的 delta 应该随面积递减。

| stage | 1/1 | 1/2 | 1/4 | 1/8 |
|---|---|---|---|---|
| legacy `TOP/BOTTOM` | 1.198 | 1.198 | 1.250 | 1.198 |
| `ALL_COMMANDS` | 0.312 | 0.312 | 0.365 | 0.365 |
| `ALL_GRAPHICS` | 1.198 | 1.198 | 1.250 | 1.198 |
| `VERTEX_SHADER` | 1.198 | 1.198 | 1.198 | 1.198 |
| `FRAGMENT_SHADER` | 1.198 | 1.198 | 1.198 | 1.198 |
| `EARLY_FRAGMENT_TESTS` | 1.198 | 1.198 | 1.198 | 1.198 |
| `LATE_FRAGMENT_TESTS` | 1.198 | 1.250 | 1.198 | 1.198 |
| `COLOR_ATTACHMENT_OUTPUT` | 1.198 | 1.250 | 1.198 | 1.198 |
| `NONE` | 1.198 | 1.250 | 1.198 | 1.198 |

单位 µs。**九种打点方式全部恒定，工作量差 8 倍也不动。** 换成 `vkCmdWriteTimestamp2` + synchronization2 结果一样；把被测对象从 clear 换成真 draw（带 pipeline 的全屏三角形片元循环）结果一样；加一个直通几何着色器试图触发 direct 模式，结果还是一样。

`1.198 µs ÷ 52.0833 ns ≈ 23 ticks`——这个数字和"两条时间戳命令本身被命令处理器处理的开销"对得上，与 GPU 实际干了多少活无关。

### 实验二：把测量跨到 render pass 边界，就准了

同样的工作量，改成**每个 pass 只做一份活、时间戳打在 pass 边界上**：

```
工作量为 4096×{2048,1024,512,256} 的四次测量：
   858.18 µs  →  430.83 µs  →  219.69 µs  →  113.80 µs
     (1.99×)        (1.96×)        (1.93×)      ← 面积对半，耗时对半
```

用真 draw 再测一遍（片元着色器循环 16/64/256/1024 次，步长 4 倍）：

| 打点方式 | 16 | 64 | 256 | 1024 |
|---|---|---|---|---|
| 同一 pass 内逐 draw | 1.20 | 1.20 | 1.25 | 1.20 |
| **每 draw 一个 pass** | **1039.17** | **4050.00** | **16069.27** | **63946.51** |

后者比例是 3.90× / 3.97× / 3.98×（理论 4.00×）。**跨过 render pass 边界的时间戳是准确的，而且和真实工作量严格线性。**

### 实验三：真机抓帧也印证

把真实抓帧在设备端回放、取 `GPU Duration`：

```
frame: total actions=235  drawcalls=41
GPU Duration   min=1.19792 µs  max=1.30208 µs  distinct=3
PS Invocations min=0           max=3.52e6     distinct=22
Samples Passed min=0           max=1.41e7     distinct=26
```

41 个 draw，时间戳只有 3 个不同取值；而同一批 draw 的片元着色器调用次数和通过深度测试的采样数，**有 22 / 26 个不同取值**——它们才是真实反映每个 draw 工作量的数据。

---

## 为什么会有代际差异

老机型能测、新机型塌成常量，可以从这一代的硬件改动上找到解释：

### CP 并发更高，pass 内的打点更脱离实际

前面提到 A7xx 引入了 BV/BR 双核 CP。到了 A8x，Qualcomm 在补丁说明里写：

> A8x is the next generation in the Adreno family, featuring a **significant hardware design change**. A major update to the design is the introduction of **'Slice' architecture**... Also, in addition to the BV and BR pipe we saw in A7x, **CP has more concurrency with additional pipes**.

pass 内的时间戳本质上是**命令处理器侧**的锁存点。CP 跑得越靠前，这个点就越脱离 GPU 实际的执行进度。A8x 把它推到了极限：连 1024 次循环的片元工作量，测出来都是同一个 1.198 µs。

### 计数器路径为 slice 架构重写了

A8x 支持补丁里有一条很说明问题（2026-05）：

> **With the slice architecture, we need to flush the slice and unslice counters to perf RAM before reading counters.**

新增的 `a8xx_perfcntr_flush()` 要向 `REG_A8XX_RBBM_PERFCTR_FLUSH_HOST_CMD` 和 `REG_A8XX_RBBM_SLICE_PERFCTR_FLUSH_HOST_CMD` 各写一次，再轮询状态位（**带超时**）。计数器的聚合路径不再是"读一个寄存器"那么简单。

### 时间戳寄存器本身在 A8x 搬了家

`GMU_ALWAYS_ON_COUNTER` 在 A6xx/A7xx 上的偏移是 `0x1f888/0x1f889`，A8x 上是 `0x1f840/0x1f841`。而且上一代就踩过坑——A750 上：

> The `GMU_ALWAYS_ON_COUNTER` at offset `0x1f888` **doesn't seem to exist** on the SM8650 A750 GMU and **returns 0**, but the CX AO counter at offset `0x1f880` returns some proper timestamp data.

顺带一提，新代还引入了可写的 CX AO counter 来实现 `VK_KHR_calibrated_timestamps`：GPU 挂起/恢复时，内核会**往里写系统时间来"假装"计数器在走**。也就是说这条链路上多了一层"内核维护的偏移量"，而老一代的只读计数器没有这层。

> **诚实边界**：老机型上的同款探针我**没有实测过**，所以"老机型 CP 跑得不那么前"是推断，不是实测结论。要坐实需要把同一份探针在老机型上跑一遍对比。

---

## 那到底能拿到什么

把粒度摊开看：

| 想要的数据 | 在 Adreno（新一代）上 | 怎么做 |
|---|---|---|
| 帧 / pass 级 GPU 时间 | ✅ 准确 | 时间戳打在 render pass 边界前后 |
| 逐 draw GPU 时间 | ⚠️ 有条件 | 每个 draw 独占一个 render pass（见下） |
| 逐 draw 工作量 | ✅ 准确 | `PS Invocations` / `Samples Passed` 等 pipeline statistics |
| 逐 draw 厂商硬件计数器 | ❌ | 上游工具对 Qualcomm 不提供，见高通自家工具 |

### 逐 pass 是唯一零失真的粒度

这是本文所有实验支持的结论。**把测量点从"draw 前后"挪到"render pass 前后"，数据立刻变得可信**——代价是粒度变粗。

有意思的是，这恰好是 RenderDoc 上游明确拒绝做的事。issue #2659 有人提议把逐 draw 时间戳改成正反包围 render pass，理由是 TBDR 上 pass 内打点无意义，维护者的回复是：

> RenderDoc is not a profiler and there are no plans to change that in the foreseeable future, so new profiling-related features and improvements like this are effectively not in scope for the project.

所以这个改动只能在自己的 fork 里维护。

### 每个 draw 一个 pass = 逐 draw 时间

实验二已经证明：让每次测量跨一个 pass 边界，逐 draw 时间是准确的、线性的。落到工程上就是**在回放时把每个 draw 拆进自己的 render pass**。

代价我也量了：在上面那个 1024×1024 RGBA 的例子里，每次拆分的固定开销约 **39 µs**（额外的一次 tile store + load），并且**随 render target 尺寸增长**。所以这条路适合"哪个 draw 贵"的排序，不适合当绝对耗时用。

补充一个反过来的观察：**如果被测 app 本身就是"每个 pass 里只有一个 draw"**（移动端不少后处理、阴影 pass 是这样），那么"逐 pass 计时"和"逐 draw 计时"就是同一件事——上面的方案不用改一行代码就成立。

### 高通自家工具也是 pass 粒度

我原本以为 Snapdragon Profiler 会绕开这条路（它走的是驱动侧 profiler 层，和 Vulkan 时间戳无关）。实测一帧 164 个 draw call 的快照数据，`clocks` 这个指标**只有 5 个不同取值，其中 124 个 draw 共享同一个值**——正好对应 5 个 pass。

也就是说：**两条互相独立的工具链（RenderDoc 的时间戳路径、高通的 profiler 层路径）在同一台设备上，都止步于 pass 粒度。** 这基本可以确认它是硬件/驱动层面的性质，而不是某一方的实现缺陷。

### 退一步：逐 draw 的工作量计数是真的

如果目标从"哪个 draw 慢"放宽到"哪个 draw 重"，数据是现成且准确的：

```
PS Invocations     distinct=22  (41 个 draw)
Samples Passed     distinct=26
Input Vertices     distinct=14
```

这些是 `VK_QUERY_TYPE_PIPELINE_STATISTICS` 的结果，RenderDoc 已经给每个 draw 单独括了 begin/end query。把它们和准确的 pass 级时间按比例组合，可以得到一个合理的逐 draw 成本归属——**这是在不拆 pass 的前提下最接近"逐 draw 耗时"的东西**。

---

## 工具链现状与相关 issue

| 来源 | 内容 |
|---|---|
| RenderDoc #2659 | 提议按 render pass 计时，上游明确不做 profiling 增强 |
| RenderDoc #3230 | 设备不报有效 `timestampPeriod` 时，duration 显示为 0 而非空 |
| Vulkan-Samples #1320 | Android 15 loader 把若干函数变成硬要求；RenderDoc 严格按 `apiVersion` 推导 → 初始化失败。新版 Android + Vulkan 正在撞坏一批老假设 |

---

## 小结

1. **逐 draw GPU 时间的准确性，完全押在一对时间戳上。**
2. Vulkan 规范明确允许驱动**把打点位置挪到更晚的阶段**；synchronization2 之后 `TOP_OF_PIPE` / `BOTTOM_OF_PIPE` 已废弃，而主流工具仍在用。
3. Qualcomm 官方文档说明：**binning 模式下 timer query 统计的是整个 binned tile set**，逐 draw 查询拿回的是累计值加每 tile 2–5 µs 的开销。再叠加 FlexRender（binning / direct 由驱动按 render target 选择、不开放）和 Concurrent Binning（A7xx 起的 CP 并发），逐 draw 数据的可用性天然不稳定。
4. 在骁龙 8 Elite / Adreno 830 实测：**pass 内所有打点方式恒为 23 ticks**，与工作量无关；**pass 边界的时间戳准确且与工作量严格线性**。
5. 可用的替代路径：pass 粒度计时（零失真）、每 draw 一个 pass（逐 draw 但每次约 39 µs 开销）、逐 draw pipeline statistics（工作量真实）。

---

## 参考

### 官方文档与规范

- [Adreno GPU on Mobile: Best Practices — Qualcomm Game Developer Guide（文档号 80-78185-2）](https://docs.qualcomm.com/doc/80-78185-2/topic/mobile_best_practices.html) —— FlexRender、Concurrent Binning、timer query 与 binned tiles
- [Adreno GPU on PC: Best Practices — 同系列](https://docs.qualcomm.com/doc/80-78185-2/topic/pc_best_practices.html)
- [Snapdragon Profiler — Game Developer Guide](https://docs.qualcomm.com/bundle/publicresource/topics/80-78185-2/sdp.html)
- [vkCmdWriteTimestamp — Vulkan Reference Pages](https://docs.vulkan.org/refpages/latest/refpages/source/vkCmdWriteTimestamp.html) —— "Implementations may write the timestamp at any stage that is logically later than stage"
- [vkCmdWriteTimestamp2 — Vulkan Reference Pages](https://docs.vulkan.org/refpages/latest/refpages/source/vkCmdWriteTimestamp2.html)
- [VK_KHR_synchronization2 — TOP_OF_PIPE and BOTTOM_OF_PIPE deprecation](https://docs.vulkan.org/guide/latest/extensions/VK_KHR_synchronization2.html)
- [Timestamp queries — Vulkan Samples](https://docs.vulkan.org/samples/latest/samples/api/timestamp_queries/README.html)

### 内核与硬件代际

- [[PATCH v4 00/22] drm/msm/adreno: Introduce Adreno 8xx family support](https://lists.freedesktop.org/archives/freedreno/2025-November/042333.html) —— Slice 架构、"CP has more concurrency with additional pipes"
- [[PATCH v2 02/17] drm/msm/a8xx: Fix the ticks used in submit traces](https://lists.openwall.net/linux-kernel/2026/03/27/17) —— `GMU_ALWAYS_ON_COUNTER` 在 A8x 的偏移变化
- [[PATCH v2 2/2] drm/msm/a6xx: Use CX AO Counter register for timestamp on a750 GPUs](https://lists.openwall.net/linux-kernel/2026/09/09/1530) —— A750 上 `0x1f888` 返回 0
- [[PATCH v7 12/16] drm/msm/a8xx: Add perfcntr flush sequence](https://lkml.iu.edu/hypermail/linux/kernel/2605.2/03888.html) —— slice / unslice 计数器冲刷

### 工具链 issue

- [RenderDoc #2659 — Per-render-pass duration timing for TB(D)R](https://github.com/baldurk/renderdoc/issues/2659)
- [RenderDoc #3230 — Capture not displaying any durations](https://github.com/baldurk/renderdoc/issues/3230)
- [Vulkan-Samples #1320 — Vulkan 1.0 samples fail on Android 15 when using RenderDoc](https://github.com/KhronosGroup/Vulkan-Samples/issues/1320)

### 实验环境

文中所有实测数据来自：

- 设备：骁龙 8 Elite（Adreno 830，驱动 512.800，Android 16）；`timestampPeriod = 52.0833 ns`，`timestampValidBits = 48`
- 探针：自写裸 Vulkan 程序（NDK 交叉编译，设备上直接运行），分别覆盖 clear / 真 draw / 几何着色器三种负载，以及 legacy 与 synchronization2 两套打点 API
- 抓帧侧：设备端回放，读取 `GPU Duration` 与 pipeline statistics 计数器
