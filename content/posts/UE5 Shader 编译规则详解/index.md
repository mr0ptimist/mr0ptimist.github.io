+++
date = '2026-05-18T18:00:00+08:00'
draft = false
title = 'UE Shader 编译规则详解'
tags = ['UE', 'Shader', 'Permutation', 'PSO', 'VertexFactory', 'Material']
categories = ['图形渲染']
+++

## 概述

UE 的 Shader 不是"一份源码编译出一个二进制"，而是 **一份源码 × N 个排列组合 → 成千上万个二进制**。本文从源码出发，梳理 Shader 编译的完整规则：排列组合怎么产生、怎么过滤、怎么缓存、怎么在运行时选择。

---

## 编译粒度 — Material × VertexFactory × Pass × Platform

UE 编译 Shader 的最小单位是一个 **FShaderCompileJob**，由四个维度决定：

```
FShaderCompileJob = {
    ShaderType,          // 哪个 Shader（如 FBasePassPS, FDeferredLightPS）
    PermutationId,       // 哪个排列组合（0 ~ TotalPermutationCount-1）
    VertexFactoryType,   // 哪个顶点工厂（如 FLocalVertexFactory, FLandscapeVertexFactory）
    Platform             // 哪个平台（SF_VULKAN_SM5, SF_DX12, SF_ES3_1, ...）
}
```

材质触发编译时，会遍历所有可能的组合：

```
对于每个材质 M:
  对于每个 ShaderType (BasePassVS, BasePassPS, ShadowDepthPS, ...):
    对于每个 PermutationId [0, ShaderType::GetPermutationCount()):
      对于每个 VertexFactoryType (FLocalVF, FLandscapeVF, FGPUSkinVF, ...):
        如果三级过滤都通过:
          加入编译队列
```

**这就是组合爆炸的根源**。

---

## Shader 组合矩阵图解

编译的"组合爆炸"来自三个输入维度的笛卡尔积，经三级过滤压缩为实际 Job，每个 Job 输出一份独立字节码：

```
 Materials           ShaderType × Perms              VertexFactory
 ─────────           ──────────────────              ─────────────
 ┌─────────┐         ┌─────────────────────┐         ┌────────────┐
 │  Mat A  │         │ BasePassPS           │         │LandscapeVF │
 └─────────┘         │ Perm[0 .. N)         │         └────────────┘
 ┌─────────┐         └─────────────────────┘         ┌────────────┐
 │  Mat B  │   ×     ┌─────────────────────┐   ×     │  LocalVF   │
 └─────────┘         │ ShadowDepthPS        │         └────────────┘
 ┌─────────┐         │ Perm[0 .. M)         │         ┌────────────┐
 │  Mat C  │         └─────────────────────┘         │ GPUSkinVF  │
 └─────────┘         ┌─────────────────────┐         └────────────┘
    ...              │ DeferredLightPS      │            ...
                     │ Perm[0 .. K)         │
                     └─────────────────────┘
                        ...

           笛卡尔积 → 理论组合总数（数万至数百万级别）
                               │
              ┌────────────────┴────────────────┐
              │            三级过滤               │
              │  (1) ShaderType::               │
              │      ShouldCompilePermutation   │
              │  (2) VertexFactoryType::         │
              │      ShouldCache                │
              │  (3) ShaderPipelineType::        │
              │      ShouldCompilePermutation   │
              └────────────────┬────────────────┘
                               │ 大量无效组合被剪枝
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    FShaderCompileJob 队列                         │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       ┌──────────┐     │
│  │  Job 0   │ │  Job 1   │ │  Job 2   │  ...  │  Job N   │     │
│  │ Mat=A    │ │ Mat=A    │ │ Mat=B    │       │ Mat=C    │     │
│  │ BasePS   │ │ BasePS   │ │ ShadPS   │       │  ...     │     │
│  │ Perm=3   │ │ Perm=7   │ │ Perm=0   │       │ Perm=K   │     │
│  │ LscVF    │ │ LocVF    │ │ LocVF    │       │  ...     │     │
│  └──────────┘ └──────────┘ └──────────┘       └──────────┘     │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                 ┌───────────┴───────────┐
                 ▼                       ▼
      ┌──────────────────┐   ┌───────────────────────┐
      │    DDC 命中       │   │      DDC 未命中         │
      │  直接读缓存字节码  │   │  ShaderCompileWorker   │
      └────────┬─────────┘   │  并行编译               │
               │             └───────────┬─────────────┘
               └─────────────┬───────────┘
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│              编译产物（每个 Job → 一份独立字节码）                  │
│                                                                  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │
│  │ .bin │ │ .bin │ │ .bin │ │ .bin │ │ .bin │ │ .bin │  ...   │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘        │
└────────────────────────────┬─────────────────────────────────────┘
                             │  FShaderType::ConstructCompiled()
                             ▼
               ┌─────────────────────────────────┐
               │         FMaterialShaderMap        │
               │  key: (ShaderType, PermId, VF)    │
               │  val: FShader (字节码 + 参数布局)  │
               │  运行时 O(1) 查找                  │
               └─────────────────────────────────┘
```

每一行 `.bin` 对应一个独立的 `FShaderCompileJob` 编译结果；Materials / ShaderType+Perms / VertexFactory 三列方块代表三个正交维度，`×` 符号表示笛卡尔积展开。

---

## 排列组合系统 — TShaderPermutationDomain

### 维度类型

每个 Shader 声明自己的排列维度，定义在 `ShaderPermutation.h`：

| 类型 | 宏 | 值域 | 乘法因子 |
|------|-----|------|---------|
| 布尔 | `SHADER_PERMUTATION_BOOL("NAME")` | {false, true} | ×2 |
| 整数 | `SHADER_PERMUTATION_INT("NAME", N)` | {0, 1, ..., N-1} | ×N |
| 枚举 | `SHADER_PERMUTATION_ENUM_CLASS("NAME", E)` | {E::0, E::1, ..., E::MAX-1} | ×E::MAX |
| 稀疏整数 | `SHADER_PERMUTATION_SPARSE_INT("NAME", ...)` | 指定值集合 | ×count |

**总排列数 = 所有维度乘法因子的乘积**。

### 实例 — FDeferredLightPS

`LightRendering.cpp` 中 `FDeferredLightPS` 声明了 14 个维度：

```cpp
class FSourceShapeDim          : SHADER_PERMUTATION_ENUM_CLASS("LIGHT_SOURCE_SHAPE", ELightSourceShape);  // ×3
class FSourceTextureDim        : SHADER_PERMUTATION_BOOL("USE_SOURCE_TEXTURE");                            // ×2
class FIESProfileDim           : SHADER_PERMUTATION_BOOL("USE_IES_PROFILE");                               // ×2
class FLightFunctionAtlasDim   : SHADER_PERMUTATION_BOOL("USE_LIGHT_FUNCTION_ATLAS");                     // ×2
class FVisualizeCullingDim     : SHADER_PERMUTATION_BOOL("VISUALIZE_LIGHT_CULLING");                      // ×2
class FLightingChannelsDim     : SHADER_PERMUTATION_BOOL("USE_LIGHTING_CHANNELS");                        // ×2
class FTransmissionDim         : SHADER_PERMUTATION_BOOL("USE_TRANSMISSION");                             // ×2
class FHairLighting            : SHADER_PERMUTATION_INT("USE_HAIR_LIGHTING", 2);                          // ×2
class FHairComplexTransmittance: SHADER_PERMUTATION_BOOL("USE_HAIR_COMPLEX_TRANSMITTANCE");              // ×2
class FAtmosphereTransmittance : SHADER_PERMUTATION_BOOL("USE_ATMOSPHERE_TRANSMITTANCE");                // ×2
class FCloudTransmittance      : SHADER_PERMUTATION_BOOL("USE_CLOUD_TRANSMITTANCE");                      // ×2
class FAnistropicMaterials     : SHADER_PERMUTATION_BOOL("SUPPORTS_ANISOTROPIC_MATERIALS");              // ×2
class FSubstrateTileType       : SHADER_PERMUTATION_INT("SUBSTRATE_TILETYPE", 4);                        // ×4
class FVirtualShadowMapMask    : SHADER_PERMUTATION_BOOL("USE_VIRTUAL_SHADOW_MAP_MASK");                 // ×2
```

理论排列数 = `3 × 2^12 × 4 × 2 = 98,304`

实际编译数约 40,000–50,000（`ShouldCompilePermutation` 过滤了大量无效组合）。

### 排列数增长速度

| 布尔维度数 | 排列数 | 规模 |
|-----------|--------|------|
| 10 | 1,024 | KB 级 Shader Cache |
| 15 | 32,768 | MB 级 |
| 20 | 1,048,576 | GB 级 |
| 25 | 33,554,432 | 不可行 |

引擎对单个 ShaderType 的排列数设有告警阈值 `832`（参考 `ShaderCompiler.cpp`），超过时会在日志中提示。

---

## 三级过滤 — 砍掉不可能的组合

理论排列数巨大，但绝大多数组合在逻辑上不成立。UE 用三级过滤器逐层砍掉：

```
对于每个 (ShaderType, PermutationId, VertexFactoryType, Platform):

  Level 1: FShaderType::ShouldCompilePermutation()
    → 这个 Shader 的这个排列有没有意义？

  Level 2: FVertexFactoryType::ShouldCache()
    → 这个 Shader 和这个 VertexFactory 的组合有没有意义？

  Level 3: FShaderPipelineType::ShouldCompilePermutation()
    → Pipeline 中所有 Stage 是否都通过？

  三级都通过 → 加入编译队列
  任一不通过 → 跳过
```

### Level 1: FShaderType::ShouldCompilePermutation

每个 ShaderType 实现自己的过滤逻辑，最常见的判断依据：

```cpp
// FDeferredLightPS::ShouldCompilePermutation 示例
bool FDeferredLightPS::ShouldCompilePermutation(const FShaderPermutationParameters& Parameters)
{
    // 光源形状不匹配 → 跳过
    if (SourceShape == Directional && bUseIESProfile) return false;  // 方向光不用 IES
    if (SourceShape != Directional && bUseAtmosphereTransmittance) return false;  // 只有方向光用大气
    if (SourceShape != Directional && bUseCloudTransmittance) return false;
    if (SourceShape != Directional && bUseVirtualShadowMapMask) return false;
    ...
    return true;
}
```

FBasePassPS 的过滤更复杂——它会检查材质属性：

```cpp
bool FBasePassPS::ShouldCompilePermutation(...)
{
    if (!Parameters.MaterialParameters.bIsUsedWithLandscape && VFType == FLandscapeVF)
        return false;  // 非地表材质 + 地表 VF → 不编译
    if (Parameters.MaterialParameters.bIsTranslucent && !bSupportsTranslucency)
        return false;  // 半透明材质 + 不支持半透明的排列 → 不编译
    ...
}
```

### Level 2: FVertexFactoryType::ShouldCache

VertexFactory 决定哪些 Shader 可以和自己组合：

```cpp
// FLandscapeVertexFactory
bool ShouldCache(const FVertexFactoryShaderPermutationParameters& Parameters)
{
    return Parameters.MaterialParameters.bIsUsedWithLandscape 
        || Parameters.MaterialParameters.bIsSpecialEngineMaterial;
}

// FLocalVertexFactory (普通 Mesh)
bool ShouldCache(const FVertexFactoryShaderPermutationParameters& Parameters)
{
    if (Parameters.MaterialParameters.bIsUsedWithLandscape && !Parameters.MaterialParameters.bIsUsedWithOther)
        return false;  // 地表专用材质不需要和普通 Mesh VF 组合
    ...
}
```

### Level 3: FShaderPipelineType::ShouldCompilePermutation

Pipeline 级别要求所有 Stage 都通过：

```cpp
bool FShaderPipelineType::ShouldCompilePermutation(...)
{
    for (FShaderType* Stage : Stages)
    {
        if (!Stage->ShouldCompilePermutation(Parameters))
            return false;  // 任一 Stage 不通过 → 整个 Pipeline 不编译
    }
    return true;
}
```

### 过滤效果示意

```
FDeferredLightPS × 98,304 排列
  ↓ Level 1 (ShouldCompilePermutation)
  约 45,000 排列存活

FDeferredLightPS × 45,000 × 3 个 VertexFactory
  ↓ Level 2 (ShouldCache)
  FLocalVF: ~40,000 存活
  FLandscapeVF: ~15,000 存活 (只编译地表材质)
  FGPUSkinVF: ~20,000 存活 (只编译骨骼材质)

  ↓ Level 3 (Pipeline)
  少量 Pipeline 被整体跳过

最终编译数: ~75,000 (而非 98,304 × 3 = 294,912)
```

---

## 编译环境 — ModifyCompilationEnvironment

通过三级过滤后，进入编译前还需要设置编译环境——把排列维度的具体值转化为 Shader `#define`：

```
FShaderType::ModifyCompilationEnvironment()
  ├─ TShaderPermutationDomain::ModifyCompilationEnvironment()
  │    └─ 逐维度调用 SetDefine():
  │         SetDefine("LIGHT_SOURCE_SHAPE", 1)     // Capsule
  │         SetDefine("USE_SOURCE_TEXTURE", 1)      // true
  │         SetDefine("USE_IES_PROFILE", 0)         // false
  │         SetDefine("SUBSTRATE_TILETYPE", 2)      // int
  │         ...
  │
  ├─ FVertexFactoryType::ModifyCompilationEnvironment()
  │    └─ #include "LandscapeVertexFactory.ush"  // 注入 VF 的 Shader 源码
  │
  └─ FShaderPipelineType::ModifyCompilationEnvironment()
       └─ 跨 Stage 输出优化标记
```

Shader 源码中用 `#if` / `#ifdef` 响应这些 `#define`：

```hlsl
// LightRendering.usf
#if USE_SOURCE_TEXTURE
    Color *= SampleSourceTexture(...);
#endif

#if USE_IES_PROFILE
    Color *= SampleIESProfile(...);
#endif
```

每个排列组合产生不同的 `#define` 集合 → 不同的预处理器路径 → 不同的编译结果。

---

## 编译流程 — 从请求到二进制

```
┌─────────────────────────────────────────────────────┐
│ 1. 触发源                                             │
│    材质修改 / 首次加载 / Cook / PSO Precache          │
└──────────────────┬──────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────┐
│ 2. 遍历排列空间                                       │
│    FMaterialShaderMap::CacheShaders()                │
│    ├─ For each ShaderType                            │
│    ├─ For each PermutationId [0, N)                  │
│    ├─ For each VertexFactoryType                     │
│    └─ 三级过滤 → 生成 FShaderCompileJob 队列         │
└──────────────────┬──────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────┐
│ 3. 检查 DDC 缓存                                     │
│    Hash = Hash(ShaderSource + VFSource + PermDefines │
│               + Platform + MaterialProps)            │
│    ├─ DDC 命中 → 直接使用缓存字节码                   │
│    └─ DDC 未命中 → 加入编译队列                       │
└──────────────────┬──────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────┐
│ 4. 异步编译 (FShaderCompilingManager)                │
│    ├─ 分发给 ShaderCompileWorker 进程                 │
│    ├─ 每个进程编译一个 Job                            │
│    ├─ 流程: 预处理 → HLSL编译 → RHI字节码翻译        │
│    └─ 输出 FShaderCompilerOutput (字节码+元数据)      │
└──────────────────┬──────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────┐
│ 5. 构造 Shader 实例                                   │
│    FShaderType::ConstructCompiled(Output)            │
│    → FShader 实例 (持有字节码 + 参数布局)             │
└──────────────────┬──────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────┐
│ 6. 注册到 ShaderMap                                  │
│    FMaterialShaderMap::AddShader(Shader)              │
│    → 运行时通过 (ShaderType, PermId, VF) 查找        │
└─────────────────────────────────────────────────────┘
```

---

## PSO 缓存 — 从 Shader 到完整管线状态

Shader 编译完成后，运行时还需要将 VS + PS + BlendState + RasterizerState + DepthStencilState + RenderTargetFormats 组合成 **PSO (Pipeline State Object)**。PSO 缓存分两级：

### 预缓存 (PSOPrecache)

```
FPrimitiveSceneProxy 注册时:
  → GetPSOPrecacheVertexFetchElements() (VF 提供顶点声明)
  → 遍历该 Proxy 可能用到的 (ShaderType, PermId, VF, Material) 组合
  → PipelineStateCache::PrecacheGraphicsPipelineState()
       → 后台编译 PSO
       → 返回 FPSOPrecacheRequestID
```

### 运行时查找

```
FMeshDrawCommand 提交时:
  → FGraphicsMinimalPipelineStateId (PSO Hash)
  → PipelineStateCache::CheckPipelineStateInCache()
       ├─ Complete: 直接使用
       ├─ Active: 编译中, 跳过本帧
       └─ Missed: 运行时同步编译 (卡顿!)
```

### PSO 预缓存策略

```cpp
enum class EShaderPermutationPrecacheRequest : uint8
{
    Precached,     // 始终预缓存
    NotPrecached,  // 仅 Debug 编译, 不预缓存
    NotUsed        // 从不使用 (功能关闭/平台不支持)
};
```

`FShaderType::ShouldPrecachePermutation()` 返回上述值，控制哪些排列参与 PSO 预缓存。

---

## DDC 缓存 — 跨构建复用

Shader 编译结果通过 **DDC (Derived Data Cache)** 持久化，避免重复编译：

```
DDC Key = Hash(
    ShaderSourceFile +
    ShaderType::SourceHash +
    VertexFactoryType::SourceHash +
    ShaderPipelineType::SourceHash +
    MaterialShaderMap::Hash +
    PermutationVector::Defines +
    Platform +
    CompilerEnvironment::Defines
)
```

- **命中 DDC**：直接读取字节码，跳过编译（毫秒级）
- **未命中 DDC**：完整编译（秒级）
- Cook 过程会预热 DDC，确保打包游戏不触发运行时编译

---

## 地表 Shader 编译实例

以 `FLandscapeVertexFactory` + `FBasePassPS` 为例，展示完整的过滤链：

```
FBasePassPS 的排列维度 (简化):
  ├─ SHADER_PERMUTATION_BOOL("ENABLE_MOBILE_MODE")     // ×2
  ├─ SHADER_PERMUTATION_BOOL("USE_SCENE_COLOR_COPY")   // ×2
  ├─ SHADER_PERMUTATION_INT("SUBSTRATE_TILETYPE", 4)   // ×4
  └─ ... 更多维度

FLandscapeVertexFactory 的排列:
  ├─ GPUScene On/Off (桌面/移动)                       // ×2
  └─ Fixed Grid / Continuous LOD                       // ×2

材质属性:
  ├─ bIsUsedWithLandscape = true
  ├─ BlendMode = Opaque
  └─ ShadingModel = Default

过滤过程:

  Level 1: FBasePassPS::ShouldCompilePermutation()
    ├─ ENABLE_MOBILE_MODE=true + 桌面平台 → 跳过
    ├─ USE_SCENE_COLOR_COPY=true + Opaque材质 → 跳过
    └─ 其余排列通过

  Level 2: FLandscapeVertexFactory::ShouldCache()
    ├─ bIsUsedWithLandscape=true → 通过 ✓
    └─ bIsSpecialEngineMaterial=false → 但上面已通过

  Level 3: Pipeline
    └─ VS + PS 都通过 → 通过 ✓

  最终编译:
    地表材质 × FBasePassPS × FLandscapeVF × 桌面
    → 编译 N 个有效排列 (N 远小于理论总数)
```

---

## 与 Unity URP 的对比

| 维度 | Unity URP | UE |
|------|-----------|-----|
| **编译触发** | 材质变化时自动重编 | 材质变化 → 异步编译 → ShaderMap 更新 |
| **排列来源** | Shader 关键字 (multi_compile, shader_feature) | TShaderPermutationDomain 宏 |
| **过滤机制** | `#pragma shader_feature` (按需) vs `#pragma multi_compile` (全编) | 三级 ShouldCompilePermutation |
| **VF 组合** | 无 (VertexFactory 是 Unity 内部概念) | 显式 Material × VF 笛卡尔积 |
| **缓存** | Shader Cache (PlayerPrefs / 文件) | DDC + ShaderMap + PSO Cache |
| **运行时编译** | 有 (shader_feature 首次使用时) | 有 (PSO Miss 时同步编译, 卡顿) |
| **预缓存** | Shader Variant Collection | PSOPrecache + ShaderPipelineCache |
| **排列规模** | 通常 100–1000/Shader | 单个 Shader 可达数万 |

**核心差异**：Unity 的 `shader_feature` 是"用到才编"，UE 的 ShouldCompilePermutation 是"编前先判"——效果类似但 UE 的排列空间远大于 Unity（因为多了 VertexFactory 维度）。

---

## 关键源码速查

| 组件 | 文件 | 路径 |
|------|------|------|
| **排列框架** | `ShaderPermutation.h` | `Runtime/RenderCore/Public/` |
| **ShaderType** | `Shader.h` | `Runtime/RenderCore/Public/` |
| **VertexFactoryType** | `VertexFactory.h` | `Runtime/RenderCore/Public/` |
| **编译管理器** | `Shader.cpp` | `Runtime/RenderCore/Private/` |
| **PSO 缓存** | `PipelineStateCache.h` | `Runtime/RHI/Public/` |
| **材质编译** | `ShaderCompiler.cpp` | `Runtime/Engine/Private/ShaderCompiler/` |
| **排列实例** | `LightRendering.cpp` | `Runtime/Renderer/Private/` |
| **地表 VF 过滤** | `LandscapeRender.cpp` | `Runtime/Landscape/Private/` |

---

## 总结

UE Shader 编译的核心规则是 **Material × VertexFactory × Permutation × Platform 的笛卡尔积**，通过三级过滤器（ShaderType / VertexFactoryType / ShaderPipelineType）砍掉逻辑上不成立的组合。每个排列组合通过 `ModifyCompilationEnvironment` 转化为 `#define` 集合，编译出独立的 Shader 二进制。编译结果通过 DDC 持久化，PSO 通过预缓存避免运行时卡顿。

排列组合的数量是 Shader 维度的乘积——10 个布尔维度 = 1024 排列，20 个 = 百万级。`ShouldCompilePermutation` 是控制编译量的关键防线，也是 TA 修改引擎 Shader 时最容易踩坑的地方：每加一个 `SHADER_PERMUTATION_BOOL`，所有相关材质的 Shader 编译量翻倍。
