+++
date = '2026-05-18T16:00:00+08:00'
draft = false
title = 'UE 地表绘制流程架构全景'
tags = ['UE', 'Landscape', 'Weightmap', 'Splatmap', 'EditLayer', 'Terrain', 'URP', 'Renderer', 'Nanite']
categories = ['图形渲染']
+++

## 概述

UE 的地表（Landscape）绘制系统是一个三层流水线架构：**编辑层 → 数据层 → 渲染层**。本文从源码出发，梳理从用户笔画到屏幕像素的完整数据流，并以 Unity URP 为参照解释 UE 渲染管线。

---

## 三层流水线总览

```
编辑层 (Editor Mode)          数据层 (Data/Texture)         渲染层 (Render/Proxy)
─────────────────            ─────────────────           ──────────────────
FEdModeLandscape              FLandscapeDataInterface      FLandscapeComponentSceneProxy
  → FLandscapeToolStrokePaint  → Texture Mip Lock/Unlock    → FLandscapeVertexFactory
    → FLandscapeBrush            → Weightmap (BGRA8)         → Material Layer Weight Nodes
      → FWeightmapToolTarget       → Heightmap (G16)          → Scene Proxy Draw
```

---

## 编辑层 — 用户笔画到数据写入

### 核心类

| 角色 | 类 | 源码位置 | 职责 |
|------|-----|---------|------|
| 编辑模式入口 | `FEdModeLandscape` | `Editor/LandscapeEditor/Public/LandscapeEdMode.h` | 工具选择、目标层管理、viewport 交互 |
| 画笔核心 | `FLandscapeToolStrokePaint` | `Editor/LandscapeEditor/Private/LandscapeEdModePaintTools.cpp` | 应用 brush mask → weightmap 写入 |
| Brush 数据 | `FLandscapeBrushData` | `Editor/LandscapeEditor/Public/LandscapeEdModeTools.h` | 笔刷形状、强度、衰减 |
| 编辑设置 | `ULandscapeEditorObject` | `Editor/LandscapeEditor/Public/LandscapeEditorObject.h` | BrushSize/Strength/PaintStrengthGamma |
| 目标层缓存 | `FWeightmapToolTarget` | `Editor/LandscapeEditor/Public/LandscapeEdModeTools.h` | Lock weightmap mip, 读-改-写 |

### 绘制流程

```
鼠标笔画 → FEdModeLandscape::ApplyBrush()
  → FLandscapeToolStrokePaint::Apply()
    → 获取 FLandscapeBrushData (笔刷形状+强度)
    → 构建 TotalInfluenceMap (每个受影响顶点的笔刷权重)
    → FWeightmapToolTarget::Cache (Lock weightmap mip)
      → 写入 RGBA 通道 (每通道 = 一个层权重 0–255)
      → Unlock mip, 标记组件 dirty
    → 触发 EditLayer merge
```

**关键细节**：

- **Weightmap 格式**：`BGRA8` 纹理，每通道对应一个 `ULandscapeLayerInfoObject` 的权重，每纹理最多 4 层，每组件最多约 8 张 weightmap（即 32 层上限）
- **StrengthGamma**：`ULandscapeEditorObject::PaintStrengthGamma` 提供非线性强度曲线，让低强度值仍可感知
- **InvertPaint**：Shift 键触发反向绘制（减权重而非加）

---

## 数据层 — Weightmap/Heightmap 存储 & EditLayer 合并

### ALandscapeProxy — 地表 Actor 层基类

地表的 Actor 层使用 Proxy 模式支持世界分区流式加载：

```
AActor
  └── APartitionActor (世界分区基类)
       └── ALandscapeProxy (抽象基类 — 拥有所有地表组件和数据)
            ├── ALandscape              (主地表 Actor — 共享数据的权威源)
            └── ALandscapeStreamingProxy (流式代理 — 引用主 Actor，可独立加载/卸载)
```

**为什么要拆**：一张大地表（如 8K×8K）可能有上千个 `ULandscapeComponent`。全挂在同一个 Actor 上则世界分区无法按空间流式加载/卸载、编辑器协作冲突、单 Actor 组件数过多。拆法是把地表按空间切成多个 `ALandscapeStreamingProxy`，每个代理持有自己区域的组件，但共享材质、LOD 设置、EditLayer 等数据——权威源是唯一的 `ALandscape`。

```
┌─ ALandscape (主 Actor, 常驻内存) ─────────────────────────────┐
│  LandscapeGuid: {A1B2C3...}                                   │
│  LandscapeMaterial / HoleMaterial                              │
│  TargetLayers / EditLayers                                     │
│  LOD0ScreenSize / LODDistributionSetting / LODBlendRange       │
│  bEnableNanite / bNaniteUnifiedMaterial                        │
│                                                                │
│  ┌─── ALandscapeStreamingProxy (区域 A) ────┐                  │
│  │  LandscapeActorRef → ALandscape           │                  │
│  │  LandscapeComponents[0..63]               │                  │
│  │  CollisionComponents[0..63]               │                  │
│  │  FoliageComponents[0..N]                  │                  │
│  │  NaniteComponents[0..N]                   │                  │
│  └───────────────────────────────────────────┘                  │
│  ┌─── ALandscapeStreamingProxy (区域 B) ────┐                  │
│  │  LandscapeActorRef → ALandscape           │                  │
│  │  LandscapeComponents[64..127]             │                  │
│  │  ...                                     │                  │
│  └───────────────────────────────────────────┘                  │
└────────────────────────────────────────────────────────────────┘
```

`ALandscapeProxy` 持有的核心数据：

| 类别 | 成员 | 说明 |
|------|------|------|
| **组件** | `LandscapeComponents` | 渲染组件 (63×63 quad tiles) |
| | `CollisionComponents` | 碰撞组件 |
| | `FoliageComponents` | 草地 HISMC |
| | `NaniteComponents` | Nanite 表示 |
| **材质** | `LandscapeMaterial` / `HoleMaterial` | 主材质 / 镂空材质 |
| | `PerLODOverrideMaterials` | Per-LOD 材质覆盖 |
| | `RuntimeVirtualTextures` | RVT 目标列表 |
| **LOD** | `MaxLODLevel`, `LOD0ScreenSize`, `LODDistributionSetting`, `LODBlendRange` | LOD 分布参数 |
| | `LODGroupKey` | 同步 LOD 计算 (多个 Proxy 间) |
| **数据** | `TargetLayers` | 绘制层设置 |
| | `LandscapeGuid` | 唯一标识 (同一地表的所有 Proxy 共享) |
| | `SectionBase`, `ComponentSizeQuads`, `NumSubsections` | 网格布局 |
| **草地** | `FoliageCache`, `AsyncFoliageTasks`, `GrassTypeSummary` | 草地实例缓存 |

关键虚方法的分工：

| 方法 | ALandscape 实现 | ALandscapeStreamingProxy 实现 |
|------|-----------------|-------------------------------|
| `GetLandscapeActor()` | `return this` | `return LandscapeActorRef.Get()` |
| `UpdateSharedProperties()` | 源头，推送设置 | 接收，从主 Actor 同步 |
| `GetLandscapeMaterial()` | 返回自身材质 | 代理到 `GetLandscapeActor()->GetLandscapeMaterial()` |
| `IsPropertyInherited()` | 返回 false | 检查 `OverriddenSharedProperties` 位域 |

### 核心类

| 角色 | 类 | 源码位置 | 职责 |
|------|-----|---------|------|
| 主 Actor | `ALandscape` → `ALandscapeProxy` | `Runtime/Landscape/Public/Landscape.h` | EditLayer 管理, weightmap/heightmap 纹理持有者 |
| 组件 | `ULandscapeComponent` | `Runtime/Landscape/Public/LandscapeComponent.h` | 63×63 quad tile, 持有本组件纹理引用 |
| 层定义 | `ULandscapeLayerInfoObject` | `Runtime/Landscape/Public/LandscapeLayerInfoObject.h` | 层名、物理材质、硬度、BlendMethod |
| 编辑层基类 | `ULandscapeEditLayerBase` | `Runtime/Landscape/Public/LandscapeEditLayer.h` | 多层编辑支持 (Heightmap/Weightmap/Visibility) |
| CPU 数据访问 | `FLandscapeTextureDataInterface` | `Runtime/Landscape/Public/LandscapeEdit.h` | Texture Mip Lock/Unlock, 区域读写 |
| 底层数据访问 | `FLandscapeDataInterface` | `Runtime/Landscape/Public/LandscapeDataAccess.h` | 纹理到内存映射, 引用计数 |
| GPU 合并渲染 | `FLandscapeEditLayerRenderer` | `Runtime/Landscape/Private/LandscapeEditLayerRenderer.h` | RDG pass, 多层垂直混合 |
| 合并上下文 | `LandscapeEditLayerMergeContext` | `Runtime/Landscape/Private/LandscapeEditLayerMergeContext.h` | 批量合并参数, readback 结果 |

### EditLayer 合并流程

UE5 的 EditLayer 系统支持多个编辑层垂直叠加，最终合并到一张 weightmap：

```
ALandscape::UpdateLayersContent()
  ↓
PerformLayersWeightmapsBatchedMerge()
  - 按渲染目标布局批量分组组件
  - 使用 FEditLayersWeightmapMergeParams
  ↓
FLandscapeEditLayerRenderer::Render()
  - RDG (Render Dependency Graph) pass
  - 逐像素混合各 EditLayer (垂直混合)
  - 应用 Blend 模式 (FinalWeightBlending / PremultipliedAlphaBlending)
  ↓
写入合并后的 weightmap 到组件纹理
  ↓
ResolveLayersWeightmapTexture()
  - GPU → CPU Readback (如需要)
  - 更新碰撞、草地映射、物理材质
```

### Blend 模式

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| `None` | 层权重不受其他层影响 | 独立层 |
| `FinalWeightBlending`（Legacy） | 合并结束后归一化（水平混合） | 兼容旧项目 |
| `PremultipliedAlphaBlending`（Advanced） | 逐层应用 alpha 混合（垂直混合） | UE5 推荐 |

### FMergeRenderContext — 合并管线核心类

| 角色 | 类 | 源码路径 | 职责 |
|------|-----|---------|------|
| 渲染器接口 | `ILandscapeEditLayerRenderer` | `Runtime/Landscape/Public/LandscapeEditLayerRenderer.h:259` | UInterface：GetRendererStateInfo / GetRenderItems / RenderLayer / BlendLayer |
| 合成总控 | `FMergeRenderContext` | `LandscapeEditLayerMergeRenderContext.h:296` | 3 个 BlendRenderTarget（Write/Read/ReadPrevious 循环切换）、RenderBatches、BlackboardItems |
| 渲染批次 | `FMergeRenderBatch` | `LandscapeEditLayerMergeRenderContext.h:146` | RenderSteps 数组、ComponentsToRender、SectionRect、Resolution |
| 渲染步骤 | `FMergeRenderStep` | `LandscapeEditLayerMergeRenderContext.h:75` | BeginRenderCommandRecorder → RenderLayer → BlendLayer → SignalBatchMergeGroupDone → EndRenderCommandRecorder |
| 渲染能力声明 | `FEditLayerRenderItem` | `LandscapeEditLayerRenderer.h:171` | TargetTypeState + InputWorldArea + OutputWorldArea + bModifyExistingWeightmapsOnly |

**三缓冲轮转机制**：

```
BlendRenderTarget[0] = Write (RTV)       ← 当前层渲染目标
BlendRenderTarget[1] = Read  (SRV)       ← 累积合并结果
BlendRenderTarget[2] = ReadPrevious(SRV) ← 前一次 Blend 结果

CycleBlendRenderTargets():
  Write → Read → ReadPrevious → Write（循环轮转）
  每次 RenderLayer 写入 Write
  每次 BlendLayer 从 Read + Write 采样 → 写入新 Write
```

### RenderTarget 管理

`ALandscape` 维护一组 RenderTarget 池用于 GPU 合并：

- **HeightmapRT**: CombinedAtlas, CombinedNonAtlas, Scratch1-3, Mip1-7
- **WeightmapRT**: Scratch_RGBA, Scratch1-3, Mip0-7

---

## 渲染层 — 以地表为例详解运行时流程

### 核心类

| 角色 | 类 | 源码位置 | 职责 |
|------|-----|---------|------|
| Scene Proxy | `FLandscapeComponentSceneProxy` | `Runtime/Landscape/Private/LandscapeRender.cpp` | LOD 管理 (8级), MeshBatch 提交 |
| Uniform 参数 | `FLandscapeUniformShaderParameters` | `Runtime/Landscape/Public/LandscapeRender.h` | Heightmap/Weightmap/Normalmap 纹理引用 + UV Scale/Bias |
| 批量参数 | `FLandscapeBatchElementParams` | `Runtime/Landscape/Public/LandscapeRender.h` | Per-DrawCall 参数: UniformBuffer 引用 + LOD + SceneProxy 指针 |
| Vertex Factory | `FLandscapeVertexFactory` | `Runtime/Landscape/Public/LandscapeRender.h` | 地表顶点布局, VS/PS Shader 参数绑定 |
| 固定格式 VF | `FLandscapeFixedGridVertexFactory` | `Runtime/Landscape/Public/LandscapeRender.h` | RVT/VHFM/Lumen 使用的固定 LOD 顶点格式 |
| 材质实例 | `ULandscapeMaterialInstanceConstant` | `Runtime/Landscape/Classes/LandscapeMaterialInstanceConstant.h` | Per-component 材质, 绑定 weightmap 到纹理参数 |

### 材质表达式

| 表达式 | 说明 |
|--------|------|
| `UMaterialExpressionLandscapeLayerWeight` | 在 Shader 中采样 weightmap 并混合各层材质 |
| `UMaterialExpressionLandscapeLayerSample` | 仅采样层权重值 |
| `UMaterialExpressionLandscapeLayerBlend` | 复杂层混合 |
| `UMaterialExpressionLandscapeLayerCoords` | UV 坐标生成 |
| `UMaterialExpressionLandscapeLayerSwitch` | 条件层切换 |

### 运行时渲染全流程 — 从 Actor 到像素

> **注**：以下流程描述的是官方 Landscape（`FLandscapeComponentSceneProxy`）路径。开启 Nanite 时地表切换到完全不同的 VisBuffer 管线，详见「Nanite Landscape」章节；Nanite 关闭时可改用 **VHFM**（CS-driven），详见「Virtual Heightfield Mesh」章节。

#### Phase 0: 注册 — Game Thread

```
ULandscapeComponent::CreateSceneProxy()
  ↓
FLandscapeComponentSceneProxy 构造 (LandscapeRender.cpp:1387)
  ├─ 存储 HeightmapTexture (UTexture2D*)
  ├─ 存储 WeightmapTextures (TArray<UTexture2D*>)
  ├─ 存储 AvailableMaterials (FMaterialRenderProxy* 数组, per-LOD)
  ├─ 存储 LODScreenRatioSquared (预计算 LOD 切换阈值)
  ├─ 存储 HeightmapScaleBias / WeightmapScaleBias
  └─ 存储 SubsectionSizeVerts / NumSubsections / SectionBase
  └─ 预计算 LODScreenRatioSquared[] (LandscapeRender.cpp:1544-1566)
       LOD0ScreenSize / StaticMeshLODDistanceScale → CurrentScreenSizeRatio
       LODScreenRatioSquared[0] = CurrentScreenSizeRatio²
       CurrentScreenSizeRatio /= LOD0Distribution
       LODScreenRatioSquared[1] = CurrentScreenSizeRatio²
         ... 每级递推 CurrentScreenSizeRatio /= LODDistribution
```

```
CreateRenderThreadResources() (LandscapeRender.cpp:1748)
  ├─ 注册到 FLandscapeRenderSystem (LOD 计算系统)
  ├─ 获取/创建 FLandscapeSharedBuffers (按组件尺寸缓存)
  │    ├─ VertexBuffer (FLandscapeVertex: VertexX/Y, SubX/SubY 各 uint8)
  │    ├─ IndexBuffers[0..7] (每级 LOD 一套索引)
  │    └─ FixedGridIndexBuffers (固定 LOD 索引)
  │    SharedBuffersKey = (SubsectionSizeLog2 & 0xf) | ((NumSubsections & 0xf) << 4) | ((NumRayTracingSections & 0xf) << 8)
  │    → 相同配置的组件共享同一份 VB + IB，减少 GPU 内存占用
  ├─ 初始化 FLandscapeVertexFactory → 绑定共享 VertexBuffer
  ├─ 初始化 FLandscapeFixedGridVertexFactory → RVT/VHFM 用
  └─ 创建 LandscapeUniformShaderParameters UniformBuffer
       └─ OnTransformChanged() 填充:
            ├─ ComponentBaseX/Y
            ├─ HeightmapTexture / HeightmapTextureSampler (Point)
            ├─ NormalmapTexture / NormalmapTextureSampler (Bilinear)
            ├─ HeightmapUVScaleBias / WeightmapUVScaleBias
            └─ SubsectionSizeVerts / NumSubsections / LastLOD
```

#### Phase 1: 可见性 & LOD — InitViews

```
FRelevancePacket::ComputeRelevance() (SceneVisibility.cpp)
  ├─ PrimitiveSceneProxy->GetViewRelevance()
  │    └─ FLandscapeComponentSceneProxy 返回:
  │         bStatic=true, bOpaque=true, bDynamic=true
  │         (同时参与静态缓存和动态绘制)
  └─ 标记 StaticMeshVisibilityMap + 各 Pass Relevance
```

**LOD 计算流（每帧，Render Thread）**：

```
FLandscapeSceneViewExtension.PreRenderViewFamily_RenderThread()
  → 对每个 LandscapeRenderSystem:
    ComputeSectionsLODForView(View, ShadowInvalidatingInstances)
      → 对每个 FLandscapeSectionInfo:
        ComputeLODForView(View)
          → ScreenSizeSquared = ComponentBounds.GetScreenSizeSquared(View)
          → LODValue = ComputeLODFromScreenSize(LODSettings, ScreenSizeSquared)
            → 逐级比较 ScreenSizeSquared 与 LODScreenRatioSquared[]
            → 返回连续 LOD 值（含小数部分，用于 morphing）
      → 写入 SectionLODBiases (CPU array)
    UpdateBuffers(RHICmdList) → SectionLODBiasBuffer (GPU SRV) + SectionLODUniformBuffer
```

#### Phase 2: 生成 MeshBatch — GetDynamicMeshElements

```
FLandscapeComponentSceneProxy::GetDynamicMeshElements() (LandscapeRender.cpp:2592)
  ├─ 向 FLandscapeRenderSystem 查询当前视角 LOD
  │    └─ LODToRender = RenderSystem.GetSectionLODValue(*View, RenderCoord)
  │         (基于屏幕占比 vs LODScreenRatioSquared 阈值)
  │
  ├─ GetStaticMeshElement(LODToRender, ...) (LandscapeRender.cpp:2411)
  │    ├─ MeshBatch.VertexFactory = &VertexFactory
  │    ├─ MeshBatch.MaterialRenderProxy = AvailableMaterials[LODIndex]
  │    ├─ MeshBatch.Type = PT_TriangleList
  │    ├─ MeshBatch.LODIndex = LODIndex
  │    │
  │    ├─ FLandscapeBatchElementParams (UserData):
  │    │    ├─ LandscapeUniformShaderParametersResource → Heightmap/Normalmap 纹理引用
  │    │    ├─ FixedGridUniformShaderParameters → 固定 LOD 参数
  │    │    ├─ LandscapeSectionLODUniformParameters → LOD 偏移 Buffer
  │    │    ├─ SceneProxy = this
  │    │    └─ CurrentLOD = LODIndex
  │    │
  │    └─ BatchElement:
  │         ├─ IndexBuffer = SharedBuffers->IndexBuffers[LODIndex]
  │         ├─ NumPrimitives = (SubsectionVerts>>LOD - 1)² × NumSubsections² × 2
  │         └─ UserData = &BatchElementParams
  │
  └─ collector.AddMesh(MeshBatch)  → 进入渲染管线的 FMeshBatch 流
```

#### 静态路径 — GetStaticMeshElement & DrawStaticElements

动态路径每帧重建；**静态路径**注册到静态绘制列表，跨帧缓存（`DrawStaticElements`，`LandscapeRender.cpp:2470`）：

```cpp
// GetStaticMeshElement(LODIndex) 填充 FMeshBatch 关键字段
MeshBatch.VertexFactory        = VertexFactory;
MeshBatch.MaterialRenderProxy   = AvailableMaterials[LODIndexToMaterialIndex[LODIndex]];
MeshBatch.LCI                  = ComponentLightInfo.Get();
MeshBatch.CastShadow           = true;
MeshBatch.bUseAsOccluder       = ShouldUseAsOccluder() && Deferred && !IsMovable();
MeshBatch.Type                 = PT_TriangleList;

BatchElementParams->LandscapeUniformShaderParametersResource = &LandscapeUniformShaderParameters;
BatchElementParams->LandscapeSectionLODUniformParameters     = RenderSystem.SectionLODUniformBuffer;
BatchElementParams->CurrentLOD                                = LODIndex;

BatchElement.IndexBuffer    = SharedBuffers->IndexBuffers[LODIndex];
BatchElement.NumPrimitives  = ((SubsectionSizeVerts >> LODIndex) - 1)² × NumSubsections² × 2;
//   例：SubsectionSizeQuads=63, NumSubsections=2, LOD0 → (64-1)²×4×2 = 31,584 个三角形
```

`DrawStaticElements` 注册的总 Batch 数：

```
TotalBatchCount = (1 + LastLOD - FirstLOD)     // 主 LOD 批次
                + VTLods × MaterialTypes        // RVT 写入（FixedGridVF，per-MaterialType × per-VTLOD）
                + 1                             // WaterInfoTexture（LOD0 FixedGrid）
                + 1                             // LumenSurfaceCache（LOD0，bUseForLumenSurfaceCacheCapture）

// ScreenSize 参数：LOD0 = FLT_MAX（永远绘制），其余 = Sqrt(LODScreenRatioSquared[i]) × 2.0
```

#### 编辑器可视化模式（WITH_EDITOR）

| ViewMode | 渲染方式 |
|----------|---------|
| `DebugLayer` | `FLandscapeDebugMaterialRenderProxy`，传入 DebugChannelR/G/B 对应的 WeightmapTextures |
| `LayerDensity` | `FColoredMaterialRenderProxy`，按 NumWeightmapLayerAllocations 索引 ShaderComplexityColors |
| `LayerUsage` | `FLandscapeLayerUsageRenderProxy`，传入 LayerColors 数组 + 旋转参数 |
| `LOD` | `FColoredMaterialRenderProxy`，按 LODIndex 索引 LODColorationColors |
| `WireframeOnTop` | 正常材质 + Wireframe overlay |
| `LayerContribution` | `FLandscapeMaskMaterialRenderProxy`，显示层贡献 mask |
```

#### Phase 3: 生成 DrawCommand — FMeshPassProcessor

```
以 BasePass 为例:

FBasePassMeshProcessor::AddMeshBatch(FMeshBatch)
  ↓ 判断材质属性 (masked, two-sided, etc.)
BuildMeshDrawCommands<FBasePassShaders>()
  ├─ 获取材质 Shader: FMeshMaterialShader (VS/PS/GS)
  ├─ 创建 FGraphicsMinimalPipelineState (Blend/RS/DS) → PSO Hash
  ├─ FMeshDrawCommand 初始化:
  │    ├─ ShaderBindings ← 将由 GetElementShaderBindings() 填充
  │    ├─ VertexStreams ← VertexFactory 的顶点缓冲
  │    ├─ IndexBuffer ← BatchElement.IndexBuffer
  │    ├─ CachedPipelineId ← PSO ID
  │    └─ FirstIndex / NumPrimitives / NumInstances
  └─ SetDrawParametersAndFinalize()
```

#### Phase 4: Shader 参数绑定 — GetElementShaderBindings

这是 CPU 端最后一步，将地表特有数据绑定到 GPU Shader：

```
// VS 参数绑定 (LandscapeRender.cpp:3587)
FLandscapeVertexFactoryVertexShaderParameters::GetElementShaderBindings()
  ├─ 从 BatchElement.UserData 取出 FLandscapeBatchElementParams
  ├─ ShaderBindings.Add(FLandscapeUniformShaderParameters, LandscapeUniformShaderParametersResource)
  │    └─ 包含: HeightmapTexture, NormalmapTexture, UVScaleBias, ComponentBase, ...
  ├─ ShaderBindings.Add(FLandscapeSectionLODUniformParameters, SectionLODUniformBuffer)
  └─ ShaderBindings.Add(FLandscapeVertexFactoryMVFParameters, MVFUniformBuffer) // RayTracing

// PS 参数绑定 (LandscapeRender.cpp:3674)
FLandscapeVertexFactoryPixelShaderParameters::GetElementShaderBindings()
  ├─ ShaderBindings.Add(FLandscapeUniformShaderParameters, LandscapeUniformShaderParametersResource)
  └─ Weightmap 纹理由 Material 的 Texture Parameter 节点绑定 (ULandscapeMaterialInstanceConstant)
```

**`FLandscapeUniformShaderParameters` 核心参数**（`LandscapeRender.h:116`）：

| 参数 | 用途 |
|------|------|
| `HeightmapTexture` + `HeightmapTextureSampler` | VS 采样高度图，重建世界位置 |
| `NormalmapTexture` + `NormalmapTextureSampler` | PS 采样法线 |
| `HeightmapUVScaleBias` | Heightmap 纹理坐标缩放偏移 |
| `WeightmapUVScaleBias` | Weightmap 纹理坐标缩放偏移 |
| `SubsectionSizeVertsLayerUVPan` | Subsection 参数 |
| `LocalToWorldNoScaling` | 无缩放的 LocalToWorld 矩阵 |
| `ComponentBaseX/Y` | 组件在 heightmap 空间的基址 |
| `LastLOD` / `InvLODBlendRange` | LOD morphing 参数 |

**注**：Weightmap 纹理不在此 UB 中直接绑定，而是通过 `ULandscapeMaterialInstanceConstant` 设置材质的 `LandscapeLayerWeight` 纹理参数，per-component 材质实例自动把对应 Weightmap 通道绑到 Shader。
```

#### Phase 5: GPU Vertex Shader — LandscapeVertexFactory.ush

顶点输入极简（每顶点仅 4 字节），位移完全靠采样 Heightmap：

```
// 顶点输入 (LandscapeVertexFactory.ush:152)
struct FVertexFactoryInput {
    uint4 Position : ATTRIBUTE0;  // VertexX(u8), VertexY(u8), SubX(u8), SubY(u8)
};

// 核心函数: GetVertexFactoryIntermediates() (LandscapeVertexFactory.ush:637)
1. 解码顶点位置: (VertexX, VertexY) → 网格坐标 → 归一化 UV
2. 采样 Heightmap (当前 LOD):
   SampleCoords = LocalPosition * HeightmapUVScaleBias.xy + HeightmapUVScaleBias.zw
   SampleValue = Texture2DSampleLevel(HeightmapTexture, Sampler, SampleCoords, LodMip)
   Height = DecodePackedHeight(SampleValue.xy)  // RG8 → 16-bit 高度

3. 采样 Heightmap (下一级 LOD, 用于 Morph):
   SampleValueNextLOD = Texture2DSampleLevel(..., LodMip+1)
   HeightNextLOD = DecodePackedHeight(SampleValueNextLOD.xy)

4. LOD Morph 插值:
   LocalPosition = lerp(CurrentLOD_Pos, NextLOD_Pos, MorphAlpha)

5. 法线提取 (从 Heightmap 的 BA 通道):
   Normal.xy = SampleValue.ba * 2.0 - 1.0
   Normal.z = sqrt(1 - dot(Normal.xy, Normal.xy))  // 重建 Z 分量
```

**Heightmap 纹理格式 (R8G8B8A8)**：
- `.RG` 通道：打包 16-bit 高度值（`R*256 + G` 映射到 0–65535）
- `.BA` 通道：法线 XY（存为 `value*0.5+0.5`，解码 `*2-1`，Z 由 `sqrt(1-x²-y²)` 重建）

#### Phase 6: GPU Vertex → Pixel 插值

```
struct FVertexFactoryInterpolantsVSToPS {
    float2 LayerTexCoord;           // TEXCOORD0 — 材质层 UV
    float4 WeightHeightMapTexCoord; // TEXCOORD1 — XY=WeightmapUV, ZW=HeightmapUV
    float4 TransformedTexCoords;    // TEXCOORD2 — XZ/YZ 投影 UV (悬崖 triplanar)
    float4 LightMapCoordinate;      // TEXCOORD3 — Lightmap UV
    uint   PrimitiveId;             // PRIMITIVE_ID — GPU Scene 索引
};
```

UV 生成 (`GetLandscapeTexCoords()`, LandscapeVertexFactory.ush:365)：
- `LayerTexCoord`: 材质采样 UV（LocalPosition.xy + SubsectionOffset）
- `WeightMapTexCoord`: Weightmap 采样 UV（LocalPosition * WeightmapUVScaleBias）
- `HeightMapTexCoord`: Heightmap 采样 UV（LocalPosition * HeightmapUVScaleBias + 半像素偏移）

#### Phase 7: GPU Pixel Shader — 材质求值

```
// Per-Pixel 法线 (LandscapeVertexFactory.ush:392)
VertexFactoryGetPerPixelTangentBasis()
  ├─ 采样 NormalmapTexture (比 VS 更精确的法线)
  └─ 重建 TangentBasis

// Per-Pixel 高度 (LandscapeVertexFactory.ush:417)
VertexFactoryGetPerPixelHeight()
  ├─ 采样 HeightmapTexture
  └─ DecodePackedHeight → 精确高度值 (用于 VHFM/Nanite Displacement)

// 材质参数组装 (LandscapeVertexFactory.ush:468)
GetMaterialPixelParameters()
  ├─ TexCoords[0] = LayerTexCoord.xy       → 材质层采样
  ├─ TexCoords[1] = TransformedTexCoords.xy → XZ 投影 (悬崖面)
  ├─ TexCoords[2] = TransformedTexCoords.zw → YZ 投影 (悬崖面)
  ├─ TexCoords[3] = WeightMapTexCoord.xy    → Weightmap 采样
  ├─ TexCoords[4] = LightMapUV              → Lightmap
  └─ TexCoords[5] = HeightMapTexCoord.zw    → Per-Pixel 高度

// Material Layer Weight 节点执行:
  ├─ 采样 Weightmap (TexCoords[3]) → 获取各层权重
  ├─ 按权重混合各层 PBR 属性 (BaseColor/Normal/Roughness/Metallic/AO)
  └─ 输出到 G-Buffer (Deferred) 或直接着色 (Forward)
```

#### Phase 8: 提交到 RHI

```
FMeshDrawCommand::SubmitDrawBegin()
  ├─ RHICmdList.SetGraphicsPipeline(CachedPipelineId)  → 设置 PSO
  ├─ RHICmdList.SetStreamSource(VertexStreams)          → 绑定 VB
  ├─ RHICmdList.SetIndexBuffer(IndexBuffer)             → 绑定 IB
  └─ ShaderBindings.Apply(RHICmdList)                   → 绑定 UB/SRV/Sampler

FMeshDrawCommand::SubmitDrawEnd()
  └─ RHICmdList.DrawIndexedPrimitive(FirstIndex, NumPrimitives, NumInstances)
```

### 完整数据流图

```
CPU (Game Thread)                   CPU (Render Thread)                GPU
═════════════════                  ═══════════════════                ═══

ULandscapeComponent
  │
  ├─ HeightmapTexture ──────────┐
  ├─ WeightmapTextures[] ───────┤
  ├─ Material (per-LOD) ────────┤
  │                             │
  ↓ CreateSceneProxy()          │
FLandscapeComponentSceneProxy   │
  ├─ 构造函数存储引用 ──────────┘
  ├─ CreateRenderThreadResources()
  │    ├─ SharedBuffers (VB/IB)
  │    ├─ VertexFactory
  │    └─ UniformShaderParameters
  │         ├─ HeightmapTexture ────────────────────────> VS: SampleLevel → Height
  │         ├─ NormalmapTexture ────────────────────────> PS: Sample → Normal
  │         └─ UVScaleBias ─────────────────────────────> VS/PS: 坐标变换
  │
  ├─ GetDynamicMeshElements()
  │    ├─ LOD 选择 (ScreenRatio)
  │    ├─ 创建 FMeshBatch
  │    │    ├─ MaterialRenderProxy ──> Weightmap 绑定 ──> PS: Sample → Layer Weights
  │    │    ├─ IndexBuffer[LOD]
  │    │    └─ BatchElementParams (UserData)
  │    └─ collector.AddMesh()
  │
  ↓ FMeshPassProcessor            InitViews (Culling)
  ↓ BuildMeshDrawCommands()       ──────────────────>   Relevance Check
  ↓                                                       ↓
  ↓ GetElementShaderBindings()   ──────────────────>   FMeshDrawCommand 生成
  ↓   Bind LandscapeUniform     ──────────────────>   排序 (SortKey)
  ↓   Bind SectionLOD           ──────────────────>   Dynamic Instancing
  ↓                                                       ↓
  ↓ SubmitDrawBegin()           ──────────────────>   SetGraphicsPipeline
  ↓ SubmitDrawEnd()             ──────────────────>   DrawIndexedPrimitive
                                                          ↓
                                                    ┌─ VS ──────────────────────┐
                                                    │ 顶点 (4字节/顶点)         │
                                                    │ → Heightmap 采样 → 位移   │
                                                    │ → LOD Morph 插值          │
                                                    │ → 法线重建                │
                                                    │ → UV 生成 (3 套)          │
                                                    └──────────────────────────┘
                                                          ↓ 插值
                                                    ┌─ PS ──────────────────────┐
                                                    │ Per-Pixel Normal 采样     │
                                                    │ Weightmap 采样 → 层权重   │
                                                    │ Layer Weight 混合 PBR     │
                                                    │ → G-Buffer / SceneColor   │
                                                    └──────────────────────────┘
                                                          ↓
                                                    Deferred: Lighting Pass
                                                    Forward:  直接输出
```

---

## Virtual Heightfield Mesh (VHFM)

### 概述

VHFM 是 UE5 Experimental 插件，用一个 `AVirtualHeightfieldMesh` Actor 覆盖整张地形，以虚拟纹理页表驱动 GPU Compute Shader 动态裁剪并生成实例列表，最终发一次（或三次）`DrawIndexedIndirect` 完成全地形绘制。

与官方 Landscape 的核心区别：

| 维度 | 官方 Landscape | VHFM |
|------|--------------|------|
| Actor 粒度 | 每个 `ALandscapeStreamingProxy` 独立 | 一个 `AVirtualHeightfieldMesh` 覆盖全图 |
| DrawCall | N × Proxy × LOD 档 | 1 个 DrawIndexedIndirect |
| 几何来源 | 静态 VB（4 字节/顶点）+ 多套 LOD IB | **无 VB**，IB 共用，顶点完全靠 VertexId 计算 |
| 地形数据 | Weightmap / Heightmap UTexture2D | 虚拟纹理（Virtual Texture）页表 |
| 与 Nanite | 可以共存 | 与 Nanite 互斥，由插件自动切换 |

### CS Pipeline — 三步生成实例列表

每帧在 GPU 上顺序执行三个 Compute Shader：

```
InitBuffersCS
  - 初始化队列，种入最低 mip 的根节点
  ↓
CollectQuadsCS（持久线程，Work-Stealing 队列）
  - 遍历虚拟纹理页表四叉树
  - 对每个节点：视锥剔除 + 遮挡剔除 + 距离 LOD 判断
  - 满足分辨率 → 写入 QuadBuffer（待渲染列表）
  - 需要细分 → 压入 4 个子节点继续遍历
  ↓
InitInstanceBufferCS
  - 清零 IndirectArgs（instance count = 0）
  ↓
CullInstancesCS
  - 读 QuadBuffer，对每个 Quad 做最终视图剔除
  - 通过 → 写入 InstanceBuffer，AtomicAdd IndirectArgs 的 instance count
  - 输出 DrawIndexedIndirect 所需的 IndirectArgs + InstanceBuffer
```

`CollectQuadsCS` 使用持久线程 + groupshared 原子计数实现无锁 Work-Stealing，在 warp 粒度上分摊四叉树遍历的负载不均。

### 几何结构 — IB 有，VB 无

```cpp
// VirtualHeightfieldMeshVertexFactory.cpp:73
NumIndices = NumQuadsPerSide * NumQuadsPerSide * 6;  // 单 tile 拓扑，所有实例共用

// VirtualHeightfieldMeshVertexFactory.cpp:150
FVertexStream NullVertexStream;
NullVertexStream.VertexBuffer = nullptr;             // 无顶点数据
NullVertexStream.VertexStreamUsage = EVertexStreamUsage::ManualFetch;
```

- **IB**：一张静态索引缓冲，描述 `NumQuadsPerSide × NumQuadsPerSide` 的 quad grid 拓扑，`< 256` 用 uint16 否则 uint32
- **VB**：空流（ManualFetch），GPU 不从任何 VB 读属性，顶点位置完全由 VS 按 `VertexId` 和 `InstanceBuffer` 重建

### 顶点工厂 — GetVertexFactoryIntermediates

顶点着色器分三阶段重建每个顶点位置：

#### 阶段一：从 Instance 数据解析坐标

```hlsl
// VirtualHeightfieldMeshVertexFactory.ush:78
const QuadRenderInstance Item = InstanceBuffer[Input.InstanceId];
const uint2 Pos   = UnpackPos(Item);    // tile 在页表中的坐标
const uint  Level = UnpackLevel(Item);  // 虚拟纹理 mip 级（越大 = 越远 = 越粗）

// VertexId 在 GRID_SIZE×GRID_SIZE 网格里确定行列
float2 LocalUV = (float2)VertexCoord / (float)(GRID_SIZE - 1);   // [0,1] tile 内偏移

// Pos + LocalUV 合并得全局 XY；<< Level 因为粗级 tile 物理更大
float2 XY          = ((float2)Pos + LocalUV) * (float)(1u << Level);
float2 NormalizedPos = XY * VHM.PageTableSize.zw;  // 归一化到 [0,1]
```

#### 阶段二：LOD Morph（顶点 snap 到粗格）

```hlsl
// 粗采样高度 → 估算距摄像机距离 → 计算理想 LOD
float Height       = HeightTexture.SampleLevel(Sampler, LocalPhysicalUV, 0);
float LodForDistance = CalculateDistanceLod(DistanceSq, LodDistances);
float LodClamped   = clamp(LodForDistance - LodBias, (float)Level, VHM.MaxLod);

float LodMorphFloor = floor(LodClamped) - (float)Level;  // 需要向上 morph 几整级
float LodMorphFrac  = LodClamped - (LodMorphFloor + (float)Level);

LodMorphFrac = 0;  // 故意清零：连续 LOD 插值会让顶点偏离三角面，产生 shimmer，清零后只做整数级跳跃

// MorphVertex：将 LocalUV snap 到 LodMorphFloor 级更粗的格点
LocalUV      = MorphVertex(LocalUV, GRID_SIZE - 1, (uint)LodMorphFloor, LodMorphFrac);
XY           = ((float2)Pos + LocalUV) * (float)(1u << Level);
NormalizedPos = XY * VHM.PageTableSize.zw;
SampleLevel  = max(0, LodClamped - 0.5f);  // 连续 SampleLevel 用于高度采样
```

#### 阶段三：虚拟纹理精确采样，输出世界位置

```hlsl
// 在 floor/ceil 两个 mip 分别采样高度，再 lerp
float Height0 = HeightTexture.SampleLevel(Sampler, UV0, 0);  // floor(SampleLevel)
float Height1 = HeightTexture.SampleLevel(Sampler, UV1, 0);  // ceil(SampleLevel)
float Height  = lerp(Height0, Height1, frac(SampleLevel));

Intermediates.VTPos   = float3(NormalizedPos, Height);
Intermediates.LocalPos = mul(float4(VTPos, 1), VHM.VirtualHeightfieldToLocal).xyz;
```

完整数据流：

```
InstanceId → tile(Pos, Level, UVTransform)
    ↓
VertexId   → LocalUV（tile 内 [0,1] 坐标）
    ↓
粗采样高度 → 距离 → 理想 LOD → MorphVertex（snap 到粗格）
    ↓
虚拟纹理精确采样（floor/ceil mip lerp）→ 精确 Height
    ↓
VTPos(NormalizedPos, Height) → LocalPos → WorldPos
```

### HeightfieldMinMaxTexture — 三张预烘焙辅助纹理

`UHeightfieldMinMaxTexture` 资产包含三张纹理，是 VHFM GPU 剔除和 LOD 控制的数据基础：

#### Texture — 高度 Min/Max 金字塔

每个 texel 存该区域高度的 `(max, min)` 两个值，packed 为 RGBA8888（RG = max 的高 8 位/低 8 位，BA = min），解包还原 16-bit 精度：

```hlsl
// VirtualHeightfieldMesh.usf:117
float2 UnPackMinMaxHeight(float4 InPacked) {
    uint2 UnPackedScaled = uint2(PackedScaled.x << 8 | PackedScaled.y,
                                  PackedScaled.z << 8 | PackedScaled.w);
    return (float2)UnPackedScaled / 65535.f;
}
```

Mip 0 是原始分辨率；越高的 mip 覆盖越大区域，min 只会更小、max 只会更大——是保守包围。

**用途**：CollectQuadsCS / CullInstancesCS 用它构建 tile 的 **3D AABB**（含 Z 范围），做视锥剔除：

```hlsl
float2 MinMaxHeight = UnPackMinMaxHeight(HeightMinMaxTexture.SampleLevel(..., MinMaxTextureLevel));
float3 UVMin = float3(UV0, MinMaxHeight.x);
float3 UVMax = float3(UV1, MinMaxHeight.y);
bool bCull = !PlaneTestAABB(FrustumPlanes, UVCenter, UVExtent);
```

没有它只能用 2D 矩形剔除，无法利用高度信息，大量被山体遮挡的 tile 无法被裁掉。

#### LodBiasTexture — 地形粗糙度图

从高度 Min/Max 数据派生，每 texel 表示该位置的高度变化量（粗糙度）：

```cpp
// HeightfieldMinMaxTexture.cpp:78
uint16 HeightDiff = Max - Min;  // 高度差
// 归一化：HeightDiff / 全局最大高度差

// 20 次 ping-pong 模糊，限制相邻 texel 最大梯度
const uint32 NumBlurPasses = 20;
const uint16 MaxGradient = 65535 / 10;
// 每 pass：取 3×3 邻域最大值，当前值不得低于 MaxValue - MaxGradient
```

模糊的目的：防止相邻区域 LodBias 差值过大，超出 LOD Stitching 算法的缝合能力。

**用途**：VS 中按顶点采样，修正当前顶点的有效 LOD：

```hlsl
// VirtualHeightfieldMeshVertexFactory.ush:99
float LodBias  = GetLodBias(NormalizedPos, VHM.LodBiasScale);
// = max((LodBiasTexture.Sample - 0.05) * LodBiasScale - 1, 0)

float LodClamped = clamp(LodForDistance - LodBias, Level, MaxLod);
```

高度变化大（悬崖、山脊）→ `LodBias` 高 → `LodClamped` 偏低 → 该顶点 LOD 接近当前 Level，少做 morph，保留细节。平坦区域相反，减少不必要的精细采样。

#### LodBiasMinMaxTexture — LodBiasTexture 的 Min/Max 金字塔

结构与 Texture 相同，只是存的是 LodBias 值而非高度。

**用途**：CollectQuadsCS 用 tile 内的 `(min_bias, max_bias)` 范围修正细分门限：

```hlsl
// VirtualHeightfieldMesh.usf:284,309
float2 MinMaxLodBias = UnPackMinMaxLodBias(LodBiasMinMaxTexture.SampleLevel(...), LodBiasScale);

// 细分判断：减去 tile 内最大 LodBias，粗糙区更容易满足细分条件
bSubdivide = MinDistanceLod - MinMaxLodBias.y < (float)Level;

// feedback 预取范围：粗糙区多预取几个 mip
MinFeedbackLevel = floor(clamp(MinDistanceLod - MinMaxLodBias.y, Level, MaxLevel));
MaxFeedbackLevel = ceil (clamp(MaxDistanceLod - MinMaxLodBias.x, Level, MaxLevel));
```

结果：悬崖、山脊等高粗糙度区域 → 同等距离下使用更细的 tile，同时预取更多 mip。

#### 三者关系

```
高度图原始数据
    │
    ├─→ Texture              min/max 高度金字塔
    │                           → CollectQuadsCS：tile 3D AABB 视锥剔除
    │
    └─→ per-texel 高度差
           │
           └─→ 20 次 blur → LodBiasTexture
                               → VS：每顶点 LOD 偏移（粗糙区少 morph）
                               │
                               └─→ min/max 金字塔 → LodBiasMinMaxTexture
                                                       → CollectQuadsCS：细分门限 & VT feedback 范围
```

没有 MinMaxTexture 时，引擎使用 `GHeightMinMaxDefaultTexture`（1×1，min=0 max=1），剔除退化为保守 2D 矩形，LodBias 全为 0。

### 运行时渲染全流程 — 从 Actor 到像素（VHFM）

#### Phase 0: 注册 — Game Thread

```
UVirtualHeightfieldMeshComponent::CreateSceneProxy()
  ↓
FVirtualHeightfieldMeshSceneProxy 构造
  ├─ 持有 RuntimeVirtualTexture（虚拟纹理，含 HeightTexture / PageTableTexture）
  ├─ 持有 HeightMinMaxTexture / LodBiasTexture / LodBiasMinMaxTexture
  ├─ 读取 NumQuadsPerTileSide / LodBiasScale / NumForceLoadLods
  ├─ BuildOcclusionVolumes()  → CPU 端层级遮挡体（基于 MinMaxTexture 数据）
  └─ 创建 FVirtualHeightfieldMeshVertexFactory
       ├─ FVirtualHeightfieldMeshIndexBuffer（NumQuadsPerSide² × 6 个索引，静态）
       └─ NullVertexStream（ManualFetch，无实际顶点数据）
```

#### Phase 1: InitViews — GetDynamicMeshElements（注册工作 + 提交 MeshBatch）

`AllocatedVirtualTexture` 在 SceneProxy 构造时就已从 `RuntimeVirtualTexture->GetAllocatedVirtualTexture()` 取得（含 `PageTableTexture`），无需额外分配阶段。

```
FVirtualHeightfieldMeshSceneProxy::GetDynamicMeshElements()   ← InitViews 期间调用
  │
  ├─ AddWork(RHICmdList, Proxy, MainView, CullView)
  │    └─ 分配/复用 FDrawInstanceBuffers（InstanceBuffer + IndirectArgsBuffer）
  │         → 追加到 WorkDescs[]，等待后续 SubmitWork 填充
  │
  └─ 构造 FMeshBatch（此时 InstanceBuffer 尚未填充，GPU 在绘制时才读）
       ├─ VertexFactory        = FVirtualHeightfieldMeshVertexFactory（NullVertexStream）
       ├─ MaterialProxy        = Material（或 LODMaterials[i]，LOD_SEPARATE_DRAW 时）
       ├─ IndexBuffer          = FVirtualHeightfieldMeshIndexBuffer（单 tile 拓扑）
       ├─ IndirectArgsBuffer   = Buffers.IndirectArgsBuffer（CS 将写入 instance count）
       └─ UserData.InstanceBufferSRV = Buffers.InstanceBufferSRV（CS 将写入实例数据）
```

> **注**：`GetDynamicMeshElements` 期间 `bInFrame = false`，shadow 阶段再次调用时 `bInFrame = true`（BeginFrame 已触发），直接返回，故 **VHFM 不参与阴影渲染**。

#### Phase 2: GPU Compute — SubmitWork（PreRenderDelegate）

InitViews 完成后，引擎通过 `PreRenderDelegate` 触发 `BeginFrame`，此时执行 `SubmitWork`，按以下顺序向 RDG 提交 CS Pass：

```
① AddPass_TransitionAllDrawBuffers()      ← 所有输出 buffer 转换到写状态

② 对所有 WorkDesc：
   AddPass_InitInstanceBuffer()           ← 清零 IndirectArgs（instance count = 0）

③ 按 Proxy × MainView 循环：
   InitializeResources()                  ← 分配本帧 volatile 资源（QuadBuffer / FeedbackBuffer 等）
   AddPass_InitBuffers()                  ← 初始化四叉树队列，种入最低 mip 根节点
   AddPass_CollectQuads()                 ← 持久线程遍历页表四叉树
     ├─ 输入：PageTableTexture / HeightMinMaxTexture / LodBiasMinMaxTexture / OcclusionTexture
     ├─ 对每个节点：
     │    ├─ 视锥剔除：PlaneTestAABB（HeightMinMaxTexture 提供 3D AABB Z 范围）
     │    ├─ 遮挡剔除：OcclusionTexture.Load()
     │    ├─ 距离 LOD 判断（含 LodBias 修正）：bSubdivide = MinDistanceLod - MinMaxLodBias.y < Level
     │    ├─ 需细分 → 压入 4 个子节点到 RWQueueBuffer
     │    └─ 不细分 → 写入 RWQuadBuffer（Pos / Level / PhysicalAddress / bCull）
     └─ 写入 VT Feedback（通知虚拟纹理流送系统预加载所需 mip）
   SubmitVirtualTextureFeedbackBuffer()   ← 提交 feedback

④ 按 Proxy × CullView 循环：
   AddPass_CullInstances()                ← 最终视图剔除
     ├─ 读 QuadBuffer，对每个 Quad 做当前视图视锥剔除（主视图可复用 CollectQuads 结果）
     ├─ 通过 → 解包 PhysicalAddress → 计算 UVTransform（VT 物理 UV 偏移+缩放）
     ├─ 写入 RWInstanceBuffer（QuadRenderInstance: PosLevelPacked / UVTransform）
     └─ AtomicAdd RWIndirectArgsBuffer[instance count]
          （LOD_SEPARATE_DRAW 时：分写 RWLODInstanceBuffer0/1/2 及对应 IndirectArgs）

⑤ AddPass_TransitionAllDrawBuffers()      ← 所有输出 buffer 转换回读状态
```

至此 InstanceBuffer 和 IndirectArgsBuffer 已填充完毕，Phase 1 提交的 MeshBatch 可安全执行。

#### Phase 4: GPU Vertex Shader — 从 VertexId 重建位置

```
GetVertexFactoryIntermediates()
  │
  ├─ 从 InstanceBuffer[InstanceId] 读取 QuadRenderInstance
  │    └─ 解包 (Pos, Level, UVTransform)
  │
  ├─ VertexId → VertexCoord → LocalUV（tile 内 [0,1] 坐标）
  │
  ├─ [LOD Morph]
  │    ├─ 粗采样 HeightTexture → 估算世界坐标 → 计算 DistanceSq
  │    ├─ CalculateDistanceLod() → 理想 LOD
  │    ├─ GetLodBias() ← LodBiasTexture 采样 → 修正 LodClamped
  │    ├─ LodMorphFrac = 0（故意关闭连续 LOD，防止顶点偏离三角面产生 shimmer）
  │    └─ MorphVertex()：将 LocalUV snap 到更粗网格格点
  │
  └─ [精确高度采样]
       ├─ 虚拟纹理页表查询（floor/ceil SampleLevel 各一次）
       │    └─ TextureLoadVirtualPageTableLevel() → 物理 UV
       ├─ HeightTexture.SampleLevel × 2 → lerp → 精确 Height
       └─ mul(VTPos, VirtualHeightfieldToLocal) → LocalPos
```

#### Phase 5: GPU Pixel Shader — 材质求值

```
GetMaterialVertexParameters()
  └─ TexCoords[0..N] = LocalUV（NormalizedPos，即地形 [0,1] UV）
       → 所有材质 UV 坐标均为同一个值，材质节点按需使用

材质内部:
  ├─ 采样 PBRMaterialRVT（用 LocalUV 寻址）→ BaseColor / Normal / Roughness
  ├─ 采样 HeightRVT → 高度/位移信息
  └─ 输出到 G-Buffer（Deferred）或直接着色（Forward）
```

> VHFM 的 VS 不区分 Weightmap UV、Heightmap UV 等多套坐标（不同于 Landscape），所有 TexCoords 统一输出 `LocalUV`（`NormalizedPos`），具体采样逻辑完全由材质决定。

#### 完整数据流

```
CPU (Game Thread)                    Render Thread                          GPU
═════════════════                   ══════════════                         ═══

UVirtualHeightfieldMeshComponent
  ↓ CreateSceneProxy()
FVirtualHeightfieldMeshSceneProxy
  ├─ AllocatedVirtualTexture ───────→ PageTableTexture（CS 四叉树遍历）
  ├─ HeightMinMaxTexture ───────────→ CollectQuadsCS: 3D AABB 视锥剔除
  ├─ LodBiasMinMaxTexture ──────────→ CollectQuadsCS: 细分门限 & VT Feedback
  ├─ LodBiasTexture ───────────────→ VS: 每顶点 LOD 偏移
  ├─ OcclusionTexture ─────────────→ CollectQuadsCS: 遮挡剔除
  └─ IndexBuffer (静态) ───────────→ DrawIndexedIndirect: 单 tile 拓扑

  ── InitViews ──────────────────────────────────────────────────────────────
  GetDynamicMeshElements()
    ├─ AddWork() → WorkDescs[] 追加
    └─ FMeshBatch（InstanceBuffer 此时为空）

  ── PreRenderDelegate (BeginFrame / SubmitWork) ────────────────────────────
                                    InitInstanceBuffer (清零 IndirectArgs)
                                    InitBuffers (种入根节点)
                                    CollectQuadsCS ──────────────────────→ 四叉树遍历
                                      → RWQuadBuffer（候选 tile）
                                      → VT Feedback（流送预加载）
                                    CullInstancesCS ─────────────────────→ 最终剔除
                                      → RWInstanceBuffer（实例列表）
                                      → RWIndirectArgsBuffer（instance count）

  ── Draw Pass ──────────────────────────────────────────────────────────────
                                                                    DrawIndexedIndirect
                                                                      ↓
                                                               ┌─ VS ──────────────────────┐
                                                               │ InstanceId → QuadRenderInstance│
                                                               │ VertexId   → LocalUV      │
                                                               │ LOD Morph  → snap 到粗格  │
                                                               │ VT 精确采样 → Height      │
                                                               │ → LocalPos / WorldPos     │
                                                               └───────────────────────────┘
                                                                      ↓ 插值
                                                               ┌─ PS ──────────────────────┐
                                                               │ TexCoords = LocalUV       │
                                                               │ 采样 PBRMaterialRVT       │
                                                               │ → BaseColor/Normal/Roughness│
                                                               │ → G-Buffer / SceneColor   │
                                                               └───────────────────────────┘
```

### DrawCall 结构

| 状态 | 主视角 DrawCall 数 |
|------|--------------|
| 官方 Landscape | N × Proxy（大世界可达数十至上百） |
| `r.VHM.Enable=1`，默认 | **1 个** DrawIndexedIndirect，全地形单 Material |

---

## Nanite Landscape

### 概述

当 `ALandscape.bEnableNanite = true` 时，地表渲染从 `FLandscapeComponentSceneProxy` 切换到 Nanite 路径。Heightmap 在编辑器中被编译为 Nanite-enabled `UStaticMesh`，运行时由 `Nanite::FSceneProxy` 接管，完全绕开传统 Landscape 的 LOD 系统、共享顶点缓冲和 LandscapeRenderSystem。

与传统 Landscape 和 VHFM 的核心对比：

| 维度 | 传统 Landscape | VHFM | Nanite Landscape |
|------|-------------|------|----------------|
| Scene Proxy | `FLandscapeComponentSceneProxy` | `FVirtualHeightfieldMeshSceneProxy` | `Nanite::FSceneProxy` |
| 几何来源 | 运行时 VS 采样 Heightmap | GPU CS 按帧重建 | 编辑器预编译 Nanite Mesh（顶点写死真实坐标） |
| LOD | CPU 8 级 per-component | GPU 四叉树 + VT 页表 | 像素级自动（Cluster BVH + HZB） |
| 光栅化输出 | G-Buffer（直接） | G-Buffer（直接） | VisBuffer → Deferred 材质求值 → G-Buffer |
| 阴影 | 传统 Shadow Depth Pass | **不参与阴影** | Nanite Shadow Pass |
| Displacement | VS 实时采样 Heightmap | — | 可选 Nanite Tessellation（`r.Nanite.Tessellation=1`） |

### Actor 结构

```
ALandscape
  ├── bEnableNanite = true
  └── bNaniteUnifiedMaterial          ← true = 全部 Proxy 共用一个材质，不做 per-LOD 覆盖

ALandscapeProxy（每个 StreamingProxy）
  ├── LandscapeComponents[]           ← 传统组件，Nanite 开启时仅用于编辑期数据
  ├── NaniteComponents[]              ← TArray<ULandscapeNaniteComponent*>，渲染主体
  └── CollisionComponents[]           ← 碰撞，与渲染路径无关
```

`ULandscapeNaniteComponent` 继承自 `UStaticMeshComponent`（`LandscapeNaniteComponent.h:82`），持有一个由 Heightmap 烘焙而来的 Nanite-enabled `UStaticMesh`，并重写 `CreateSceneProxy()` 以走 Nanite 路径。

### 编辑期构建 — UpdateNaniteRepresentation

Heightmap 变化或强制重建时触发：

```
ALandscapeProxy::UpdateNaniteRepresentation(InTargetPlatform)  (Landscape.cpp:542)
  ↓
ULandscapeNaniteComponent::InitializeForLandscape(
    Proxy, NewProxyContentId, InComponentsToExport, NaniteComponentIndex)
       (LandscapeNaniteComponent.h:154)
  ├── 遍历 InComponentsToExport（ULandscapeComponent 数组）
  ├── 读取各组件 Heightmap (G16)，将高度解码为真实世界坐标
  ├── 按 QuadSize 生成三角网格（顶点 WorldPosition 直接写死，不再靠 VS 实时采样）
  ├── 标记 StaticMesh.bSupportNaniteDisplacementMesh = true（可选）
  ├── StaticMesh Build → 生成 Nanite Cluster 层级 + BVH + StreamingData
  └── ProxyContentId (FGuid) 用于增量检测，内容未变则跳过重建

// 异步版本：
ALandscapeProxy::UpdateNaniteRepresentationAsync()  → FGraphEventRef
ALandscapeProxy::InvalidateNaniteRepresentation(bInCheckContentId)  → 强制失效
```

**关键区别**：传统 Landscape 顶点 = 4 字节网格坐标，运行时 VS 采样 Heightmap 得到真实高度；Nanite Mesh 顶点在 Build 时已写入完整世界坐标，运行时 **VS 不再采样 Heightmap**，几何数据完全来自 Cluster AttributeBuffer。

### 运行时渲染全流程 — 从 Actor 到像素（Nanite Landscape）

#### Phase 0: 注册 — Game Thread

```
ULandscapeNaniteComponent::CreateSceneProxy()   (LandscapeNaniteComponent.h:174 override)
  ↓
UStaticMeshComponent::CreateSceneProxy()
  └── StaticMesh->HasValidNaniteData() == true
      → 创建 Nanite::FSceneProxy（而非 FStaticMeshSceneProxy）
           ├── 上传 ClusterData / HierarchyBuffer → GPU Scene NaniteData
           ├── 提交 FPrimitiveSceneInfo → GPU Scene PrimitiveBuffer（常驻 GPU）
           └── 绑定 ULandscapeMaterialInstanceConstant（含 WeightmapTextures 参数）
                  ULandscapeNaniteComponent::UpdateMaterials()  (LandscapeNaniteComponent.h:125)
```

此后该 Proxy **不注册到 `FLandscapeRenderSystem`**，LOD 完全由 Nanite 内部 Cluster BVH 驱动。

#### Phase 1: GPU Culling — InitViews

Nanite 不走 `ComputeSectionsLODForView`，而是 GPU 驱动的两级剔除（`NaniteCullRaster.h`）：

```
FNaniteVisibility::BeginVisibilityQuery(...)  (NaniteVisibility.h:121)
  ↓
① Instance 级剔除（per ALandscapeProxy）
  ├── Frustum 剔除（BBox vs. 视锥平面）
  ├── HZB 遮挡剔除（Hierarchical Z-Buffer）
  └── 输出：通过实例列表 → 提交 Cluster 遍历任务

② Cluster 级剔除（per Cluster Group，BVH 层级遍历）
  ├── Cluster AABB vs. Frustum
  ├── HZB 遮挡
  └── 是否满足当前屏幕像素密度 → 选择叶节点 Cluster

输出：
  FNaniteRasterPipelines — 每个 RasterBin 对应一种光栅化管道配置
  DrawIndirectArgs       — 每个 Cluster 一个 HW 或 SW 光栅化任务
```

#### Phase 2: Nanite 光栅化 — VisBuffer

Nanite 双路径光栅化，输出 VisBuffer（可见性缓冲）而非直接写 G-Buffer（`FNaniteRasterPipeline`，`NaniteShared.h:538`）：

```
对每个通过剔除的 Cluster，按三角形面积分流：

[大三角形路径] Hardware Rasterizer
  DrawIndirectPrimitive → 传统 VS/PS
  PS 仅执行一次原子写：InterlockedMax(VisBuffer[pixel], PackedDepth|ClusterTriIdx)

[小三角形路径] Software Rasterizer (Compute Shader)
  每个 CS 线程处理若干 sub-pixel 三角形
  → InterlockedMax 原子竞争写入 VisBuffer
  → 避免 HW 光栅化最小 2×2 quad 的 overdraw 浪费（micropolygon 场景收益显著）

[Displacement 路径]（r.Nanite.Tessellation=1 且 r.Nanite.ProgrammableRaster=1 且 r.Nanite.ComputeRasterization=1，材质含 Displacement 输出时）
  光栅化前先执行 Tessellation CS：
  FNaniteRasterPipeline.bDisplacementEnabled = true  (NaniteShared.h:547)
  → 对叶节点 Cluster 细分三角形 → 按材质 Displacement 值位移新顶点
  → 再走 HW/SW 光栅化写 VisBuffer
```

VisBuffer 每像素存储（`UlongType` = `uint2`，即 64 位）：

```
低 32 位 (.x)：
  [31]    bIsImposter（NANITE_IMPOSTERS_SUPPORTED 时有效）
  [30..7] VisibleClusterIndex（24 位，写入时 +1 以区分空像素）
  [6..0]  TriIndex（7 位，cluster 内三角形索引）

高 32 位 (.y)：
  [31..0] DepthInt（32 位深度）
```

解包函数：`UnpackVisPixel(Pixel, DepthInt, VisibleClusterIndex, TriIndex, bIsImposter)`
（`NaniteDataDecode.ush:861`）

每像素**只存索引**，不存插值属性。

#### Phase 3: 材质分类 — Shading Bins

VisBuffer 填完后，先在单独的 Mask Buffer 中写入每像素的 ShadingBin，再由 **ShadeBinning**（`NaniteShadeBinning.usf`）三 Pass 完成分组（`FNaniteShadingPipelines`，`NaniteShared.h:883`）：

```
① COUNT  Pass（CS）
  ├── 遍历所有像素的 Mask Buffer，读取 ShadingBin（14 位，由材质槽索引预计算）
  └── 对每个 Bin 原子累计像素数

② RESERVE Pass（CS）
  └── prefix sum → 为每个 Bin 分配连续的像素列表空间

③ SCATTER Pass（CS）
  ├── 再次遍历所有像素，将像素坐标写入对应 Bin 的列表
  └── Tile 粒度：SHADING_BIN_TILE_SIZE = 8 或 32（由 BINNING_TECHNIQUE 决定）

FNaniteVisibilityResults::IsShadingBinVisible(uint16 BinIndex)  (NaniteVisibility.h:19)
  → 可见性剔除：当前帧不可见的 Bin 直接跳过求值
```

#### Phase 4: VisBuffer Decode + 材质求值

每个 Shading Bin 派发一次 Compute Shader（或 Graphics Pass）处理其 TileList：

```
对 Bin 内每个像素：

① DecodeVisBuffer：
  ├── 读 VisBuffer64 → TriangleIndex + ClusterIndex + PackedDepth
  ├── 从 GPU Scene PrimitiveBuffer 读 InstanceTransform
  ├── 从 Nanite ClusterData.AttributeBuffer 读三顶点属性：
  │    └── Position(baked world coords) / UV / TangentBasis
  └── Barycentric 插值 → WorldPosition / LayerTexCoord / WeightmapTexCoord / TangentBasis

② 材质 PS 求值（与传统 Landscape 复用同一材质）：
  ├── 用 WeightmapTexCoord 采样 WeightmapTextures → 各层权重
  ├── LandscapeLayerWeight 节点按权重混合各层 PBR 属性
  │    (BaseColor / Normal / Roughness / Metallic / AO)
  └── 输出 → G-Buffer（Deferred Shading）或 SceneColor（Forward）
```

> **与传统 Landscape PS 的差异**：传统路径的 WeightmapTexCoord 由 VS 插值传入（`FLandscapeVertexFactoryPixelShaderParameters`）；Nanite 路径在 PS/CS 中从 AttributeBuffer + Barycentric 重建，但 `LandscapeLayerWeight` 材质节点表达式相同，**同一材质资产可以在两种路径下复用**，无需区分。

#### 完整数据流

```
CPU (Game Thread)                           GPU
═════════════════                          ════════════════════════════════════════════

─── 编辑期 ─────────────────────────────────────────────────────────────────────────
ALandscapeProxy::UpdateNaniteRepresentation()
  → ULandscapeNaniteComponent::InitializeForLandscape()
       读 Heightmap → 生成三角网格（顶点写真实世界坐标）
       → Nanite Build（Cluster 层级 + BVH + StreamingData）
       → UStaticMesh 存盘

─── 运行时注册 ──────────────────────────────────────────────────────────────────────
ULandscapeNaniteComponent::CreateSceneProxy()
  → Nanite::FSceneProxy
       ├── ClusterData / HierarchyBuffer → GPU Scene NaniteData
       ├── PrimitiveBuffer（InstanceTransform 常驻 GPU）
       └── WeightmapTextures 绑定到 ULandscapeMaterialInstanceConstant

─── 每帧 InitViews ──────────────────────────────────────────────────────────────────
                                    GPU Culling (CS)
                                    Instance BBox Frustum+HZB
                                      → Cluster BVH Frustum+HZB
                                        → DrawIndirectArgs（HW/SW 光栅化任务分发）

─── Nanite 光栅化 ───────────────────────────────────────────────────────────────────
                                   [大三角形] HW Rasterizer
                                   [小三角形] SW Rasterizer (CS, InterlockedMax)
                                   [Displacement] Tessellation CS → 细分 + 位移（可选）
                                                      ↓
                                           VisBuffer[每像素 uint64]
                                           PackedDepth | TriIdx | ClusterIdx

─── 材质分类 ────────────────────────────────────────────────────────────────────────
                                   ClassifyMaterials CS
                                     → MaterialBinData（per ShadingBin TileList）

─── 材质求值 ────────────────────────────────────────────────────────────────────────
                                   per ShadingBin CS / Shading Pass：
                                     DecodeVisBuffer
                                       → AttributeBuffer + Barycentric
                                         → WorldPos / WeightmapTexCoord / TangentBasis
                                     材质 PS：
                                       WeightmapTextures 采样 → 层权重
                                       LayerWeight 混合 PBR
                                         → G-Buffer / SceneColor
```

### 关键 CVar

| CVar | 默认值 | 作用 |
|------|------|------|
| `landscape.NaniteEnabled` | 1 | 全局开关，0 = 回退到传统 Landscape |
| `r.Nanite.Tessellation` | 0 | Nanite 位移细分总开关（同时需要下面两项） |
| `r.Nanite.ProgrammableRaster` | 1 | 可编程光栅化，Tessellation 的前提 |
| `r.Nanite.ComputeRasterization` | 1 | Compute Shader 软光栅，Tessellation 的前提 |
| `r.Nanite.MaxPixelsPerEdge` | 1.0 | 控制 HW/SW 光栅化切换阈值（越小越多走 SW） |
| `r.Nanite.Streaming.MaxStreamingPages` | — | Nanite Cluster 流送页数上限 |

---

## UE 渲染管线 — 类比 Unity URP

### 核心概念映射

| Unity URP | UE 对应 | 说明 |
|-----------|---------|------|
| `CameraData` | `FViewInfo` | 一个视角的所有渲染状态 |
| `RenderingData` | `FScene` + `FSceneRenderer` | 全局场景 + 渲染器 |
| `RendererList` (culling 结果) | `FMeshBatch` + `FVisibleLightViewInfo` | 可见物体/灯光列表 |
| `ScriptableRenderPass` | RDG Pass (FRDGBuilder) | 一个渲染 Pass |
| `RenderPipelineAsset` | `FSceneRenderer` 子类 | 管线选择 (Deferred / Mobile) |
| `LightData` / `_AdditionalLights` | `FForwardLightUniformParameters` | Forward 灯光参数 |
| `OcclusionCulling` | `FHZBOcclusionTester` / `FOcclusionQueryBatcher` | HZB 遮挡查询 |

### Deferred 管线对比

```
Unity URP Deferred                    UE FDeferredShadingSceneRenderer::Render
──────────────────                    ────────────────────────────────────────
SetupCameraProperties                 InitViews (culling + visibility)
    ↓                                     ↓
Culling (frustum+occlusion)              ↓ (内含 HZB 遮挡)
    ↓                                     ↓
DepthPrepass                           RenderPrePass (HiZ early-Z)
    ↓                                     ↓
                                       Velocity Pass (TAA/TSR 运动矢量)  ← UE 独有
                                           ↓
Shadow Maps                           RenderShadowDepthMaps (CSM/VSM/PerObject)
    ↓                                     ↓
GBuffer Pass (MRT)                    RenderBasePass (G-Buffer MRT:
    ↓                                   WorldColor/Normal/Metallic/Roughness/AO/...)
Deferred Lighting (full-screen)          ↓
    ↓                                 Substrate 材质分类 + DBuffer Decals ← UE 独有
                                           ↓
                                       RenderDiffuseIndirectAndAmbientOcclusion
                                           ↓
                                       RenderLights (逐光全屏 Light Volume)
                                           ↓
                                       RenderDeferredReflectionsAndSkyLighting
    ↓                                     ↓
Forward-only pass                      (Hair / RayTracing — UE 独有)
    ↓                                     ↓
Skybox                                 RenderSkyAtmosphere + RenderFog
    ↓                                     ↓
Transparent (back-to-front)            RenderTranslucency (分层: AfterDOF/BeforeDOF/...)
    ↓                                     ↓
Post-processing (SRP Feature)          PostProcessing (TSR/TAA → Bloom → Tonemap → ...)

UE 独有子系统（Unity 没有直接对应）:
  Lumen (GI + Reflections)  — 在 BasePass 后异步计算
  Nanite (虚拟几何)          — 自带 VisBuffer 管线，不经过传统 BasePass
  Virtual Shadow Maps        — 自适应分辨率阴影
  Volumetric Cloud/Fog       — 体积云雾
  MegaLights                 — GPU-driven 大量灯光
```

### Forward (Mobile) 管线对比

```
Unity URP Forward                     UE FMobileSceneRenderer::Render
──────────────────                    ──────────────────────────────────
SetupCameraProperties                 InitViews
    ↓                                     ↓
Culling                                 ↓
    ↓                                     ↓
DepthPrepass (optional)               RenderFullDepthPrepass
    ↓                                     ↓
Shadow Maps                           RenderShadowDepthMaps
    ↓                                     ↓
                                      RenderHZB + RenderAmbientOcclusion
                                          ↓
                                      RenderMobileShadowProjections ← CSM 投影到屏幕
                                          ↓
SetupLights (_AdditionalLights)       PrepareForwardLightData (Light Grid Culling)
    ↓                                     ↓
Opaque Forward (lighting in shader)   RenderForward (逐物体计算灯光)
    ↓                                     ↓
Skybox                                RenderSkyAtmosphere
    ↓                                     ↓
Transparent                           RenderTranslucency
    ↓                                     ↓
Post-processing                       AddMobilePostProcessingPasses
```

**关键区别**：URP Forward 在 `DrawObjects` 时把灯光数据传进 shader 一次性算完；UE Mobile Forward 类似，但多了一步 `RenderMobileShadowProjections` 把 CSM 阴影投影到屏幕空间纹理，BasePass shader 里采样这张纹理。

### 从 SceneRendering.h 看关键数据结构

```
FScene (场景)
 ├── FViewInfo[] (每视角)
 │    ├── FViewElementList (view-unique 渲染元素)
 │    ├── FVisibleLightViewInfo[] (该视角可见灯光)
 │    │    ├── ProjectedShadowVisibilityMap (哪些阴影可见)
 │    │    └── bInViewFrustum / bInDrawRange
 │    ├── FForwardLightingViewResources (Forward 灯光 Grid)
 │    │    ├── CulledLightDataGridSRV (裁剪后的灯光数据)  ≈ Unity _AdditionalLights
 │    │    └── NumCulledLightsGridSRV (灯光数量 Grid)     ≈ Unity light count per tile
 │    ├── FTemporalAAHistory / FTSRHistory (TAA/TSR 历史)
 │    └── FVolumetricFogViewResources (体积雾)
 │
 ├── FVisibleLightInfo[] (全局灯光)
 │    ├── AllProjectedShadows (所有投影阴影)
 │    ├── VirtualShadowMapClipmaps (VSM)
 │    └── OccludedPerObjectShadows (被遮挡的逐物体阴影)
 │
 ├── FGlobalDistanceFieldInfo (全局 SDF)    ← Lumen/GI 用
 │    ├── Clipmaps (级联 SDF 体积纹理)
 │    └── PageAtlasTexture / PageTableCombinedTexture
 │
 └── FOcclusionQueryBatcher (遮挡查询)      ≈ Unity Occlusion Culling
      ├── BatchOcclusionQueries (批量查询)
      └── FFrameBasedOcclusionQueryPool (帧级查询池)
```

### URP RenderFeature vs UE RDG 自定义 Pass

| 概念 | Unity URP | UE |
|------|-----------|-----|
| 注册自定义 Pass | `RenderFeature` 挂到 `RenderPipelineAsset` | `FSceneViewExtension` / `ISceneViewExtension` |
| Pass 注入点 | `RenderPassEvent` 枚举 (BeforeRenderingOpaques, AfterRendering, ...) | `FSceneRenderer::Render()` 中各阶段间的 Hook |
| Pass 实现 | `Execute()` 里调 `context.DrawRenderers()` | `FRDGBuilder::AddPass()` + `RHICmdList.Draw*()` |
| 中间纹理 | `RenderTargetHandle` / `RTHandle` | `FRDGTextureRef` (RDG 自动管理生命周期) |
| 帧缓冲 | `RTHandle` (显式分配) | `FSceneTextures` / `FSceneTexturesConfig` (统一管理 G-Buffer + SceneColor + Depth) |

### DrawCall 创建流程对比

这是两套渲染器最核心的差异：Unity 用一个 `context.DrawRenderers()` 封装了所有逻辑，UE 把每个阶段拆成显式步骤。

#### Unity URP DrawCall 流程

```
Renderer (MonoBehaviour)
  ↓ context.Cull()
CullingResults (内置遮挡剔除)
  ↓ 创建 DrawingSettings + FilteringSettings
context.DrawRenderers()
  ↓ 内部自动执行:
  ├── 按材质/Shader 分组 (SRP Batcher: 按 Shader Variant 合批)
  │     - 同 Shader Variant 的物体共享 Pipeline State
  │     - 每个材质一份 CB (MaterialPropertyBlock) → per-draw 绑定
  ├── GPU Instancing (同 Mesh + 同 Material → DrawInstanced)
  ├── 动态合批 (小 Mesh + 同 Material → 合并 VB/IB)
  └── 逐 DrawCall 提交:
        cmd.SetRenderTarget()
        cmd.DrawMesh() / cmd.DrawMeshInstanced()
          ↓
        RHI Draw Call
```

**特点**：`DrawRenderers()` 是黑盒，内部排序、合批、提交一气呵成。SRP Batcher 按 Shader Variant 合批，每个材质独立 CB，避免频繁切换材质参数。

#### UE DrawCall 流程

```
FPrimitiveSceneProxy (注册到场景)
  ↓ InitViews
ComputeRelevance() → GetViewRelevance() → 确定该物体参与哪些 Pass
  ↓ 标记可见性
StaticMeshVisibilityMap / DynamicMeshElements[]
  ↓ 逐 Pass 处理
FParallelMeshDrawCommandPass::DispatchPassSetup()
  ↓
FMeshPassProcessor::AddMeshBatch(FMeshBatch)
  ↓
BuildMeshDrawCommands<PassShaders>()
  ├── 获取材质 Shader (VS/PS/GS)
  ├── 创建最小管线状态 (Blend/RS/DS) → FGraphicsMinimalPipelineStateId (PSO Hash)
  ├── FMeshDrawCommand 初始化:
  │     - ShaderBindings (UB/SRV/Sampler)
  │     - VertexStreams (VB 绑定 + Offset)
  │     - IndexBuffer
  │     - CachedPipelineId (PSO ID)
  │     - FirstIndex / NumPrimitives / NumInstances
  └── SetDrawParametersAndFinalize()
  ↓
排序 FCompareFMeshDrawCommands
  ├── Primary: SortKey (VS Hash / PS Hash / Priority / Distance)
  └── Secondary: StateBucketId (Dynamic Instancing: 同 PSO + 同 VB Layout → 合并实例)
  ↓
GPU Scene Instance Culling (可选, Compute Shader)
  ├── 按 ScreenSize / Bounds 剔除实例
  ├── 写入可见实例 ID 到 GPU Buffer
  └── 填充 Indirect Draw Args
  ↓
SubmitDrawBegin() → SetGraphicsPipeline + Bind VB/IB/ShaderBindings
SubmitDrawEnd()   → DrawIndexedPrimitive / DrawIndexedIndirect
  ↓
RHI Draw Call
```

**特点**：每个阶段显式可控。静态物体的 `FMeshDrawCommand` 跨帧缓存，仅动态物体每帧重建。GPU Scene 让所有 Primitive 数据常驻 GPU，Instance Culling 在 GPU 端完成。

#### 关键差异对照

| 维度 | Unity URP | UE |
|------|-----------|-----|
| **DrawCall 入口** | `context.DrawRenderers()` 单一入口 | `FParallelMeshDrawCommandPass` 逐 Pass 显式设置 |
| **合批策略** | SRP Batcher: 按 Shader Variant，per-Material CB | SortKey 排序 + StateBucketId 动态实例化 |
| **GPU Instancing** | 同 Mesh + 同 Material 自动实例化 | GPU Scene 驱动，Compute Shader 实例剔除后 Indirect Draw |
| **管线状态缓存** | 每帧隐式管理 | `FMeshDrawCommand` 跨帧缓存（静态物体不重建） |
| **PSO 管理** | 运行时按需编译，Shader Warmup 预热 | `FGraphicsMinimalPipelineStateId` Hash，PSO Precache 预编译 |
| **GPU Scene** | 无（CPU 端逐 DrawCall 绑定 per-Object 数据） | 有（`GPUScene` Buffer 常驻 GPU，Shader 直接索引） |
| **排序粒度** | Queue 级别 (Opaque/AlphaTest/Transparent) | SortKey 级别 (VS Hash + PS Hash + Priority + Distance) |
| **动态物体** | 每帧全部重建 | `FDynamicPassMeshDrawListContext` 每帧重建，静态物体复用 |
| **间接绘制** | `DrawMeshInstancedIndirect` 手动调用 | GPU Instance Culling 自动生成 Indirect Args |

#### 核心类映射

| Unity URP | UE | 说明 |
|-----------|-----|------|
| `DrawingSettings` (shader pass + sort mode) | `FMeshPassProcessor` 子类 | 定义当前 Pass 用哪些 Shader、什么排序 |
| `FilteringSettings` (layer + render queue) | `FViewInfo::StaticMeshVisibilityMap` + Relevance | 确定哪些物体参与绘制 |
| `RenderStateBlock` | `FGraphicsMinimalPipelineState` | Blend/DepthStencil/Rasterizer 状态 |
| `MaterialPropertyBlock` | `FMeshDrawCommand::ShaderBindings` | per-DrawCall 参数绑定 |
| `Shader` + `Pass` | `FMeshMaterialShader` + `FVertexFactoryType` | Shader 选择和编译 |
| `Renderer.SetPass()` 内部排序 | `FMeshDrawCommandSortKey` | 显式 64-bit 排序键 |
| SRP Batcher per-Material CB | GPU Scene `PrimitiveBuffer` | per-Object 数据绑到 GPU |
| `CommandBuffer.DrawMesh*` | `FMeshDrawCommand::SubmitDraw*` | 最终 RHI 提交 |

**RDG 的优势**：Unity URP 需要手动 `cmd.GetTemporaryRT` / `cmd.ReleaseTemporaryRT` 管理 RT 生命周期；UE 的 RDG（Render Dependency Graph）自动推导资源屏障和生命周期，`GraphBuilder.AddPass()` 时声明输入/输出纹理即可，不需要手动插屏障。

---

## 关键源码速查表

| 子系统 | 关键文件 | 路径 |
|--------|---------|------|
| **核心数据** | `Landscape.h` | `Runtime/Landscape/Public/` |
| | `LandscapeProxy.h` | `Runtime/Landscape/Public/` |
| | `LandscapeComponent.h` | `Runtime/Landscape/Public/` |
| | `LandscapeLayerInfoObject.h` | `Runtime/Landscape/Public/` |
| **EditLayer 系统** | `LandscapeEditLayer.h` | `Runtime/Landscape/Public/` |
| | `LandscapeEditLayerRenderer.h` | `Runtime/Landscape/Private/` |
| | `LandscapeEditLayerMergeContext.h` | `Runtime/Landscape/Private/` |
| **编辑模式** | `LandscapeEdMode.h` | `Editor/LandscapeEditor/Public/` |
| | `LandscapeEdModeTools.h` | `Editor/LandscapeEditor/Public/` |
| | `LandscapeToolInterface.h` | `Editor/LandscapeEditor/Public/` |
| **绘制工具** | `LandscapeEdModePaintTools.cpp` | `Editor/LandscapeEditor/Private/` |
| **数据访问** | `LandscapeEdit.h` | `Runtime/Landscape/Public/` |
| | `LandscapeDataAccess.h` | `Runtime/Landscape/Public/` |
| **渲染** | `LandscapeRender.h` | `Runtime/Landscape/Private/` |
| **Nanite 地表** | `LandscapeNaniteComponent.h` | `Runtime/Landscape/Classes/` |
| | `Landscape.cpp` (UpdateNaniteRepresentation) | `Runtime/Landscape/Private/` |
| **Nanite 渲染** | `NaniteCullRaster.h` (IRenderer, FRasterContext) | `Runtime/Renderer/Private/Nanite/` |
| | `NaniteShared.h` (FNaniteRasterPipeline/ShadingPipeline) | `Runtime/Renderer/Private/Nanite/` |
| | `NaniteVisibility.h` (FNaniteVisibility, FNaniteVisibilityResults) | `Runtime/Renderer/Private/Nanite/` |
| | `NaniteMaterials.h` (FNaniteMaterialSlot, ShadingBin) | `Runtime/Renderer/Private/Nanite/` |
| **渲染管线** | `SceneRendering.h` | `Runtime/Renderer/Private/` |
| | `DeferredShadingRenderer.cpp` | `Runtime/Renderer/Private/` |
| | `MobileShadingRenderer.cpp` | `Runtime/Renderer/Private/` |
| **DrawCall** | `MeshPassProcessor.h` | `Runtime/Renderer/Public/` |
| | `MeshDrawCommands.h/.cpp` | `Runtime/Renderer/Private/` |
| | `SceneVisibility.cpp` | `Runtime/Renderer/Private/` |
| **材质表达式** | `MaterialExpressionLandscapeLayerWeight.h` | `Runtime/Engine/Classes/Materials/` |
| | `MaterialExpressionLandscapeLayerSample.h` | `Runtime/Engine/Classes/Materials/` |
| **UI/Details** | `LandscapeEditorObject.h` | `Editor/LandscapeEditor/Public/` |

---

## 总结

UE 地表绘制系统遵循清晰的 **垂直切片模式**：

1. **CPU 编辑端**（Texture Mip Lock）负责笔画数据的直接写入
2. **GPU 合并端**（RDG Render + EditLayer Merge）负责多层垂直叠加
3. **运行时渲染端** 根据项目配置走三条路径之一：
   - **传统 Landscape**（`FLandscapeComponentSceneProxy`）：CPU 8 级 LOD + VS Heightmap 采样 + Weightmap LayerWeight 混合 → G-Buffer
   - **VHFM**（`FVirtualHeightfieldMeshSceneProxy`）：GPU CS 四叉树按帧重建实例列表 → `DrawIndexedIndirect` 1 个 DC → VS 从 VT 精确采样高度 → G-Buffer
   - **Nanite Landscape**（`Nanite::FSceneProxy`）：Heightmap 预编译为 Nanite Mesh → GPU Cluster BVH 剔除 → VisBuffer 双路径光栅化 → Deferred 材质求值 → G-Buffer

Actor 层通过 `ALandscapeProxy` → `ALandscape` + `ALandscapeStreamingProxy` 的 Proxy 模式支持世界分区流式加载，`ALandscape` 作为共享数据的权威源，`ALandscapeStreamingProxy` 按空间持有组件并引用主 Actor。开启 Nanite 时，每个 `ALandscapeStreamingProxy` 还持有 `ULandscapeNaniteComponent`，其中存储编辑器预编译的 Nanite Mesh，运行时完全绕开传统 Landscape 的 LOD 系统。

渲染管线方面，UE 在结构上和 URP Deferred 非常相似（PrePass → GBuffer → Lighting → Translucency → PostProcess），但 UE 多了 Lumen（GI）、Nanite（虚拟几何）、VSM（虚拟阴影）、TSR（时序超分）等 GPU-driven 大系统。RDG 的存在让 UE 可以像 URP 的 ScriptableRenderPass 一样注入自定义 Pass，但资源管理更自动化。

DrawCall 创建方面，Unity URP 的 `context.DrawRenderers()` 是一站式黑盒（SRP Batcher 按 Shader Variant 合批），UE 则将整个过程拆成显式阶段：Relevance 判定 → FMeshPassProcessor 生成 FMeshDrawCommand → SortKey 排序 → Dynamic Instancing 合并 → GPU Scene Instance Culling → SubmitDraw。UE 的优势在于静态 DrawCommand 跨帧缓存、GPU Scene 常驻 per-Object 数据、Compute Shader 实例剔除后 Indirect Draw，这些是 Unity 没有的。