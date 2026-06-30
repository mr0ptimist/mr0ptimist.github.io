+++
date = '2026-04-20T10:04:00+08:00'
draft = false
title = '移动端 GPU 可见性剔除机制对比'
tags = ['移动端', 'GPU', '剔除', 'TBDR']
categories = ['图形渲染']
+++

## 1.1 概览

| | PowerVR HSR | Apple HSR | Mali FPK | Adreno LRZ |
|---|---|---|---|---|
| 全称 | Hidden Surface Removal | Hidden Surface Removal | Forward Pixel Kill | Low Resolution Z |
| 架构 | TBDR | TBDR | TBDR | TBDR |
| 粒度 | 逐像素 | 逐像素 | 逐像素（尽力而为） | 逐块（8x8 像素） |
| 保证级 | 不透明物体保证零过度绘制 | 不透明物体保证零过度绘制 | 非保证，尽力剔除 | 非保证，块级粗剔除 |
| 绘制顺序依赖 | 不透明物体顺序无关 | 不透明物体顺序无关 | 正面到背面更优 | Binning pass 构建后顺序无关，但正面到背面可提升 Early-Z 效率 |
| AlphaTest | 失效 | 失效 | 失效 | 失效 |
| Alpha Blend | 失效 | 失效 | 失效 | 失效 |
| gl_FragDepth 写入 | 失效 | 失效 | 失效 | 失效 |

---

## 1.2 PowerVR HSR (Imagination)

### 1.2.1 原理
TBDR 架构中，所有几何体先提交到 Tile，HSR 在 PS 执行前对整个 Tile 做可见性解析，只对最终可见像素跑 PS。

### 1.2.2 特性
- 不透明物体绘制顺序不影响 HSR 效率，overdraw 始终约 1x
- 不需要 Z-prepass，HSR 等效于免费的深度预处理
- AlphaTest / discard 会推迟深度写入、迫使 HSR 二次执行，削弱 TBDR 效率（深度测试仍可提前做，但该像素最终是否被 discard 无法提前判定）
- 写入 gl_FragDepth 会干扰 HSR（读取 gl_FragCoord.z 本身不影响）

### 1.2.3 最佳实践
- 不需要排序不透明物体
- 尽量减少 discard / alphaTest
- 透明物体仍需从后到前排序
- 使用 PVRTune 分析 HSR 效率

### 1.2.4 适用设备
- iPhone 5s ~ iPhone 7（A7~A10，PowerVR G6430/GX6450/GT7600 系列）
- 部分联发科芯片（早期 PowerVR 授权）

### 1.2.5 官方文档
- [Imagination PowerVR Architecture - Hidden Surface Removal](https://docs.imgtec.com/starter-guides/powervr-architecture/html/topics/hidden-surface-removal-efficiency.html)
- [Sorting Objects on PowerVR Hardware (Imagination Blog)](https://blog.imaginationtech.com/sorting-objects-and-geometry-on-powervr-hardware/)
- [Do Not Use Discard (PowerVR 文档)](https://docs.imgtec.com/starter-guides/powervr-architecture/html/topics/rules/do-not-use-discard.html)

---

## 1.3 Apple GPU HSR (Apple A11+)

### 1.3.1 原理
Apple 自研 GPU（A11 起）采用 TBDR 架构，内置 **Hidden Surface Removal (HSR)**。所有几何体先提交到 Tile，HSR 在 PS 执行前对整个 Tile 做可见性解析，只对最终可见像素跑 PS。A7 为 PowerVR G6430 授权设计；A8~A10 为 Apple 基于 PowerVR 架构（GX6450 / GT7600）的定制 GPU（自研 shader core，保留部分 PowerVR 固定功能硬件），HSR 来自 PowerVR 实现；A11 起为 Apple 完全自研 GPU，保留 TBDR+HSR 架构。

### 1.3.2 特性
- 不透明物体绘制顺序不影响 HSR 效率，overdraw 始终约 1x
- 不需要 Z-prepass，HSR 等效于免费的深度预处理
- AlphaTest / discard 会打断 HSR
- 与 PowerVR HSR 行为一致，A7~A10 基于 PowerVR 架构（A7 授权、A8~A10 定制），A11 起为 Apple 完全自研但保持相同架构

### 1.3.3 最佳实践
- 不需要排序不透明物体
- 尽量减少 discard / alphaTest
- 透明物体仍需从后到前排序

### 1.3.4 芯片支持明细

| GPU 系列 | 代表 SoC | HSR 支持 | 备注 |
|----------|---------|---------|------|
| A7 ~ A10 | iPhone 5s ~ iPhone 7 | 支持 | A7=PowerVR G6430 授权；A8~A10=Apple 定制（GX6450/GT7600，自研 shader core） |
| A11 Bionic | iPhone X / 8 | 支持 | Apple 首款自研 GPU |
| A12 Bionic | iPhone XS / XR | 支持 | Apple 自研 |
| A13 Bionic | iPhone 11 | 支持 | Apple 自研 |
| A14 Bionic | iPhone 12 | 支持 | Apple 自研 |
| A15 Bionic | iPhone 13 | 支持 | Apple 自研 |
| A16 Bionic | iPhone 14 Pro | 支持 | Apple 自研 |
| A17 Pro | iPhone 15 Pro | 支持 | Apple 自研 |
| M1 | iPad Pro / Mac | 支持 | Apple 自研 |
| M2 | iPad Pro / Mac | 支持 | Apple 自研 |
| M3 | Mac | 支持 | Apple 自研 |
| M4 | iPad Pro / Mac | 支持 | Apple 自研 |

**总结：A7~A10 基于 PowerVR 架构（A7 授权、A8~A10 定制），HSR 来自 PowerVR 实现。A11 起 Apple 完全自研 GPU，独立实现 TBDR+HSR 架构，全系列支持 HSR。**

### 1.3.5 官方文档
- [Apple Metal Best Practices Guide](https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/MTLBestPracticesGuide/index.html)
- [Harness Apple GPUs with Metal (WWDC 2020)](https://developer.apple.com/videos/play/wwdc2020/10602/)
- [Apple Metal](https://developer.apple.com/metal/)

---

## 1.4 Mali FPK (ARM)

### 1.4.1 原理
Forward Pixel Kill 允许后提交的不透明片元"杀死"先提交的被遮挡片元，在 PS 执行前丢弃。

### 1.4.2 特性
- 不是保证级的，极端情况下仍可能有过度绘制
- 后画的物体可以杀死先画的被遮挡片元
- 配合 Early Z 一起工作
- 能力弱于 PowerVR HSR

### 1.4.3 最佳实践
- 不透明物体正面到背面排序仍有帮助
- 避免 discard / alphaTest
- 透明物体从后到前排序
- 可用 Pixel Local Storage 实现近似 OIT

### 1.4.4 适用设备
- 三星 Exynos 全系
- 联发科天玑系列（Mali GPU）
- 部分国产芯片

### 1.4.5 芯片支持明细

| GPU 系列 | 代表 SoC | FPK 支持 |
|----------|---------|---------|
| Mali-T6xx/T7xx/T8xx (Midgard) | Exynos 5/7, Kirin 920/930 | 支持（Midgard 架构引入 FPK，T860/T880 增强 FPK） |
| Mali-G71 (Bifrost) | Kirin 960 | 支持 |
| Mali-G72 | Exynos 9810 | 支持 |
| Mali-G76 | Kirin 980 | 支持 |
| Mali-G57 | Dimensity 800 | 支持 |
| Mali-G77 | Exynos 990 / Dimensity 1000 | 支持 |
| Mali-G78 | Kirin 9000 | 支持 |
| Mali-G610 | Dimensity 8100 | 支持 |
| Mali-G710 | Dimensity 9000 | 支持 |
| Immortalis-G715 | Dimensity 9200 | 支持 |
| Immortalis-G720 | Dimensity 9300 | 支持 |

**总结：FPK 在 Midgard 第 2 代（Mali-T62X/T678）起引入（T604/T624 无），T860/T880 增强。Bifrost (G71+) 及 Valhall 架构完整支持并持续优化。**

### 1.4.6 官方文档
- [Arm GPU Best Practices Developer Guide](https://developer.arm.com/documentation/101897/latest/)
- [Mali Forward Pixel Kill (FPK Patent US9619929B2)](https://patents.google.com/patent/US9619929)
- [The Mali GPU: An Abstract Machine (Arm 官方博客)](https://developer.arm.com/community/arm-community-blogs/b/mobile-graphics-and-gaming-blog/posts/the-mali-gpu-an-abstract-machine-part-2---tile-based-rendering)

---

## 1.5 Adreno LRZ (Qualcomm)

### 1.5.1 原理
维护一个低分辨率深度缓冲（每 4×4 或 8×8 像素块存储一个深度采样），在 binning pass 中构建每块深度值，rendering pass 中据此做早期剔除。官方描述为 **"draw order independent depth rejection"**（绘制顺序无关的深度剔除）。

### 1.5.2 特性
- 粒度为 4×4 或 8×8 像素块，每块存储一个 Z16_UNORM 深度采样，无法精确到像素
- **绘制顺序无关**：LRZ 值在 binning pass 由所有几何体构建，rendering pass 中基于预构建的值剔除，不依赖绘制顺序
- 正面到背面排序仍可提升 Early-Z 效率（Early-Z 是 LRZ 之外的补充机制）
- 深度写入方向不能中途切换（如从 LESS 切到 GREATER），否则 LRZ 失效
- 深度写入必须开启，深度比较函数需为 LESS/LESS_EQUAL 或 GREATER/GREATER_EQUAL（EQUAL/NEVER 无方向会临时禁用 LRZ，ALWAYS/NOT_EQUAL 视是否写深度而临时或完全禁用）
- A650+ (SD 865+) 支持 GPU 端方向追踪和跨 renderpass 复用 LRZ
- A7XX 引入双向 LRZ（双 LRZ 缓冲），方向切换时无需禁用 LRZ；该行为默认关闭，需驱动显式开启

### 1.5.3 最佳实践
- 不透明物体正面到背面排序可提升 Early-Z 效率（LRZ 本身绘制顺序无关）
- 严重过度绘制场景加 depth pre-pass，可提升 20-40% 性能
- 避免 discard / alphaTest / gl_FragDepth 写入（会临时禁用 LRZ）
- 避免 fragment shader 中写入 SSBO / image（会强制 Late-Z，与 LRZ 不兼容）
- Vulkan 下利用 VkRenderPass load/store 帮助驱动判断 LRZ 使用时机

### 1.5.4 适用设备
- 高通骁龙（Adreno GPU），国产安卓手机最大份额 GPU

### 1.5.5 芯片支持明细

| GPU 系列 | 代表 SoC | LRZ 支持 |
|----------|---------|---------|
| Adreno 4xx 及更早 | SD 801/805 等 | 不支持 |
| Adreno 5xx | SD 820/821/835 等 | 部分支持（实验性，有硬件限制） |
| Adreno 612 | SD 675 | 完整支持 |
| Adreno 615/616 | SD 670/710 | 完整支持 |
| Adreno 618 | SD 730/730G | 完整支持 |
| Adreno 619 | SD 750G | 完整支持 |
| Adreno 620 | SD 765/765G | 完整支持 |
| Adreno 630 | SD 845 | 完整支持 |
| Adreno 640 | SD 855/855+ | 完整支持 |
| Adreno 650 | SD 865/865+ | 完整支持 |
| Adreno 660 | SD 888 | 完整支持 |
| Adreno 642 | SD 780G | 完整支持 |
| Adreno 642L | SD 778G/778G+ | 完整支持 |
| Adreno 730 | SD 8 Gen 1 | 完整支持 |
| Adreno 740 | SD 8 Gen 2 | 完整支持 |
| Adreno 750 | SD 8 Gen 3 | 完整支持 |

**总结：Adreno 6xx 及以后完整支持，Adreno 5xx 部分支持，更早不支持。**

### 1.5.6 官方文档
- [Qualcomm Developer](https://www.qualcomm.com/developer)
- [Low-resolution-Z on Adreno GPUs (Danylo Piliaiev, Igalia)](https://blogs.igalia.com/dpiliaiev/adreno-lrz/)
- [Low Resolution Z Buffer (Mesa Freedreno 文档)](https://docs.mesa3d.org/drivers/freedreno/hw/lrz.html)
- [LRZ Buffer Support on Turnip (Samuel Iglesias, Igalia)](https://blogs.igalia.com/siglesias/2021/04/19/low-resolution-z-buffer-support-on-turnip/)
- [Low Resolution Buffer Based Pixel Culling (Qualcomm Patent US20120280998)](https://patents.google.com/patent/US20120280998)

---

## 1.6 针对石头+地表场景的建议

### 1.6.1 场景描述
管线顺序：PBR → 石头 → 草 → 地表
问题：石头屏占比高、PS 复杂、大量在地表之下被遮挡

### 1.6.2 各硬件下方案

| 硬件 | 地表后画能否自动剔除石头 | 推荐方案 |
|---|---|---|
| PowerVR | 能，HSR 自动处理 | 不改顺序也行，但 AlphaTest 地表除外 |
| Mali | 部分能，FPK 尽力剔除 | 建议调顺序，地表先画 |
| Adreno | 部分能，LRZ 在 binning pass 构建深度后可做块级剔除，但粒度为 8x8 不精确 | 建议调顺序，地表先画以配合 Early-Z |

### 1.6.3 通用方案（全平台有效）

```
方案1: 调渲染顺序
  地表 → PBR → 石头 → 草
  最简单，深度测试自然挡住地下石头

方案2: 地表 Z-prepass
  地表 Z-prepass（ColorMask 0）→ PBR → 石头 → 草 → 地表正式绘制
  适合不想改最终绘制顺序的场景

方案3: 石头 depth prepass
  石头 Z-prepass → 石头正式绘制 → ...
  解决石头自身遮挡，但不解决地表遮挡石头的问题
```

### 1.6.4 注意事项
- 地表如果是 AlphaTest，HSR/FPK/LRZ 全部失效，必须依赖排序或 prepass
- Z-prepass 不会导致 Z-fight（同一 VS 输出深度一致）
- 正式绘制用 ZTest LEqual（默认），不会被自己的 prepass 深度剔除
- 双 Pass 方案顶点处理翻倍，draw call 翻倍

---

## 1.7 Early-Z（传统 IMR GPU 基线）

### 1.7.1 原理
GPU 固定管线中，深度测试发生在 PS 之前（称为 Early-Z）。如果片元被已有深度值遮挡，直接丢弃，不执行 PS。

### 1.7.2 特性
- 顺序强依赖：只有先画的更近物体写入深度后，后画的更远物体才能被剔除
- 背面到正面（远→近）绘制时，远物体先画时深度缓冲尚未建立遮挡信息，无法被 Early-Z 剔除，后被近物覆盖的 PS 工作被浪费，overdraw 接近最坏情况
- 不是保证级，以下情况 GPU 会将深度测试推迟到 PS 之后（Late-Z）：
  - PS 中使用 discard / clip / alphaTest
  - PS 中写入 gl_FragDepth / SV_Depth
  - PS 中采样深度贴图（depth texture，读取 gl_FragCoord.z 本身不影响）
- Early-Z 是 PC 桌面 GPU（NVIDIA / AMD IMR 架构）和移动 Mali / Adreno 等 TBR GPU 的基础能力；PowerVR 移动 GPU 则以 HSR 替代 Early-Z，可见性剔除不依赖绘制顺序

### 1.7.3 最佳实践
- 不透明物体正面到背面排序
- 严重过度绘制场景加 Z-prepass
- 避免 PS 中 discard / 深度写入 / 深度读取
- 透明物体放最后，从后到前画

---

## 1.8 全方案对比

| | Early-Z (IMR) | PowerVR HSR | Apple HSR | Mali FPK | Adreno LRZ |
|---|---|---|---|---|---|
| 架构 | IMR（立即模式） | TBDR | TBDR | TBDR | TBDR |
| 剔除粒度 | 逐像素 | 逐像素 | 逐像素 | 逐像素（尽力） | 逐块（8x8 像素） |
| 保证级 | 不保证（可退化为 Late-Z） | 不透明保证零 overdraw | 不透明保证零 overdraw | 尽力剔除 | 尽力剔除 |
| 顺序依赖 | 强：必须正面到背面 | 无：不透明顺序无关 | 无：不透明顺序无关 | 弱：正面到背面更优 | 弱：LRZ 绘制顺序无关，正面到背面可提升 Early-Z |
| back-to-front 时 | PS 全跑，零剔除 | 不透明仍零 overdraw | 不透明仍零 overdraw | 部分剔除 | LRZ 仍可剔除（binning pass 已构建深度） |
| AlphaTest | 退化为 Late-Z | HSR 失效 | HSR 失效 | FPK 失效 | LRZ 失效 |
| Alpha Blend | 不适用（需混合） | 不适用 | 不适用 | 不适用 | 不适用 |
| gl_FragDepth | 退化为 Late-Z | HSR 失效 | HSR 失效 | FPK 失效 | LRZ 失效 |
| 需要 Z-prepass | 常需要 | 不需要 | 不需要 | 视场景 | 建议加 |
| 额外开销 | 无 | HSR 硬件单元 | HSR 硬件单元 | FPK 硬件单元 | LRZ 额外显存+带宽 |
| 典型平台 | PC 桌面 GPU / 所有 GPU 基线 | iPhone 5s~7（A7~A10 PowerVR） | iPhone 8+ / iPad / Mac（A11+ Apple 自研） | Exynos / 天玑 / 麒麟 | 骁龙全系 |

### 1.8.1 关键差异解读

1. **Early-Z 是所有人的基线**：HSR/FPK/LRZ 都是在 Early-Z 基础上的增强，不是替代。当这些增强机制失效时，退回到 Early-Z 行为。

2. **顺序依赖是核心区别**：
   - Early-Z：石头先画地表后画 → 石头 PS 白跑（深度缓冲还没有地表深度）
   - LRZ：binning pass 中已构建所有几何体的低精度深度 → 即使石头先画，LRZ 仍可在 rendering pass 中剔除被遮挡片元（但粒度为 8x8 块级）
   - HSR（PowerVR / Apple）：同一 Tile 内所有几何体先收集完再解析可见性 → 石头 PS 不白跑（像素级精确）
   - FPK：介于两者之间，后画的更近片元可以杀死先排队的片元

3. **AlphaTest 是共同弱点**：所有方案遇到 discard 都失效，因为 GPU 无法在不执行 PS 的情况下知道片元是否存活。

---

## 1.9 为什么移动端 GPU 对顶点敏感（TBDR 顶点开销放大）

### 1.9.1 问题
直觉上片元数量远大于顶点数量（一个三角形可覆盖上千像素），片元开销应主导帧时间。这在桌面 IMR GPU 上成立，但在移动端 TBDR GPU 上恰好相反——**渲染负载对顶点 / 几何极度敏感**，减顶点的收益常常大于减片元。

### 1.9.2 根因一：片元侧被 HSR + 片上 Tile Memory 摊薄到接近零
- TBDR 把整个 Tile 的 color/depth/stencil 放在片上 SRAM（Mali Tile Memory / Adreno GMEM），深度测试与混合都在片上完成，**无外部带宽**。
- HSR / FPK / LRZ 在 PS 执行前剔除被遮挡片元，不透明物体 overdraw ≈ 1x，**只有最终可见像素才跑 PS**。
- 因此“片元 >> 顶点”里多出来的那部分片元，绝大多数在着色前就被免费杀掉。**片元数量 ≠ 着色开销**。

### 1.9.3 根因二：顶点侧不仅没被摊薄，反而被架构放大
1. **Binning pass 必须跑全部顶点**：TBDR 是两阶段——先 binning（tiling），再 rendering。binning 前必须对**每个 draw call 的所有顶点**跑顶点着色（至少算位置）才能确定三角形落在哪些 Tile 里，这一步发生在任何片元着色之前，且**与最终可见性无关**（被遮挡的三角形也要先 binning）。
2. **几何被反复遍历**：tiler 需跨 Tile 反复考虑几何，Tile 数越多（屏幕越大）相对开销越高。移动 GPU 资料明确指出几何开销在 tiler 中”被放大”，因为 “need to consider polygons repeatedly”，且 “tiled renderers see a higher geometry load on larger screen sizes”。
3. **顶点输出必须往返主存**：顶点 → 片元交接处，per-vertex varying 与 tiler 中间状态必须**写出到主存再读回**。移动端带宽是最主要的性能 / 功耗因素，而 “vertex load is directly correlated to memory bandwidth”。

4. **顶点输入也走主存 + DrawCall 的 CPU 开销**：顶点属性（vertex fetch）通常不能完全命中片上缓存，大量顶点意味着更多主存读取；叠加 DrawCall 过多带来的 CPU 提交 / driver overhead（CPU 频繁向 GPU 提交命令缓冲区），进一步压榨带宽与帧时间。

### 1.9.4 量化：顶点负载 → 带宽（Mali 实例）
ARM / Khronos 给出的算例（Mali 中间几何缓冲约 180MB）：
- 64 bytes varying/vertex × 200 万顶点 ≈ 180MB 中间存储
- 写出 + 读回 = 2 × 180 = 360MB / render pass
- 30 FPS → 360 × 30 = **10.8 GB/s** 带宽
- 结论：顶点数直接换算成带宽，单 render pass 顶点数建议控制在 ~200 万以内，超限需拆分 render pass。

### 1.9.5 Binning pass 的额外约束
- binning pass 只需顶点位置，部分硬件用**精简的位置 only 顶点着色器**；建议把 position 单独拆 buffer，让几何引擎只读位置以减带宽。
- binning pass 有**几何预算上限**，超限会 spill 或被迫拆分 render pass。PowerVR 称该中间存储为 Parameter Buffer (PB)，溢出时进入 smart parameter mode (SPM) 或 flush render；ARM 称 varying storage（Mali 约 180MB 上限），超出触发 DEVICE_LOST。
- binning 与上一帧 rasterizing 流水化重叠才能保持 GPU 占用；顶点着色器依赖上一帧输出会引入 bubble；VSYNC 限帧 + 首个 surface 几何过重也会让并发 binning 失效。
- TBR 对 **geometry / tessellation shader 低效**，应尽量避免。

### 1.9.6 结论
| | 桌面 IMR | 移动 TBDR |
|---|---|---|
| 片元着色 | 每个生成片元都着色，overdraw 贵 | HSR + 片上内存摊薄，overdraw ≈ 1x，接近免费 |
| 顶点开销 | 一次过（靠大带宽 + 大缓存吸收，顶点仍走 VRAM，非全片上） | binning 全跑 + 反复遍历 + varying 往返主存，被放大 |
| 主导瓶颈 | 常为片元 / 填充率 | 常为顶点 / 几何 / 带宽 |

所以“片元远多于顶点”在移动端是个**伪命题**——被遮挡片元着色前就被免费剔除，而每个提交的顶点都要真实付出 binning ALU + 位置取数 + varying 往返带宽的代价。**减顶点的边际收益远大于减片元**，这正是移动端高度重视 LOD、顶点数控制、合并 mesh 的根本原因。

### 1.9.7 实践推论

1. **PreZ / Z-prepass 在移动端默认避免**：PreZ 是额外的顶点 pass，会双倍 DrawCall、双倍顶点着色、双倍带宽。ARM 官方《Mali Best Practices》§3.5 明确 "Avoid using depth prepasses"——FPK / HSR / LRZ 已自动消除大部分 overdraw，PreZ 的代价通常大于收益。**仅当 PS / overdraw 是瓶颈且片元着色很重时** PreZ 才可能净收益（存在 cutoff）；若 VS / 顶点 / DrawCall 已是瓶颈，PreZ 必然加剧（联发科工程师反馈同此结论）。新硬件（Immortalis-G925 / Mali-G725）已用硬件 Fragment Prepass 替代软件 PreZ。这与 Adreno "高深度复杂度场景加 depth pre-pass 可提升 20-40%" 不矛盾——后者前提是 PS / overdraw 瓶颈。

2. **MSAA 在 TBDR 上接近免费**：MSAA 样本留在片上 tile buffer 内 resolve，不落 DRAM。ARM 官方称 4x MSAA "No penalty"，Android Developers 称 "nearly free"。前提是 MSAA 数据不落盘（tile memory 内 resolve）；若强制 store multisampled texture 到 DRAM 则仍有代价。

3. **顶点预算与 LOD 刚需**：移动 GPU 顶点算力远弱于桌面——A11 GPU 约 409 GFLOPS，同期 GTX 1080 约 8873 GFLOPS（约 22 倍差距），叠加移动端带宽（~34 GB/s vs 桌面 ~320 GB/s）与功耗（~8W vs 180W）硬约束。LOD 是移动端 3D 游戏的准入门槛而非可选项（案例：仅 LOD 一项让三角面数降 ~57%）。旧版 Unity 5 手册曾建议"移动端单帧顶点不超过 10 万"，但该数字是 2015 年低端机型保守值，现行 Unity 6 手册已删除，改为定性建议。

### 1.9.8 参考文档
- [ARM Mali: An Abstract Machine Part 2 — Tile-Based Rendering](https://developer.arm.com/community/arm-community-blogs/b/mobile-graphics-and-gaming-blog/posts/the-mali-gpu-an-abstract-machine-part-2---tile-based-rendering)
- [Qualcomm Mobile HW and Bandwidth (SIGGRAPH 2015, Andrew Gruber)](https://developer.arm.com/cfs-file/__key/communityserver-blogs-components-weblogfiles/00-00-00-20-66/siggraph2015_2D00_mmg_2D00_andy_2D00_slides.pdf)
- [ARM Best Practices (SIGGRAPH 2016)](https://community.arm.com/cfs-file/__key/telligent-evolution-extensions-calendar-calendarfiles/00-00-00-00-05/2_2D00_mmg_2D00_siggraph2016_2D00_best_2D00_practice_2D00_andrew.pdf)
- [Khronos Vulkan Guide — Tile-Based Rendering Best Practices](https://github.com/KhronosGroup/Vulkan-Guide/blob/main/chapters/tile_based_rendering_best_practices.adoc)
- [Khronos Vulkan-Samples — Memory Limits（Mali 180MB / 10.8 GB/s 算例）](https://github.com/KhronosGroup/Vulkan-Samples/blob/main/docs/memory_limits.adoc)
- [Samsung — GPU Framebuffer Memory: Understanding Tiling](https://developer.samsung.com/galaxy-gamedev/resources/articles/gpu-framebuffer.html)
- [Meta — Mobile GPUs and Tiled Rendering](https://prod.developers.meta.com/horizon/documentation/native/android/gpu-tiled/)
- [Android Developers — Efficient Render Passes on Tile-Based Rendering Hardware](https://medium.com/androiddevelopers/efficient-render-passes-on-tile-based-rendering-hardware-621070158e40)
- [Arm GPU Best Practices §3.5 — Avoid depth prepasses](https://developer.arm.com/documentation/101897/latest/)
- [How a Triangle Travels — A Mobile GPU Itinerary](https://trywellbug.github.io/trywellbug/posts/how-a-triangle-travels-1.html)
- [Unity 5 — Optimizing Graphics Performance（旧版顶点预算建议）](https://docs.unity3d.com/500/Documentation/Manual/OptimizingGraphicsPerformance.html)
- [GameDevMind — Drawcall Optimization（LOD 案例）](https://github.com/gonglei007/GameDevMind/blob/main/cases/drawcall-optimization.md)
- [GPU 渲染管线和硬件架构浅谈（腾讯云）](https://cloud.tencent.com/developer/article/2016951)
- [移动 GPU 为何怕顶点和 DrawCall（Imgtec 社区）](https://imgtec.eetrend.com/blog/2026/100598621.html)

> **📋 事实核查**：本文于 2026-06-29 经 exa 多源核查（ARM / Khronos / Imagination / Qualcomm / Apple 官方文档 + Wikipedia / Notebookcheck 交叉验证），共 52 条主要技术陈述（✅ 27 正确 / ❌ 21 有误 / ❓ 4 存疑，已修正 21 处）。
