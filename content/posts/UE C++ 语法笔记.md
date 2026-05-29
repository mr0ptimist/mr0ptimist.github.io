+++
date = '2026-05-25T00:00:00+08:00'
draft = false
title = 'UE C++ 语法笔记'
tags = ['UE', 'C++']
categories = ['博客']
+++

阅读 UE 引擎源码时遇到的 C++ 语法整理。

---

## `[[nodiscard]]`

C++17 属性标记，调用函数时若忽略返回值，编译器发出警告。

```cpp
[[nodiscard]] bool TryLock();

mutex.TryLock();          // warning: ignoring return value
bool ok = mutex.TryLock(); // 正确
```

常用于返回值必须检查的场景，如 `TryLock` 返回是否加锁成功。

C++17 起可附加说明字符串：

```cpp
[[nodiscard("必须检查锁是否成功")]] bool TryLock();
```

**常见标准属性**

| 属性 | 含义 |
|---|---|
| `[[nodiscard]]` | 返回值不能丢弃 |
| `[[deprecated]]` | 标记已废弃，调用时警告 |
| `[[maybe_unused]]` | 变量/函数可能未使用，压制警告 |
| `[[likely]]` / `[[unlikely]]` | 分支预测提示（C++20） |
| `[[fallthrough]]` | switch-case 故意不 break |

---

## `= delete`

显式删除某个函数，调用时编译报错。常用于禁止拷贝：

```cpp
FRecursiveMutex(const FRecursiveMutex&) = delete;            // 禁止拷贝构造
FRecursiveMutex& operator=(const FRecursiveMutex&) = delete; // 禁止拷贝赋值
```

互斥锁的 `State`、`ThreadId` 代表特定同步状态，复制语义上无意义且危险，在编译期禁止比运行时出 bug 更安全。

---

## `std::atomic<T>`

原子类型，对 `T` 的读写操作线程安全，不需要额外加锁。

**为什么需要原子性**

普通 `x++` 在汇编层面是三步（读→加→写），多线程并发时会丢失更新：

```
Thread A: 读 x=0
Thread B: 读 x=0
Thread A: 写 x=1
Thread B: 写 x=1   ← 结果是1，应该是2
```

`std::atomic` 让这三步变成一条不可分割的 CPU 指令，其他线程只能看到操作前或操作后的值。

**常用方法**

| 方法 | 含义 |
|---|---|
| `load(order)` | 原子读取 |
| `store(val, order)` | 原子写入 |
| `fetch_add(n)` | 原子加法，返回旧值 |
| `compare_exchange_weak/strong` | CAS，无锁算法核心 |

**`memory_order` 参数**

| 值 | 含义 |
|---|---|
| `relaxed` | 只保证原子性，不保证顺序，性能最高 |
| `acquire` | 读屏障 |
| `release` | 写屏障 |
| `seq_cst` | 最强全局顺序，默认值 |

---

## `static constexpr`

```cpp
static constexpr uint32 LockCountMask = 0xffff'fffe;
```

| 关键字 | 含义 |
|---|---|
| `static` | 属于类本身，不属于某个实例 |
| `constexpr` | 编译期常量，运行时零开销 |

`'` 是 C++14 引入的数字分隔符，仅提高可读性，编译器忽略它：

```cpp
0xffff'fffe == 0xfffffffe
1'000'000   == 1000000
```

---

## 位掩码（Bit Mask）

以 `FRecursiveMutex` 的 `State` 为例，用一个 `uint32` 编码两种信息：

```
bit 0      → MayHaveWaitingLockFlag（有线程在等待）
bits 1–31  → LockCount（递归锁计数）
```

```cpp
static constexpr uint32 MayHaveWaitingLockFlag = 1 << 0;    // 0x00000001
static constexpr uint32 LockCountMask          = 0xffff'fffe; // 除bit0外全1
```

用 `&` 提取特定位域：

```cpp
// 只看 bits 1-31，忽略 bit 0
bool locked = !!(State.load(std::memory_order_relaxed) & LockCountMask);
```

---

## `template`

让类或函数对不同类型复用同一套逻辑，编译期展开，运行时零开销。

**基本语法**

```cpp
template<class T>   // 或 typename T，等价
class TBox {
    T Value;
public:
    T Get() { return Value; }
};

TBox<int>   a;  // T = int
TBox<float> b;  // T = float
```

**两种参数**

```cpp
// 类型参数
template<class ResourceType>

// 非类型参数（编译期常量：整数、枚举、指针等）
template<int N>
class TFixedArray { int Data[N]; };  // TFixedArray<4>

// 混合 + 默认值
template<class ResourceType, FRenderResource::EInitPhase InInitPhase = FRenderResource::EInitPhase::Default>
```

有默认值时可省略：

```cpp
TGlobalResource<FMyResource>                             // InInitPhase = Default
TGlobalResource<FMyResource, EInitPhase::PreDefault>     // 显式指定
```

**函数模板（类型自动推导）**

```cpp
template<typename T>
T Max(T a, T b) { return a > b ? a : b; }

Max(1, 2);       // T 推导为 int
Max(1.0f, 2.0f); // T 推导为 float
```

**查看模板实例化结果**

- [godbolt.org](https://godbolt.org)：粘贴代码，选 AST 视图
- Clang：`clang++ -Xclang -ast-dump`
- 故意触发报错：声明未定义模板，错误信息会显示完整类型推导链

```cpp
template<typename T> struct Debug;  // 故意不定义
Debug<decltype(x)> d;              // 报错信息里含完整类型
```

---

## `FRecursiveMutex` 实战案例

`VirtualHeightfieldMeshSceneProxy.cpp` 中，`FVirtualHeightfieldMeshRendererExtension` 继承自 `FRenderResource`，多线程并发调用 `AddWork()` 修改共享的缓冲池和工作列表：

```cpp
UE::FRecursiveMutex Mutex;

FDrawInstanceBuffers& AddWork(...)
{
    UE::TScopeLock Lock(Mutex); // RAII，函数返回自动解锁
    // 修改 Buffers、WorkDescs、MainViews 等共享数组
    ...
    if (!ensure(!bInFrame))
        EndFrame(); // 同线程重入 → 需要递归锁
}
```

选用 `FRecursiveMutex` 而非 `FMutex` 的原因：持锁期间可能调用 `EndFrame()`，若后者也尝试加同一把锁，普通互斥锁死锁，递归锁允许同线程重入。
