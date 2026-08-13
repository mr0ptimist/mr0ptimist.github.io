+++
date = '2026-04-22T10:00:00+08:00'
draft = false
title = '纹理压缩格式详解：ASTC、BC、ETC 与 PVRTC'
tags = ['GPU', '移动端', '性能']
categories = ['图形渲染']
+++

## 概述

纹理压缩（Texture Compression）是实时渲染中降低显存占用和带宽消耗的核心技术。与通用图像压缩（如 PNG、JPEG）不同，硬件纹理压缩格式支持**随机访问**——GPU 无需解压整幅图像即可直接读取单个 texel，这对纹理缓存和着色器采样至关重要。

本文系统梳理主流硬件纹理压缩格式的技术细节、适用场景及硬件支持情况，所有关键数据均来自官方文档与公开规范。

## BC 系列（Block Compression）

BC 系列是 DirectX 生态中最主流的压缩格式，由 S3TC（DXT）发展而来，后续经 RGTC、BPTC 扩展为今日形态。所有 BC 格式均以固定 **4×4 texel 块**为单位进行编码。

### BC1（原 DXT1 / S3TC）

- **数据量**：64 bits / 4×4 block（**4 bpp**）
- **结构**：两个 16-bit RGB565 端点色 + 16 个 2-bit 索引
- **色板**：4 色（两个端点 + 两个插值色）
- **Alpha**：无独立 alpha，仅支持 1-bit "镂空"（punch-through）透明
- **支持通道**：RGB（无独立 Alpha）
- **典型用途**：不透明漫反射贴图、简单遮罩

据 [Khronos Data Format Specification](https://registry.khronos.org/DataFormat/specs/1.3/dataformat.1.3.html) 描述，BC1 的 1-bit alpha 行为由两个端点值的相对大小决定：

- **`color0 > color1`（按无符号整数比较）**：4 色不透明模式，`00/01/10/11` 均为插值颜色，无透明
- **`color0 <= color1`**：**3 色 + 透明模式**，`11` 表示完全透明像素（alpha = 0）

#### 实际使用方式

**编码端**：向压缩器提供带 Alpha 的源图（如 PNG with 1-bit alpha），DirectXTex 的 BC1 编码器会按 block 自动判断是否需要透明模式（块内存在 alpha 低于阈值 0.5 的像素即采用 color0 <= color1 的三色+透明模式，全部不透明则用四色模式）；而 nvcompress 需显式加 -bc1a（DXT1a）才启用 1-bit alpha（普通 -bc1 会丢弃 alpha、纯 0/255 源也输出不透明块），Compressonator 需显式开启 bDXT1UseAlpha 并设置 nAlphaThreshold（默认关闭）。

**API/格式**：Direct3D 与 Vulkan 对 BC1 的 alpha 处理并不统一：Direct3D 用单一 DXGI_FORMAT_BC1_UNORM（或 _SRGB/_TYPELESS）覆盖有/无 1-bit alpha 两种情形（是否含 alpha 由块编码决定）；而 Vulkan 在 API 层面显式区分无 alpha 的 VK_FORMAT_BC1_RGB_UNORM_BLOCK/_SRGB_BLOCK（"has no alpha and is considered opaque"）与带 1-bit alpha 的 VK_FORMAT_BC1_RGBA_UNORM_BLOCK/_SRGB_BLOCK（"provides 1 bit of alpha"），两者并非同一格式枚举。

**Shader 端**：BC1 的 1-bit alpha 只能用于 **Alpha Test / Alpha Cutout**，不能做平滑混合。在 HLSL/GLSL 中需显式 `clip(alpha - 0.5)` 或设置管线 Alpha Test。若直接用于 Alpha Blend，透明边缘会出现锯齿与排序瑕疵。

**注意事项**：透明模式下 block 只有 3 个有效颜色（+ 1 个透明），比不透明模式的 4 色少一个插值色，因此带镂空的 BC1 贴图在颜色丰富区域的质量会略低于纯不透明贴图。

### BC3（原 DXT5 / S3TC）

- **数据量**：128 bits / block（**8 bpp**）
- **结构**：前半 64 bits 存储独立 alpha；后半 64 bits 与 BC1 相同（RGB）
- **Alpha 编码**：两个 8-bit alpha 端点 + 16 个 3-bit 索引（最多 8 级插值）
- **支持通道**：RGBA
- **典型用途**：需要平滑透明度的漫反射贴图

### BC4（RGTC1）

- **数据量**：64 bits / 4×4 block（**4 bpp**）
- **结构**：单个通道（R），两个 8-bit 端点 + 16 个 3-bit 索引
- **支持通道**：R（无符号 `DXGI_FORMAT_BC4_UNORM` 或有符号 `DXGI_FORMAT_BC4_SNORM`）
- **典型用途**：单通道数据（如高度图、粗糙度、金属度、AO）

据 [Khronos Data Format Specification](https://registry.khronos.org/DataFormat/specs/1.3/dataformat.1.3.html) 描述，BC4 是 RGTC（Red-Green Texture Compression）规范中的单通道部分，BC5 则是其双通道扩展。

### BC5（RGTC2）

- **数据量**：128 bits / block（**8 bpp**）
- **结构**：等效于**两个 BC4 块**拼接——一个存储 Red 通道，一个存储 Green 通道
- **通道编码**：每通道两个 8-bit 端点 + 16 个 3-bit 索引
- **支持通道**：RG（双通道独立）
- **典型用途**：法线贴图（R 存 X，G 存 Y，Shader 中重建 Z）、双通道遮罩

据 [NVIDIA《Real-Time Normal Map DXT Compression》论文](https://developer.download.nvidia.com/whitepapers/2008/real-time-normal-map-dxt-compression.pdf) 与 [Microsoft Direct3D 11 Textures and Block Compression 博客](https://walbourn.github.io/direct3d-11-textures-and-block-compression/) 描述，BC5（3Dc）在所有 DirectX 10 兼容硬件上是切线空间法线贴图质量最优的格式，并专为法线贴图等双通道数据设计，是带宽与质量的最佳折中之一。注：DirectXTex Wiki 的 Compress 页面本身并未给出此评价。

### BC6H（BPTC HDR）

- **数据量**：128 bits / 4×4 block（**8 bpp**）
- **结构**：14 种模式（mode 0–13）；前 10 种模式为双区域（2 个子集），带 5-bit 分区索引（共 32 种分区），后 4 种模式为单区域
- **端点精度**：依模式不同，RGB 端点以固定位宽的量化整数编码（如 10.555、16.4 等，分别表示基准端点精度位数与 delta 偏移位数，如 16.4 即 16 位基准端点 + 4 位 delta），解码时反量化为 16-bit 并按半浮点（half）重新解释；多数模式使用 delta 变换压缩第二个端点
- **支持通道**：RGB（无 alpha，解码时 alpha 恒为 1.0）
- **特点**：专为 HDR 数据设计（源数据为 16:16:16 半浮点）；支持浮点 denormal，但不支持 INF/NaN（有符号模式可解码出 -INF，但仅是格式产物，编码器通常不利用）
- **硬件要求**：DirectX 11 Feature Level 11_0 及以上
- **典型用途**：HDR 天空盒、光照贴图、环境贴图

据 [Microsoft BC6H Format 文档](https://learn.microsoft.com/en-us/windows/win32/direct3d11/bc6h-format) 描述，BC6H 编码器遇到 INF/NaN 输入时应转换为最大可表示的非 INF 值，并将 NaN 映射为 0；BC6H 解码必须先解压再滤波，且硬件解码结果必须与规范描述逐位一致（bit-accurate）。与 BC7 不同，BC6H 没有 3 子集分区模式。Vulkan 侧对应 `VK_FORMAT_BC6H_UFLOAT_BLOCK` 与 `VK_FORMAT_BC6H_SFLOAT_BLOCK`。

### BC7（BPTC）

- **数据量**：128 bits / block（**8 bpp**）
- **结构**：8 种模式（mode 0–7），支持每 block 最多 **3 个子集（subset）**
- **端点精度**：依模式不同，RGB 端点精度可达 4–8 bit/通道，alpha 可独立或共享
- **支持通道**：RGBA（模式决定 Alpha 是否独立）
- **特点**：同 8 bpp 下质量显著优于 BC3，尤其适合平滑渐变与精细细节
- **硬件要求**：DirectX 11 Feature Level 11_0 及以上
- **典型用途**：高品质漫反射、法线、任何 BC3 出现色带的场景

BC7 的 8 种模式在 [Khronos Data Format Specification](https://registry.khronos.org/DataFormat/specs/1.3/dataformat.1.3.html) 中有完整位域定义。微软亦在 DirectXTex 中提供了 CPU 与 GPU 压缩实现，其中 BC6H/BC7 的软件编码计算开销较大。

### BC 格式对比

| 格式 | 原名 | bpp | 支持通道 | Alpha | 最佳用途 |
|------|------|-----|----------|-------|----------|
| BC1 | DXT1 | 4 | RGB | 1-bit 镂空 | 不透明/镂空漫反射 |
| BC3 | DXT5 | 8 | RGBA | 8-bit 插值 | 透明漫反射 |
| BC4 | RGTC1 | 4 | R | 无 | 单通道数据（高度、粗糙度等）|
| BC5 | RGTC2 | 8 | RG | 无 | 法线贴图、RG 遮罩 |
| BC6H | BPTC | 8 | RGB | 无 | HDR 贴图（天空盒、光照贴图）|
| BC7 | BPTC | 8 | RGBA | 模式可变 | 高品质 RGBA |

## ETC 系列（Ericsson Texture Compression）

ETC 是 OpenGL ES 3.0 **强制要求支持**的标准压缩格式，由 Ericsson 贡献给 Khronos，旨在解决 ES 2.0 时代各厂商格式互不兼容的碎片化问题。

### ETC1

- **数据量**：64 bits / 4×4 block（**4 bpp**）
- **结构**：两种子块模式——独立模式（两个 RGB444 基色）或差分模式（一个 RGB555 基色 + RGB333 有符号差值）；每个子块由 3 位码字从 8 个亮度修改表中选择一张，每个像素 2 位索引从表中取 4 个偏移值之一
- **兼容性**：ETC2 解码器可完全向后兼容 ETC1
- **局限**：不支持 alpha 通道
- **典型用途**：早期 Android 不透明贴图

### ETC2

- **数据量**：64 bits / 4×4 block（**4 bpp**，RGBA 需配合 EAC 达 8 bpp）
- **向后兼容**：ETC2 解码器可直接解压 ETC1 数据
- **新增模式**：利用 ETC1 位流中原本"非法"的编码组合，引入三种新模式：
  - **T-mode**：衍生 4 色，适合复杂色块
  - **H-mode**：另一套 4 色衍生方式
  - **Planar mode**：三基色（C0、CH、CV，均为 RGB676 精度）+ 线性滤波，适合平滑渐变

据 [Khronos Data Format Specification](https://registry.khronos.org/DataFormat/specs/1.3/dataformat.1.3.html) 描述，ETC2 的 Planar mode 在渐变区域的质量提升尤为明显。

### EAC（Ericsson Alpha Compression）

EAC 是单通道压缩格式，常与 ETC2 组合使用：

| 格式 | 内部枚举名 | bpp | 说明 |
|------|-----------|-----|------|
| EAC R11 | `GL_COMPRESSED_R11_EAC` | 4 | 无符号单通道 |
| EAC RG11 | `GL_COMPRESSED_RG11_EAC` | 8 | 无符号双通道 |

ETC2 RGBA8（`GL_COMPRESSED_RGBA8_ETC2_EAC`）即 ETC2 RGB + EAC Alpha，总 **8 bpp**。

### ETC 格式要点

- **OpenGL ES 3.0+**：强制支持
- **Vulkan / OpenGL 4.3+**：ETC 在 OpenGL 4.3+ 为强制核心支持，在 Vulkan 中为核心可选特性（由可选特性 textureCompressionETC2 控制，需查询启用，非强制）；仅支持 2D 纹理与 2D 数组（及 cube map 数组），不支持 3D 纹理
- **局限**：仅支持 2D 纹理与 2D 数组（及 cube map 数组），**不支持 3D 纹理**

## PVRTC 系列（PowerVR Texture Compression）

PVRTC 由 Imagination Technologies 开发，是 PowerVR GPU 的原生格式，最大特点是**非块化插值**算法，在极低码率下仍能保持相对平滑的渐变。

### 核心技术

与 BC、ETC、ASTC 等块化格式不同，PVRTC 的解码流程如下：

1. 存储两幅低频颜色图像 **Image A** 与 **Image B**，每个 4×4（4bpp 时）或 8×4（2bpp 时）像素区域共享一个颜色值，相邻 data-word 间做双线性插值上采样至全分辨率
2. 使用全分辨率、低精度的 **调制信号 M**（4bpp 时每像素 2 位，2bpp 时每像素 1 位）逐像素混合两幅上采样图像

这种设计避免了块边界处的明显不连续，但代价是解压时需引用相邻块数据，硬件实现复杂度更高。

### 格式变体

| 格式 | bpp | 支持颜色 | 关键限制 |
|------|-----|----------|----------|
| PVRTC1 4bpp | 4 | RGB/RGBA | 需各维度为 2 的幂次（不必正方形） |
| PVRTC1 2bpp | 2 | RGB/RGBA | 同上，质量更低 |
| PVRTC2 4bpp | 4 | RGB/RGBA | 支持 NPOT、纹理图集 |
| PVRTC2 2bpp | 2 | RGB/RGBA | 同上 |

据 [Imagination PVRTC 文档](https://docs.imgtec.com/tools-manuals/pvrtextool-manual/html/index.html)（PVRTC 专题见 [PVRTC 指南](https://docs.imgtec.com/performance-guides/graphics-recommendations/html/topics/pvrtc/texture-compression-using-pvrtc.html)）描述，PVRTC2 引入了硬过渡标志（Hard Transition Flag）、非插值模式（Non-interpolated mode）和局部调色板模式（Local Palette Mode），显著改善了锐利边缘与特定纹理类型的质量。

### 硬件与生态

- **主要平台**：iOS 设备（自 iPhone 3GS 起所有 iOS 设备均硬件支持，A8 引入 ASTC 之前的世代——含 A7——是唯一主流压缩格式）与部分 Android PowerVR GPU（SGX530/540，如 Galaxy S、Nexus S 等）
- **加载枚举**（OpenGL ES 扩展 `GL_IMG_texture_compression_pvrtc`）：
  - `GL_COMPRESSED_RGB_PVRTC_4BPPV1_IMG`
  - `GL_COMPRESSED_RGBA_PVRTC_4BPPV1_IMG`
  - 对应 2bpp 变体
- **工具**：Imagination 官方提供 [PVRTexTool](https://docs.imgtec.com/tools-manuals/pvrtextool-manual/html/topics/introduction.html)（产品页：https://developer.imaginationtech.com/solutions/pvrtextool/ ），支持编码至 PVRTC、ASTC、ETC、BC 等格式

## ASTC（Adaptive Scalable Texture Compression）

ASTC 由 **Arm 与 AMD** 联合开发，2012 年被 Khronos 采纳为 OpenGL、OpenGL ES 的官方扩展，并在 Vulkan（2016 年起）中作为可选标准特性提供支持，是目前**灵活性最高**的硬件纹理压缩标准。

### 核心特性

- **固定块大小**：每 block 固定 **128 bits（16 bytes）**
- **可变 footprints**：128 bits 可表示不同数量的 texel，实现 **0.89 bpp ~ 8 bpp** 的连续码率调节

据 [Arm ASTC Compression Formats 文档](https://developer.arm.com/documentation/102162/latest) 提供的官方数据，2D 常用块尺寸与码率对应关系如下：

| Block 尺寸 | bpp | Block 尺寸 | bpp |
|-----------|-----|-----------|-----|
| 4×4 | 8.00 | 8×5 | 3.20 |
| 5×4 | 6.40 | 8×6 | 2.67 |
| 5×5 | 5.12 | 8×8 | 2.00 |
| 6×5 | 4.27 | 10×5 | 2.56 |
| 6×6 | 3.56 | 10×6 | 2.13 |
|  |  | 10×8 | 1.60 |
|  |  | 10×10 | 1.28 |
|  |  | 12×10 | 1.07 |
|  |  | 12×12 | **0.89** |

ASTC 亦支持 3D 纹理，码率范围为 **0.59 bpp（6×6×6）~ 4.74 bpp（3×3×3）**。

### Profile 与 API 支持

ASTC 分为 LDR Profile（GL_KHR_texture_compression_astc_ldr，Vulkan 可选核心特性 textureCompressionASTC_LDR，支持 2D 及 sRGB）、HDR Profile（GL_KHR_texture_compression_astc_hdr，Vulkan 1.3 核心可选，原 VK_EXT_texture_compression_astc_hdr，在 LDR 基础上增加 HDR 与 slice-based 3D）、LDR+Sliced 3D（GL_KHR_texture_compression_astc_sliced_3d，在 LDR profile 上增加 slice-based 3D）以及 Full Profile（GL_OES_texture_compression_astc，含 2D + 体积 3D + LDR/sRGB/HDR）。注：sRGB 能力属于 LDR Profile，并非 OES 专属。

| Profile | 支持特性 | OpenGL ES | Vulkan |
|---------|---------|-----------|--------|
| LDR Profile | 2D LDR 纹理（含 sRGB） | `GL_KHR_texture_compression_astc_ldr` | 可选核心特性 `textureCompressionASTC_LDR` |
| HDR Profile | LDR + HDR 纹理 + slice-based 3D | `GL_KHR_texture_compression_astc_hdr` | Vulkan 1.3 核心可选（原 `VK_EXT_texture_compression_astc_hdr`） |
| LDR + Sliced 3D | LDR + slice-based 3D 纹理 | `GL_KHR_texture_compression_astc_sliced_3d` | 可选核心特性（需 LDR 特性支持） |
| Full Profile | 2D + 体积 3D + LDR/sRGB/HDR | `GL_OES_texture_compression_astc` | 可选核心特性（需 LDR 特性支持） |

### 颜色与通道灵活性

- **通道数**：支持 1–4 通道（L、LA、RGB、RGBA）
- **非相关通道**：RGB 与 Alpha 可在 block 级别动态选择是否相关编码，非常适合带遮罩的贴图与法线贴图
- **颜色空间**：LDR Linear、LDR sRGB（RGB 解码时应用 gamma，Alpha 保持线性）、HDR
- **法线贴图推荐**：使用 `rrrg`（Luminance+Alpha endpoint）编码两通道（X、Y），Shader 中重建 Z

### 解码模式与性能

ASTC 规范默认解码为每通道 16-bit RGBA，但现代 GPU 普遍支持**解码模式扩展**，允许应用选择更低精度中间值：

- **RGBA8**：用于 LDR 纹理，提升纹理缓存效率
- **RGB9E5**：用于 HDR 纹理

据 [Arm Mali GPU Texture Compression 文档](https://developer.arm.com/documentation/102162/latest) 描述，使用低精度解码模式可在全精度非必需时改善 GPU 纹理吞吐。

### 官方工具：astcenc

Arm 提供开源参考编解码器 [**astcenc**](https://github.com/ARM-software/astc-encoder)，特性包括：

- **输入**：BMP、JPEG、PNG、TGA（LDR）；EXR、HDR（HDR）
- **输出**：KTX 容器或裸 `.astc` 文件
- **质量预设**：`exhaustive`、`verythorough`、`thorough`、`medium`、`fast`、`fastest`
- **SIMD 优化**：SSE2、SSE4.1、AVX2（x86-64）、NEON（Arm）

`.astc` 裸文件格式含 16-byte 头：Magic（`0x5CA1AB13`）、blockdimX/Y/Z、24-bit 维度（xsize/ysize/zsize），随后紧跟原始 128-bit ASTC block。

## 格式选择速查

| 场景 | 推荐格式 | 理由 |
|------|---------|------|
| PC/主机不透明漫反射 | BC7 / BC1 | BC7 质量最高；BC1 最小 |
| PC/主机透明漫反射 | BC7 / BC3 | BC7 无 banding；BC3 兼容更广 |
| PC/主机法线 | BC5 / BC7 | BC5 带宽最优；BC7 质量最高 |
| PC/主机 HDR 贴图（天空盒/光照） | BC6H | HDR 半浮点数据专用格式 |
| Android 通用（GLES 3.0+）| ETC2 | 强制支持，无兼容性风险 |
| Android 高品质/法线 | ASTC 4×4~6×6 | 灵活码率，质量显著优于 ETC2 |
| iOS（现代 A8+）| ASTC | 硬件支持，取代 PVRTC |
| iOS（旧设备 A7 及之前）| PVRTC1 | PVRTC1（2bpp/4bpp）原生支持；自 A7 起另支持 ETC2；PVRTC2 虽硬件可支持但被 Apple 在 iOS 上禁用 |
| 移动端统一 | ASTC 4×4/6×6 | iOS A8+、Android Mali/Adreno 主流硬件支持 |

## 参考

### 官方文档与规范

- [Khronos Data Format Specification](https://registry.khronos.org/DataFormat/specs/1.3/dataformat.1.3.html) — BC1–BC7、ETC2、EAC、ASTC 的位域级规范定义
- [Arm ASTC Compression Formats](https://developer.arm.com/documentation/102162/latest) — ASTC 技术细节与 Mali GPU 纹理压缩指南
- [Microsoft DirectXTex Compress Wiki](https://github.com/microsoft/DirectXTex/wiki/Compress) — BC 格式压缩 API 与实现说明
- [Microsoft BC6H Format](https://learn.microsoft.com/en-us/windows/win32/direct3d11/bc6h-format) — BC6H 格式结构、14 种模式与解码说明
- [Arm ASTC Encoder (astcenc) GitHub](https://github.com/ARM-software/astc-encoder) — 开源编解码器源码与格式文档
- [Imagination PVRTC 文档](https://docs.imgtec.com/tools-manuals/pvrtextool-manual/html/index.html)（PVRTC 专题见 [PVRTC 指南](https://docs.imgtec.com/performance-guides/graphics-recommendations/html/topics/pvrtc/texture-compression-using-pvrtc.html)） — PVRTC 算法原理与编码说明
- [Imagination PVRTexTool](https://docs.imgtec.com/tools-manuals/pvrtextool-manual/html/topics/introduction.html)（产品页：https://developer.imaginationtech.com/solutions/pvrtextool/ ） — 官方纹理压缩工具
- [NVIDIA ASTC Texture Compression for Game Assets](https://developer.nvidia.com/astc-texture-compression-for-game-assets) — ASTC 在游戏资源中的应用建议

> **📋 事实核查**：本文于 2026-08-13 经 exa 多源核查，共 81 条陈述（✅ 77 正确 / ❌ 4 有误 / ❓ 0 存疑，已修正 4 处）。
