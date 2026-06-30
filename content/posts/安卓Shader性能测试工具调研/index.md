+++
date = '2026-06-26T18:00:00+08:00'
draft = false
title = '消费级安卓机 Shader 性能与 ALU 测试 CLI 工具调研'
tags = ['Android', 'Shader', 'GPU', '性能测试', 'CLI', 'Mali', 'Adreno']
categories = ['图形渲染']
+++

## 1.1 调研背景与范围

本文调研在**消费级 Android 手机**（非 root，ADB 可连）上能用命令行（CLI）驱动的 shader 性能分析工具，重点关注 **ALU 算术单元开销**的可量化测量。

按工作模式分三类：

| 类型 | 说明 | 是否需要真机 |
|------|------|-------------|
| 离线静态编译器 | Host PC 端运行，对 shader 源码 / SPIR-V 做静态性能分析 | 否 |
| On-Device PMU 采样 | 交叉编译二进制推到手机，直接读 GPU 硬件 PMU 计数器 | 是（需 ADB + NDK 交叉编译） |
| 系统级 GPU 追踪 | 利用 Android 系统内置的 Perfetto / AGI 框架采集 GPU 计数器 | 是（需 ADB） |

---

## 1.2 离线静态分析工具

### 1.2.1 Mali Offline Compiler（malioc）

**来源：** ARM，捆绑于 [Arm Mobile Studio](https://developer.arm.com/Tools%20and%20Software/Arm%20Mobile%20Studio)

**适用 GPU：** Mali / Immortalis 全系列

malioc 是 ARM 官方提供的命令行 shader 静态分析器。它使用与 Mali GPU 驱动**相同的编译器后端**，在 PC 端编译 shader 并输出性能报告，**无需连接真机**。

#### 安装

从 [Arm Mobile Studio 下载页](https://developer.arm.com/downloads/-/arm-mobile-studio) 获取安装包。malioc 位于安装目录下，可直接从命令行调用。

```bash
malioc --help
malioc --list   # 列出支持的 GPU 列表
```

#### 基本用法

```bash
# OpenGL ES Fragment Shader
malioc -c Mali-G76 shader.frag

# Vulkan SPIR-V
malioc --vulkan -c Mali-G76 shader.frag.spv

# 指定 GPU 并输出 JSON 报告
malioc -c Mali-G76 shader.frag --format json -o report.json
```

#### 性能报告解读

编译成功后会输出类似以下格式的性能表：

```
                         A      LS       V       T    Bound
Total instruction cycles:    1.25    0.50    0.25    0.75        A
Shortest path cycles:        0.75    0.25    0.25    0.75        A
Longest path cycles:         1.25    0.50    0.25    0.75        A
```

| 列 | 含义 |
|----|------|
| **A** (Arithmetic) | **ALU 算术单元周期数**——即你关心的 ALU 开销 |
| **LS** (Load/Store) | 内存读写周期 |
| **V** (Varying) | 插值 / 顶点属性周期 |
| **T** (Texture) | 纹理采样周期 |
| **Bound** | 瓶颈标记：标识哪个单元是性能瓶颈 |

- `Bound = A`：shader 受 ALU 限制，优先减少算术指令
- `Bound = T`：shader 受纹理采样限制，优先减少贴图采样次数
- 报告中的数值为归一化到**单个 shader core** 的 cycle 数

#### 进阶特性

- **CI 集成**：`--format json` 输出机器可读 JSON，易于脚本 diff 和自动化回归
- **跨 GPU 预测**：可在没有真机的情况下预测 shader 在任意 Mali GPU 上的表现
- **语法检查**：附带完整的 GLSL / SPIR-V 语法校验和错误定位

#### 硬件支持范围

malioc 支持从 Midgard（Mali-T6xx/T7xx/T8xx）到 Bifrost（G71-G76）、Valhall（G77-G78）、以及最新的 Immortalis 全系列 GPU。

---

### 1.2.2 Adreno Offline Compiler（AOC）

**来源：** Qualcomm，从 [Qualcomm Software Center](https://qpm.qualcomm.com/#/main/tools/details/Adreno_GPU_Offline_Compiler) 下载

**适用 GPU：** Adreno 全系列

AOC 是高通官方 shader 离线编译器，功能对标 malioc，但面向 Adreno GPU。目前仅支持 **Vulkan SPIR-V** 输入。

#### 基本用法

```bash
# 编译 SPIR-V fragment shader 并输出统计
aoc --api vulkan --gpu a650 shader.frag.spv
```

#### 性能报告解读

AOC 输出比 malioc 更详细的指令级统计：

```
Main Shader Stats:
  Total instruction count          : 245
  ALU instruction count - 32 bit   : 180   ← 32位 ALU 指令数
  ALU instruction count - 16 bit   : 15    ← 16位 ALU 指令数
  Complex instruction count - 32 bit : 12
  Texture read instruction count   : 8
  Memory read instruction count    : 5
  Memory write instruction count   : 0
  Flow control instruction count   : 10
  Full precision register footprint : 8
  Half precision register footprint : 4
  Scratch memory usage             : 0 bytes
  Loop count                       : 1
```

关键指标：

| 指标 | 含义 |
|------|------|
| **ALU instruction count (32/16 bit)** | 32 位和 16 位 ALU 指令数量——衡量 shader 计算密度 |
| **Complex instruction count** | 复杂指令（如超越函数 `sin`/`cos`/`sqrt`）数量 |
| **Register footprint** | 通用寄存器占用，过高会导致寄存器溢出（scratch memory） |
| **Scratch memory usage** | 溢出到显存的寄存器数据，> 0 说明寄存器压力过大 |

AOC 还会对 **VS 和 FS 分别输出 Binning Pass**（Adreno TBDR 架构的 tile 分类阶段）vs **Main Pass** 两组统计，这是 malioc 不具备的能力。

#### 获取方式

AOC 需从 [Qualcomm Software Center](https://qpm.qualcomm.com/) 注册下载，不像 malioc 那样随 Arm Mobile Studio 公开分发。

---

### 1.2.3 malioc vs AOC 对比

| | Mali Offline Compiler | Adreno Offline Compiler |
|---|---|---|
| 厂商 | ARM | Qualcomm |
| 输入格式 | GLSL / Vulkan SPIR-V / OpenCL C | Vulkan SPIR-V |
| ALU 统计 | 归一化 cycle 数（A 列） | ALU 指令数（32/16 bit 分别统计） |
| 瓶颈分析 | Bound 列（A/LS/V/T） | 指令级分类统计 |
| 寄存器分析 | Work register / Uniform register | GPR footprint + Scratch memory |
| CI 友好度 | JSON 输出原生支持 | 文本格式，需自行解析 |
| 获取难度 | 免费公开下载 | 需注册 Qualcomm 账号 |
| Binning Pass 分析 | 不支持 | 支持 |

---

## 1.3 On-Device PMU 实测工具

离线编译器给出的是**静态预估**，以下工具则通过读取 GPU 硬件 PMU（Performance Monitoring Unit）获得**实测数据**。

### 1.3.1 mperf（MegEngine）

**仓库：** [MegEngine/mperf](https://github.com/MegEngine/mperf)

**适用平台：** ARM CPU / Mali GPU / Adreno 6xx GPU

mperf 是旷视 MegEngine 团队开源的移动端算子性能调优工具箱，C++ 实现，轻量可嵌入。核心能力：

- **GPU PMU 事件采集**：直接读取 Mali / Adreno GPU 内部 PMU 寄存器
- **Roofline 分析**：实测 GFLOPs / GBPs → 绘制 roofline 图判定算力/带宽瓶颈
- **微架构参数探测**：寄存器数量 / Warp Size / Cache Line Size 等

#### 编译（宿主机 NDK 交叉编译）

```bash
git clone https://github.com/MegEngine/mperf
cd mperf

# Mali GPU
./android_build.sh -g mali

# Adreno GPU
./android_build.sh -g adreno

cmake --build <build_dir> --target install
```

#### 使用方式

mperf 以**嵌入 C++ 代码**的方式工作——将你的 GPU 计算调用包裹在 `xpmu.run()` / `xpmu.sample()` 之间：

```cpp
#include "mperf/xpmu.h"

// 定义要采集的 GPU 计数器
mperf::GpuCounterSet gpu_set = {
    mperf::GpuCounter::GFLOPs,     // GPU 浮点运算次数
    mperf::GpuCounter::GBPs,       // GPU 显存带宽
    mperf::GpuCounter::GpuCycles,  // GPU 时钟周期
};
mperf::XPMU xpmu(gpu_set);
xpmu.run();

// === 你的 OpenCL / Vulkan shader 调用 ===
clEnqueueNDRangeKernel(...);

xpmu.sample();  // 采样 PMU 数据
xpmu.stop();
```

#### GPU PMU 示例程序

| 程序 | 功能 |
|------|------|
| `gpu_mali_pmu_test.cpp` | Mali GPU PMU 事件采集示例 |
| `gpu_adreno_pmu_test.cpp` | Adreno GPU PMU 事件采集示例 |
| `gpu_inst_gflops_latency.cpp` | GPU 指令吞吐/延迟微基准——**实测 GPU 峰值算力** |
| `gpu_spec_dram_bw.cpp` | GPU 显存带宽微基准——**实测 DRAM 带宽峰值** |
| `gpu_mem_bw.cpp` | GPU 多级缓存带宽测量 |
| `gpu_march_probe.cpp` | GPU 微架构参数探测 |

#### Adreno GPU PMU 事件清单

mperf 在 Adreno A6xx 系列上可访问约 **125 种硬件事件**，包括：

- `INST_RETIRED`：已退役指令数
- `ALU_CYCLES`：ALU 单元活跃周期
- `TEX_CYCLES`：纹理单元活跃周期
- `L1_MISS` / `L2_MISS`：各级 Cache Miss
- `READ_BYTES` / `WRITE_BYTES`：显存读写字节数

这些事件可组合计算出 GFLOPs、GBPs、Cache Miss Ratio 等高阶指标。具体公式见 mperf 源码中的 `GpuCounter` 派生定义。

#### 局限性

- **需要 NDK 交叉编译**：不能直接在手机上跑脚本，需在 PC 上编译后 `adb push` 到手机
- **OpenCL / Vulkan 接口**：主要面向 GPU 计算（compute），对图形渲染 shader 的封装较少
- **无 root 可能需要特定权限**：Android 13+ 对 GPU counter 读取施加了更严格的 SELinux 限制

---

### 1.3.2 Google HardwarePerfCounter

**仓库：** [google/hardware-perfcounter](https://github.com/google/hardware-perfcounter)

**适用平台：** Adreno + Mali GPU，Android / Linux

Google 开源的跨厂商 GPU 性能计数器采样库，由 Lei Zhang（[antiagainst](https://github.com/antiagainst)）开发，灵感来自 HWCPipe 但克服了其 STL 强依赖和仅支持 Mali 的局限。

#### 特点

- **跨厂商**：统一 API 覆盖 Adreno 和 Mali
- **分层抽象**：低层暴露厂商原生计数器，高层提供厂商无关的聚合指标（计划中）
- **灵活 CMake 构建**：可按厂商选择性编译

#### 编译

```bash
git clone https://github.com/google/HardwarePerfCounter.git
cd HardwarePerfCounter

cmake -G Ninja -S ./ -B build-android/ \
  -DCMAKE_TOOLCHAIN_FILE="${ANDROID_NDK}/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="arm64-v8a" -DANDROID_PLATFORM=android-30
cmake --build build-android/
```

#### 与 mperf 的对比

| | mperf | HardwarePerfCounter |
|---|---|---|
| 维护方 | 旷视 MegEngine | Google |
| GPU 支持 | Mali + Adreno 6xx | Mali + Adreno (更多型号) |
| API 层次 | PMU + Roofline + 微架构探测 | 低层计数器采样 |
| 高层分析 | 内置 GFLOPS / Roofline / 指令延迟 | 待开发（计划中） |
| 成熟度 | 较成熟（有完整文档和案例） | 较新（低层 API 已稳定） |

---

### 1.3.3 ARM libGPUCounters（HWCPipe v2）

**仓库：** [ARM-software/libGPUCounters](https://github.com/ARM-software/libGPUCounters)

libGPUCounters（原名 HWCPipe）是 ARM 官方的 Mali / Immortalis GPU 性能计数器采样库。v2 重写后可以暴露 ARM Streamline 中可见的**全部公开性能计数器**。

#### 特点

- 支持 **Mali-G71 及更新**的所有 ARM GPU（Bifrost 架构起）
- 硬件计数器 + 派生计数器双重暴露
- 提供 Python wrapper 用于第三方工具集成
- 交互式文档：[ARM GPU Counter Reference](https://arm-software.github.io/libGPUCounters/)

#### 使用方式

C++ 接口：

```cpp
#include <libgpucounters/gpucounters.h>

// 创建采样器
auto sampler = hwcpipe::GpuSampler::create(device);

// 配置要采集的计数器
hwcpipe::GpuCounterSet counters = {
    hwcpipe::GpuCounter::ArithmeticUnitUtilization,  // ALU 利用率
    hwcpipe::GpuCounter::VaryingUnitUtilization,
    hwcpipe::GpuCounter::TextureUnitUtilization,
    hwcpipe::GpuCounter::LoadStoreUnitUtilization,
};

// 开始采样 → 执行 workload → 停止 → 读取
sampler->start(counters);
// ... GPU workload ...
auto results = sampler->sample();
sampler->stop();
```

---

## 1.4 系统级 GPU 追踪

### 1.4.1 Perfetto GPU Tracing

**来源：** Android 系统内置 + [perfetto.dev](https://perfetto.dev/docs/data-sources/gpu)

Perfetto 是 Android 10+ 的系统级 tracing 框架，内置 GPU 数据源：

| 数据源 | 用途 |
|--------|------|
| `gpu.counters` | 周期性 GPU 硬件计数器采样 |
| `gpu.renderstages` | GPU 渲染阶段时间线 |
| `linux.ftrace` | GPU 频率 / 内存 / DRM 调度事件 |

#### CLI 启用 GPU 计数器（需 root 或 ADB shell）

```bash
# 开启 GPU Perfetto 生产者（部分设备通过 system property 控制）
adb root
adb shell setprop debug.graphics.gpu.profiler.perfetto 1
adb shell gpu_counter_producer

# Mali 设备额外步骤
adb shell start gpu_probe
```

#### Trace Config 示例

```protobuf
data_sources: {
  config {
    name: "gpu.counters"
    gpu_counter_config {
      counter_period_ns: 1000000   # 1ms 采样间隔
      counter_ids: 1               # GPU frequency
      counter_ids: 3               # GPU utilization
      counter_ids: 106             # GPU read bytes
      counter_ids: 107             # GPU write bytes
    }
  }
}
```

或使用 `record_android_trace` 脚本：

```bash
python3 record_android_trace \
  -o trace.perfetto-trace \
  -t 10s -b 32mb \
  gfx sched freq
```

#### ADB Shell 直接调用

```bash
cat config.pbtx | adb shell perfetto -c - --txt -o /data/misc/perfetto-traces/trace
adb pull /data/misc/perfetto-traces/trace
```

#### 局限性

- GPU 计数器数据源名称带厂商后缀（如 `gpu.counters.adreno` / `gpu.renderstages.mali`），需按设备查询
- 非 root 设备在 Android 12 前无法直接传递 config 文件，需用 `cat | adb shell perfetto -c -`
- GPU driver 内的 Perfetto producer 需在 trace 前启动（AGI 通过 `agi_launch_producer` 工具完成）

---

### 1.4.2 Android GPU Inspector（AGI）

**主页：** [gpuinspector.dev](https://gpuinspector.dev) | **仓库：** [google/agi](https://github.com/google/agi)

AGI 本身是 GUI 工具，但其底层 CLI 组件 `gapit` 支持命令行驱动：

```bash
# 列出 ADB 设备
gapit devices

# System profiling（CLI）
gapit trace --device <serial> --app <package> --duration 10s -o trace.gfxtrace

# Frame profiling（CLI）
gapit trace --device <serial> --app <package> --frame 5 -o frame.gfxtrace
```

AGI 的 Frame Profiler 提供：
- **Shader 面板**：查看每条 draw call 的 shader 源码和性能统计
- **GPU 计数器**：支持 Mali / Adreno / PowerVR 三家的硬件计数器
- **Memory 面板**：RAM 和 GPU 内存使用
- **Pipeline 面板**：完整渲染管线状态

虽然数据采集可通过 CLI 驱动，但**数据分析仍需 GUI 界面**，不完全符合纯 CLI 工作流。

---

## 1.5 微基准测试工具

### 1.5.1 google/uVkCompute

**仓库：** [google/uVkCompute](https://github.com/google/uVkCompute)

Google 开源的 Vulkan compute shader 微基准框架。封装 Vulkan 样板代码，只需写 compute shader 的业务逻辑即可做性能基准测试。

#### 编译与运行

```bash
# 交叉编译 Android arm64
cmake -B build-android \
  -DCMAKE_TOOLCHAIN_FILE="${ANDROID_NDK}/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="arm64-v8a" -DANDROID_PLATFORM=android-29
cmake --build build-android

# 推到手机执行
adb push build-android/benchmarks/foo/bar/bench /data/local/tmp
adb shell "cd /data/local/tmp && ./bench"
```

#### 适用场景

- 测试**特定 compute shader**（如矩阵乘法、卷积）在手机 GPU 上的执行时间
- ALU 密集型 kernel 的指令吞吐微基准
- 比较不同 shader 实现的性能差异

#### Android 10 已知问题

Android 10 上 `/data/local/tmp` 可能搜索不到 Vulkan ICD。workaround：

```bash
# 手动复制 Vulkan 驱动到 /data/local/tmp
adb shell cp /vendor/lib64/hw/vulkan.*.so /data/local/tmp/
adb shell "cd /data/local/tmp && LD_LIBRARY_PATH=/data/local/tmp ./bench"
```

Android 11+ 无此问题。

---

### 1.5.2 Unity Potato Benchmark

**仓库：** [Unity-Technologies/PotatoBenchmark](https://github.com/Unity-Technologies/PotatoBenchmark)

Unity 官方的移动端图形性能基准测试项目。包含 GPU Fragment ALU / Texture fillrate 压力场景：

- **Fillrate 测试**：全屏 quad × 2.5x overdraw，分别用 Lit shader（单方向光）和 Lit shader（1 方向光 + 4 逐像素点光）测试
- **Draw Call 测试**：约 1k / 2.7k 简单 draw call，测试批处理驱动开销
- **阴影测试**：实时阴影 + 级联阴影的剔除 / 深度预通道开销

数据通过 `adb logcat -s Unity | grep [Benchmark]` 获取帧时间（均值 / 中位数 / 最小 / 最大值）。

#### 局限性

- 需要 Unity Editor 构建并部署
- 场景固定，不便自定义 shader 测试
- 输出为帧时间而非 GPU 单元级（ALU/Texture）耗时

---

## 1.6 工具选型指南

### 1.6.1 按 GPU 厂商

| GPU 厂商 | 离线分析 | On-Device PMU | 系统追踪 |
|----------|---------|---------------|----------|
| **ARM Mali** | malioc | mperf / libGPUCounters / HardwarePerfCounter | Perfetto / AGI |
| **Qualcomm Adreno** | AOC | mperf / HardwarePerfCounter | Perfetto / AGI |
| **IMG PowerVR** | — | — | AGI |

### 1.6.2 按使用场景

| 场景 | 推荐工具 | 原因 |
|------|---------|------|
| **日常 shader 优化** | malioc / AOC | 秒级反馈，不依赖真机，CI 友好 |
| **ALU vs Texture 瓶颈判定** | malioc（Bound 列） | 一目了然的瓶颈标记 |
| **精确 ALU 指令统计** | AOC | 输出 32/16 bit ALU 指令数和寄存器占用 |
| **Roofline 分析** | mperf | 实测 GFLOPS + GBPs，绘制 roofline 图 |
| **CI 自动化回归** | malioc --format json | JSON 输出 + 脚本 diff |
| **逐帧 shader debug** | AGI Frame Profiler | 单帧级 shader 性能面板（但需 GUI） |
| **系统级 GPU 瓶颈定位** | Perfetto | 全系统视角，GPU 频率/利用率/带宽时间线 |
| **自定义 compute shader 微基准** | uVkCompute | 免 Vulkan 样板，专注 shader 逻辑 |

---

## 1.7 实战工作流推荐

### 1.7.1 日常 Shader 优化流水线

```
写 shader → malioc / AOC 离线分析 → 改代码 → malioc 重新分析 → 对比 diff
```

这是最快的迭代方式，**秒级反馈**，不需要编译完整 APK。

### 1.7.2 CI 自动化

```bash
# 每次提交自动检查 shader 性能
malioc -c Mali-G76 shader.frag --format json -o report.json
# diff with baseline
python diff_shader_perf.py baseline.json report.json --threshold 5%
```

超过阈值（如 ALU cycle 增加 >5%）的提交自动告警。

### 1.7.3 深度瓶颈定位

```
malioc 发现 Bound=A（ALU 瓶颈）
  → mperf 实测 GFLOPS 确认算力利用率低
    → AOC 检查具体 ALU 指令类型（是否过多 Complex 指令）
      → 针对性优化（如用 ALU 替代 texture lookup、减少超越函数）
```

---

## 1.8 参考文档

- [Arm Mobile Studio — Mali Offline Compiler User Guide](https://documentation-service.arm.com/static/6627b4ac2f51dc4fe726397f)
- [Arm Mali Offline Compiler — Arm Learning Paths](https://learn.arm.com/learning-paths/mobile-graphics-and-gaming/ams/malioc/)
- [Arm GPU Training Series Ep 3.5: Mali Offline Compiler (视频)](https://www.youtube.com/watch?v=zEybNlwd7SI)
- [Qualcomm Adreno Offline Compiler — 下载页](https://qpm.qualcomm.com/#/main/tools/details/Adreno_GPU_Offline_Compiler)
- [Meta Horizon OS — AOC Integration for Unreal Engine](https://developers.meta.com/horizon/documentation/unreal/unreal-adreno-offline-compiler/)
- [MegEngine/mperf — GitHub](https://github.com/MegEngine/mperf)
- [mperf 使用小技巧：安卓 OpenCL 算子的 Roofline 分析](https://segmentfault.com/a/1190000043793932)
- [mperf 博客：移动/嵌入式平台算子性能调优利器](https://www.cnblogs.com/megengine/p/17172018.html)
- [google/hardware-perfcounter — GitHub](https://github.com/google/hardware-perfcounter)
- [ARM-software/libGPUCounters — GitHub](https://github.com/ARM-software/libGPUCounters)
- [ARM GPU Performance Counter Reference](https://arm-software.github.io/libGPUCounters/)
- [Sampling Performance Counters from Mobile GPU Drivers](https://engineered.at/articles/sampling-performance-counters-from-mobile-gpu-drivers)
- [google/uVkCompute — GitHub](https://github.com/google/uVkCompute)
- [Perfetto GPU Data Sources](https://perfetto.dev/docs/data-sources/gpu)
- [Android GPU Inspector (AGI) Quickstart](https://developer.android.com/agi/start)
- [AGI Frame Profiler — Analyze Shader Performance](https://developer.android.com/agi/frame-trace/frame-profiler)
- [AGI GPU Performance Counters](https://developer.android.com/agi/sys-trace/counters)
- [Unity-Technologies/PotatoBenchmark — GitHub](https://github.com/Unity-Technologies/PotatoBenchmark)
- [Android NDK Shader Compilers (glslc)](https://developer.android.com/ndk/guides/graphics/shader-compilers)
