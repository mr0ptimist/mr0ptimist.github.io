+++
date = '2026-05-25T00:00:00+08:00'
draft = false
title = 'UE5 渲染踩坑录'
tags = ['UE5', 'DXC', 'HLSL', 'Shader', 'VertexFactory', 'RenderDoc', 'ShaderParameter', 'MeshBatch', 'FShaderParameter', 'Rendering', 'UniformBuffer', 'BasePass', 'SceneTextures', 'USF', 'SingleLayerWater']
categories = ['图形渲染']
+++

> 持续更新。记录开发中遇到的非显而易见的 UE5 渲染 bug、陷阱和反直觉行为，附根因分析和修法。

---

## 一、DXC Loose Global 参数 offset/size 与 GPU 实际布局不一致

### 现象

在 Vertex Factory shader 里，`float3` 后紧跟一个 `float` loose global 变量：

```hlsl
float3 LodViewOrigin;
float  MyBias;        // 新加的参数
float4 LodDistances;
```

C++ 用 `FShaderParameter::Bind()` 绑定，运行时触发：

```
Ensure condition failed: sizeof(ParameterType) == Parameter.GetNumBytes()
Attempted to set fewer bytes than the shader required.
Setting 4 bytes on loose parameter at BaseIndex 16, Size 16.
```

RenderDoc 里 `$Globals[0].w` 显示的是随机残留值（如 `0.00235`），不是 C++ 传入的值。

### 根因

DXC 的 **codegen** 和 **reflection API** 对 loose global（`$Globals` cbuffer）用了两套不同的打包模型：

| 来源 | `LodViewOrigin` | `MyBias` | `LodDistances` |
|------|----------------|----------|----------------|
| GPU 实际内存（RDC） | offset 0，12B | offset **12**，4B（打包进 row .w） | offset 16，16B |
| DXC Reflection API | offset 0，12B | offset **16**，**16B** | offset 32，16B |

- codegen 遵守 HLSL packing，把 float3+float 装进同一 float4 row
- reflection 把每个 loose global 从下一个 float4 对齐边界开始上报，`Size` = 到下一个变量的 offset 差（32−16=16），而非类型本身的 4 字节

UE 读反射的路径（无任何舍入）：

```
D3DShaderCompiler.inl: ExtractParameterMapFromD3DShader
  → VariableDesc.StartOffset  → BaseIndex
  → VariableDesc.Size         → NumBytes
  → HandleReflectedGlobalConstantBufferMember
    → FShaderParameterMap::AddParameterAllocation  // 原样存储
```

结果：UE 把 `MyBias` 写到 offset 16（reflection 说在这），GPU shader 从 offset 12（codegen 实际位置）读，读到 padding 里的残留值。

### 为什么引擎里大量类似写法没问题

引擎里二十多个文件有 `float3` 后接 `float` 的写法，但几乎都通过 `SHADER_PARAMETER_STRUCT` 绑定。C++ 直接按 struct 字节布局写整块 cbuffer，不经 DXC Reflection，cbuffer 成员的 packing 和 reflection 本身就是一致的。

**只有** 用 `FShaderParameter::Bind()` 绑定的 loose global（旧式 VF 参数写法）才会踩这个坑。

### 修法

**合并成显式 float4**，消除 DXC 的歧义：

```hlsl
// Shader 侧
float4 LodViewOriginAndBias;   // .xyz = LodViewOrigin, .w = MyBias
float4 LodDistances;

#define LodViewOrigin LodViewOriginAndBias.xyz
#define MyBias        LodViewOriginAndBias.w
```

```cpp
// C++ 侧：合并成一个 FShaderParameter，传 FVector4f
LAYOUT_FIELD(FShaderParameter, LodViewOriginAndBiasParameter);
LodViewOriginAndBiasParameter.Bind(ParameterMap, TEXT("LodViewOriginAndBias"));
ShaderBindings.Add(LodViewOriginAndBiasParameter,
    FVector4f(ViewOrigin.X, ViewOrigin.Y, ViewOrigin.Z, BiasValue));
```

float4 的 DXC codegen 和 reflection 完全一致，不会有歧义。

### 调试线索

| 症状 | 含义 |
|------|------|
| ensure `sizeof(T) != GetNumBytes()`，Size 是 16 但传的是 float | DXC 把 loose global float 上报了 float4 大小 |
| RDC `$Globals[0].w` 是随机残留值，不是传入值 | UE 写到了错误 offset，GPU 读到 padding |
| 相邻参数（如 LodDistances）值正确 | 两次写入覆盖顺序恰好把正确值覆盖回来 |

---

## 二、FMeshBatch 浅拷贝 UserData 陷阱

### 现象

克隆一个 `FMeshBatch` 来提交第二遍 draw，修改克隆版的 `UserData` 字段，但原始 draw 的参数也一起变了；或者克隆版的修改根本没生效，shader 读到的仍是旧值。

### 根因

`Mesh = RefMesh` 是 **浅拷贝**。`FMeshBatch::Elements` 是 `TArray`（有深拷贝），但 `Elements[0].UserData` 是 `void*`——指针被拷贝，两个 `FMeshBatch` 共享同一个 `FVirtualHeightfieldMeshUserData` 对象。

```cpp
FMeshBatch& Mesh = Collector.AllocateMesh();
Mesh = RefMesh;  // Elements[0].UserData 仍指向 RefMesh 的 UserData

FVirtualHeightfieldMeshUserData* UserData =
    (FVirtualHeightfieldMeshUserData*)Mesh.Elements[0].UserData;
UserData->MyField = newValue;  // ← 同时修改了 RefMesh 的 UserData！
```

**后果**：
- 原始 RefMesh draw 也读到 `newValue`（不期望的副作用）
- `GetElementShaderBindings` 为两个 draw 生成 DrawCommand 时，最后一次写入的值取决于执行顺序，不确定

### 修法

克隆时为新 Mesh 分配独立的 UserData：

```cpp
FMeshBatch& Mesh = Collector.AllocateMesh();
Mesh = RefMesh;
FMeshBatchElement& BatchElement = Mesh.Elements[0];

// 分配新 UserData，深拷贝数据，再修改目标字段
FVirtualHeightfieldMeshUserData* NewUserData =
    &Collector.AllocateOneFrameResource<FVirtualHeightfieldMeshUserData>();
*NewUserData = *(FVirtualHeightfieldMeshUserData*)BatchElement.UserData;
NewUserData->MyField = newValue;        // 只改克隆版
BatchElement.UserData = (void*)NewUserData;

Collector.AddMesh(ViewIndex, Mesh);
```

`AllocateOneFrameResource` 分配的内存由 Collector 管理生命周期，帧结束时统一析构，无需手动释放。

### 连带检查

克隆 `FMeshBatch` 时还要检查这些字段是否应该改：

| 字段 | 说明 |
|------|------|
| `MaterialRenderProxy` | 第二遍 draw 通常需要不同材质，忘改则两遍用同一材质 |
| `CastShadow` | 叠加 pass 通常不需要再投阴影，忘改则 shadow map 写两次 |
| `bUseForDepthPass` | 同上，避免重复写 depth prepass |

---

## 三、AllocateOneFrameResource 不零初始化

### 现象

用 `Collector.AllocateOneFrameResource<T>()` 分配 UserData，某些字段从未显式赋值，shader 读到随机垃圾值（如残留的上一帧数据）。

### 根因

`AllocateOneFrameResource<T>()` 内部调用 `new (mem) T`（default-initialization），对于没有用户自定义构造函数的 struct，POD 成员**不会被零初始化**，内存里是 FMemStack 上的任意残留数据。

```cpp
struct FMyUserData : public FOneFrameResource {
    FRHIShaderResourceView* SRV;
    FVector3f               ViewOrigin;
    float                   MyBias;   // ← 从未显式赋值 → 垃圾值
    FVector4f               Distances;
};

FMyUserData* UserData = &Collector.AllocateOneFrameResource<FMyUserData>();
UserData->SRV     = ...;
UserData->ViewOrigin = ...;
UserData->Distances  = ...;
// MyBias 没有赋值，shader 读到随机值
```

### 修法

对所有字段显式初始化，或给 struct 加默认值：

```cpp
// 方案 A：逐字段赋值（最明确）
UserData->MyBias = 0.f;

// 方案 B：struct 成员加 = 0 默认值
struct FMyUserData : public FOneFrameResource {
    float MyBias = 0.f;   // 有了用户提供的初始值后，new T() 会零初始化
};
```

### 注意

`FOneFrameResource` 有虚析构（vtable），default copy assignment（`*dst = *src`）**不会**拷贝 vtable 指针（由构造时确定），但会拷贝所有数据成员，包括未初始化的字段。所以"克隆后覆盖"（二节的修法）仍然可能把源对象的垃圾值带过来——必须在覆盖后再显式赋目标字段。

---

## 四、Static UniformBuffer 槽位冲突 — Opaque BasePass 引用 SceneTexturesStruct 崩溃

### 现象

在复用 BasePass shader 的自定义 pass 中，材质 .ush 里读取 `SceneTexturesStruct.SceneDepthTexture` 或调用 `LookupDeviceZ()`，运行时崩在：

```
checkf(false, "Shader attempted to bind uniform buffer '%s' at slot %s with hash '%u', 
but the shader expected '%s' with hash '%u'.")
```

RenderDoc 显示 slot 上绑的是 `FOpaqueBasePassUniformParameters`（hash `78176037`），但 shader 期望 `FSceneTextureUniformParameters`（hash `2923945906`）。

如果材质 .ush 换了自定义 UB 名（非 `SceneTexturesStruct`），编译期会报：

```
Base pass shaders cannot read from the SceneTexturesStruct.
```

### 根因

以下 4 个 UB 结构体**全部挂在同一个 `SceneTextures` 静态槽**上：

```cpp
// SceneTexturesConfig.cpp:16
IMPLEMENT_STATIC_UNIFORM_BUFFER_STRUCT(FSceneTextureUniformParameters,        "SceneTexturesStruct", SceneTextures);
// BasePassRendering.cpp:137-138
IMPLEMENT_STATIC_UNIFORM_BUFFER_STRUCT(FOpaqueBasePassUniformParameters,      "OpaqueBasePass",      SceneTextures);
IMPLEMENT_STATIC_UNIFORM_BUFFER_STRUCT(FTranslucentBasePassUniformParameters, "TranslucentBasePass", SceneTextures);
// PostProcessDeferredDecals.cpp
IMPLEMENT_STATIC_UNIFORM_BUFFER_STRUCT(FDecalPassUniformParameters,           "DecalPass",           SceneTextures);
```

**槽位是排他的**：一个 pass 同一时刻只能绑其中一个到该槽。shader 里同时引用 `OpaqueBasePass.X` 和 `SceneTexturesStruct.Y` → 两个引用都要同一个 `SceneTextures` 槽 → 运行时绑了 `OpaqueBasePass` 则 `SceneTexturesStruct` 失配，反之亦然。

**编译期防线**：`TBasePassPS::ValidateCompiledResult`（`BasePassRendering.h:567-575`）检查参数表是否含 "SceneTexturesStruct" 这个名字，有则编译失败。但这条校验**只认名字** — 换一个 UB 名（如 `SingleLayerWater` / `TmbStencilPass`）即可绕过。这是引擎有意留的"后门"：deferred opaque base pass 写 GBuffer 时 scene depth 还没 resolve，所以全局禁读是有道理的；但个别需要读深度再写 GBuffer 的 pass（如 SingleLayerWater）可以用独立 UB 绕过。

另外，`FTranslucentBasePassUniformParameters` 内嵌了 `FSceneTextureUniformParameters`（`BasePassRendering.h:108`），且 translucent 路径的 `BasePassPixelShader.usf:24` 有 `#define SceneTexturesStruct TranslucentBasePass.SceneTextures`。所以 translucent base pass 可以透明地用 `SceneTexturesCommon.ush` 的所有函数——不崩。

### 修法

参考 **SingleLayerWater** 的做法（`SingleLayerWaterRendering.cpp:357-378`）：

1. 新建具名 UB 结构体，挂在**空闲槽**（SLW 复用 `DeferredDecals` 槽，该槽在 SLW pass 期间未被占用）：

```cpp
BEGIN_UNIFORM_BUFFER_STRUCT(FMyCustomPassUniformParameters, )
    SHADER_PARAMETER_RDG_TEXTURE(Texture2D, SceneDepthTexture)
    SHADER_PARAMETER_RDG_TEXTURE(Texture2D, CustomDepthTexture)
    SHADER_PARAMETER_RDG_TEXTURE_SRV(Texture2D<uint2>, CustomStencilTexture)
    // ...
END_UNIFORM_BUFFER_STRUCT()
IMPLEMENT_STATIC_UNIFORM_BUFFER_STRUCT(FMyCustomPassUniformParameters, "MyCustomPass", DeferredDecals);
```

2. Pass 中同时绑 BasePass UB 和自定义 UB：

```cpp
PassParameters->OpaqueBasePass = Scene->UniformBuffers.OpaqueBasePassUniformBuffer;
PassParameters->MyCustomPass  = GraphBuilder.CreateUniformBuffer(MyCustomPassUB);
```

3. Shader 中按成员名直接访问，**不需要** alias：

```hlsl
float DeviceZ = MyCustomPass.SceneDepthTexture.SampleLevel(...).r;
```

4. 名字不叫 `SceneTexturesStruct` → `ValidateCompiledResult` 不触发。

### 调试线索

| 症状 | 含义 |
|------|------|
| `checkf` hash 不匹配，slot=SceneTextures | shader 同时引用同槽两个不同 UB |
| `Base pass shaders cannot read from the SceneTexturesStruct.` | UB 名字恰好叫 `SceneTexturesStruct`，换名可绕过 |
| translucent 路径不崩、opaque 路径崩 | translucent 有 `#define SceneTexturesStruct TranslucentBasePass.SceneTextures`，opaque 没有（`BasePassPixelShader.usf:24-55`） |
| `use of undeclared identifier 'MyCustomPass'` | UB 未被 referenced-UB 扫描登记（见第五节） |

### 为什么不推荐改 FOpaqueBasePassUniformParameters

在 `FOpaqueBasePassUniformParameters` 里加 `SHADER_PARAMETER_STRUCT(FSceneTextureUniformParameters, SceneTextures)` 确实能解决单槽问题，但：
- 改全局 UB layout，**所有** base pass 材质强制重编
- Base pass 执行时 `SceneDepth` 尚未 resolve（deferred 管线下），语义上不该读
- 破坏了 `SCENE_TEXTURES_DISABLED` 的设计意图

---

## 五、referenced-uniform-buffer 扫描盲区 — 自定义 UB 在材质 .ush 中不可见

### 现象

在材质注入的 `.ush` 中写了 `MyCustomPass.SceneDepthTexture`，编译报错：

```
use of undeclared identifier 'MyCustomPass'
```

或：

```
File '/Engine/Generated/UniformBuffers/MyCustomPass.ush' not found
```

但在 `BasePassPixelShader.usf` 或 `BasePassVertexCommon.ush` 中引用同样的 UB 却没问题。

### 根因

引擎的 UB 自动登记机制分两步（均在 `WITH_EDITOR` 下）：

1. **`BuildShaderFileToUniformBufferMap`**（`ShaderCore.cpp:3534`）：对所有 shader 源文件做**大小写不敏感子串搜索**，找 `UPPER(ShaderVarName) + "."`（`：3550-3552`）。读到的是**原始文件文本**（含注释、含 `#define`、忽略 `#if`）。得到 `文件 → {该文件引用到的 UB}`。

2. **`GenerateReferencedUniformBuffers(根文件)`**（`：3731`）：取 `GetShaderIncludes(根文件)` —— 即 shader 类型根 `.usf` 的**静态 `#include` 图**（编译前确定的依赖树）+ 根文件本身 —— 并集出该 shader 类型的"被引用 UB 集合"。

**材质注入的 `.ush` 不在静态 `#include` 图里**：它经 `/Engine/Generated/Material.ush`（**生成文件**，编译时动态生成）间接引入，而生成文件的内容在编译前不可知 → 第 2 步扫描不到 → UB 不登记 → 生成头（`/Engine/Generated/UniformBuffers/<Name>.ush`）不存在 → 编译报错。

### 修法

在**静态可达**的文件里放一处含子串 `"<UBName>."` 的引用，UB 即被登记。最简单的是放在 shader 根 `.usf` 中（仿 SLW 在 `BasePassPixelShader.usf:57-59` 放 `SingleLayerWater.BlueNoise`）：

```hlsl
// BasePassPixelShader.usf 中加一行扫描锚点
#define ZR_UB_ANCHOR MyCustomPass.SceneDepthTexture
```

**关键点**：
- 子串搜索连注释、`#define` 值、`#include` 路径里的 `Name.` 都算（因为 `.ush` 扩展名那个点）。最稳是放一行 `#define ANCHOR <UBName>.SomeMember`。
- **副作用可控**：该 UB 会对所有走这个根 `.usf` 的 shader 登记/声明，但 shader 未实际引用其成员 → 编译器剥离 → 不进 resource table → 不占槽 → 运行时无影响。SLW 的 `SingleLayerWater` 对所有 base pass shader 都声明了，但只有 `MATERIAL_SHADINGMODEL_SINGLELAYERWATER` 的 variant 才实际引用。

---

## 六、复用 BasePass Shader 的自定义 Pass — 静态 UB 补齐陷阱（Whack-a-Mole）

### 现象

自定义 mesh pass 复用 `GetBasePassShaders()`（即 opaque base pass 的 stock shader），pass 参数中声明了 `OpaqueBasePass` 和自定义 UB。运行时崩：

```
Shader requested a global uniform buffer at static slot '%s', but it was null.
```

修复后（补上了缺失的 UB），又崩在另一个 slot，循环往复——**whack-a-mole**。

实测崩溃序列：slot 13（SceneTextures 冲突）→ slot 3（FSceneUniformParameters null）→ slot 12（自定义 UB 间歇性 null）→ slot 2（InstanceCulling null）→ slot 0（View null）→ ……

### 根因

复用 BasePass shader 意味着 shader 编译时引用了**所有常规 BasePass 的静态 UB**：

| UB | 典型 slot 用途 |
|---|---|
| `View` | 逐帧相机/时间等 |
| `InstancedView` | ISR 多 View |
| `Scene` | 场景级光照/雾等 |
| `WorkingColorSpace` | HDR 色彩空间 |
| `ReflectionCapture` | 反射捕获 |
| `OpaqueBasePass` | GBuffer 输出 |
| `InstanceCulling` | GPU 裁剪数据 |
| … | … |

**你的 pass 参数必须声明并绑定每一个**。`GetStaticUniformBuffers(PassParams)` 理论上应自动抽取所有标记 `IsStatic()` 的 UB，但实测在自定义 pass 中会**间歇性遗漏**（可能原因：SCW 进程与 Editor 进程的槽位布局差异、RHI command pipe 异步执行）。

修复一个暴露下一个 — 因为 runtime 校验（`ApplyStaticUniformBuffers` → `RHICoreShader.h:64-104`）对 shader 中的**每个**静态槽条目逐一比对，缺一个崩一个。

### 修法

**一次性补齐**所有 BasePass 引用的静态 UB，不要逐个修：

```cpp
// Pass 参数结构体中声明所有 BasePass 会引用的静态 UB
BEGIN_SHADER_PARAMETER_STRUCT(FMyCustomPassParameters, )
    // ... RDG 贴图参数 ...

    // 基础 —— shader 几乎必定引用
    SHADER_PARAMETER_RDG_UNIFORM_BUFFER(FViewUniformParameters, View)
    SHADER_PARAMETER_RDG_UNIFORM_BUFFER(FSceneUniformParameters, Scene)
    SHADER_PARAMETER_RDG_UNIFORM_BUFFER(FOpaqueBasePassUniformParameters, OpaqueBasePass)
    SHADER_PARAMETER_RDG_UNIFORM_BUFFER(FWorkingColorSpaceUniformParameters, WorkingColorSpace)
    SHADER_PARAMETER_RDG_UNIFORM_BUFFER(FReflectionCaptureUniformParameters, ReflectionCapture)

    // 可能有 —— 按需添加
    SHADER_PARAMETER_RDG_UNIFORM_BUFFER(FInstanceCullingGlobalUniforms, InstanceCulling)
    SHADER_PARAMETER_RDG_UNIFORM_BUFFER(FBatchedPrimitiveUniformParameters, BatchedPrimitive)

    // 自定义
    SHADER_PARAMETER_RDG_UNIFORM_BUFFER(FMyCustomPassUniformParameters, MyCustomPass)
END_SHADER_PARAMETER_STRUCT()
```

**材质 .ush 中加 keyword 编译期门控**（根源隔离）：

```hlsl
// ✅ 正确：只有启用特定 keyword 时才引用自定义 UB
#if IS_BASE_PASS && !SCENE_TEXTURES_DISABLED && defined(_EnableMyFeature)
    float DeviceZ = MyCustomPass.SceneDepthTexture.SampleLevel(...).r;
#else
    float DeviceZ = 0.0;
#endif
```

只用 `IS_BASE_PASS` 不够 — 它会覆盖游戏 BasePass、编辑器视口、资产缩略图等所有 base pass 上下文，其中非本 pass 的上下文里 `MyCustomPass` 未绑 → 崩。

**类型安全声明**：pass 参数中优先用 `SHADER_PARAMETER_RDG_UNIFORM_BUFFER`（RDG 自动管理生命周期），而非 `SHADER_PARAMETER_STRUCT_REF`（裸指针，需手动管理）。

### 连带检查

| 项目 | 说明 |
|------|------|
| `bRenderInMainPass = false` | 防止 overlay primitive 进入常规 BasePass（本 pass 已单独渲染） |
| 优先 `GraphBuilder.AddPass` 而非 `AddSimpleMeshPass` | `AddSimpleMeshPass` 内部深拷贝参数，`BuildRenderingCommands` 修改的是拷贝版，原始参数的 InstanceCulling 等不会被更新 |
| 首次接入时用 `UE_LOG` + `FTypeInfo::GetStructMetadata()` 打印 slot/hash | Debug 模式下 MSVC 内联导致 PDB 变量不可见，用日志输出是最可靠的验证手段 |
| 选用空闲静态槽 | 参考 SLW 复用 `DeferredDecals`；若需新槽，用 `IMPLEMENT_STATIC_UNIFORM_BUFFER_SLOT(YourSlot)` 注册，但注意槽位编号因构建而异，**切勿硬编码 slot 号** |

---

## 七、嵌套 UB 的槽位行为澄清

### 容易误解的点

`SHADER_PARAMETER_STRUCT(FSceneTextureUniformParameters, SceneTextures)` 在父 UB 中声明时，`FSceneTextureUniformParameters` 的字段**按值展平**进父 UB 的内存布局；**嵌套副本不独立占静态槽**。槽只属于父结构体 `IMPLEMENT_STATIC_UNIFORM_BUFFER_STRUCT` 那次声明。

这就是为什么 `FTranslucentBasePassUniformParameters` 内嵌 `FSceneTextureUniformParameters`（`BasePassRendering.h:108`）却不与 slot 的 `FSceneTextureUniformParameters` 冲突 — 它的槽是 `SceneTextures`（由 `IMPLEMENT_*` 决定），内嵌的 SceneTextures 字段只是内存中的嵌套数据。

### 结论

"pass 自带 UB 内嵌 SceneTextures + shader 里 `#define SceneTexturesStruct <PassUB>.SceneTextures`" 是引擎里处理"读场景纹理"的标准模式。引擎中十余个 pass 都这么干：TranslucentBasePass、DecalPass、ShadowDepthPass、DistortionPass、LumenFrontLayer、MaterialCache……

---

*更多坑持续补充中。*

> **📋 事实核查**：本文于 2026-06-12 经 fact-check-report 核查，共 15 条陈述（✅ 13 正确 / ❌ 0 有误 / ❓ 2 无法核实，已修正 0 处）。核查范围：现有三节 DXC/FMeshBatch/AllocateOneFrameResource 的源码路径验证 + 外部文件 `ue-static-ub-and-basepass-scenetextures.md` 中 12 条关键架构声明（静态槽宏定义、BasePass UB 结构体、ValidateCompiledResult、BasePassPixelShader alias、RHICoreShader 校验链、SLW 参考实现、BuildShaderFileToUniformBufferMap 扫描机制等），均与 `D:\BuildUnrealEngine` 源码吻合。
