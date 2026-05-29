+++
date = '2026-05-25T00:00:00+08:00'
draft = false
title = 'UE5 渲染踩坑录'
tags = ['UE5', 'DXC', 'HLSL', 'Shader', 'VertexFactory', 'RenderDoc', 'ShaderParameter', 'MeshBatch', 'FShaderParameter', 'Rendering']
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

*更多坑持续补充中。*
