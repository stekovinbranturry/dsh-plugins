// volatile 字段的运行时形态。
//
// 给 Config 字段加上 `.volatile()` 之后（设置面板的硬门槛，见 config.ts），schema 解析出来的
// **不是裸值**，而是一个"引用盒子"：
//   { get: () => 当前值, [Symbol.for('cosmokit.volatile.write')]: (next) => { ... } }
// Loader 在只改 volatile 字段时不会重挂插件：它把新值原地写进这些盒子（cosmokit 的
// createVolatile / updateVolatile），再给 owner fiber 广播 `loader/volatile-update`。
// 于是两件事必须做：①读配置一律过 live() 解包；②想让改动立刻生效要监听那个事件重新解析。
//
// 判据用官方那个"跨 ESM/CJS 副本都认"的协议符号自写，而不是 import { isVolatile }：
// @deepseek-ai/cosmokit 不是本仓依赖（也不在浏览器半的平台种子表里），装它只为一行判断
// 不值得。dsh-settings 自己的 plainConfig() 也是同款私有实现。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** volatile 字段的运行时引用：值只能经 get() 读，写入由 Loader 独占 */
export interface VolatileRef<T> {
  get(): T
}

export function isVolatileRef(value: unknown): value is VolatileRef<unknown> {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** 引用盒子解开后的类型：条件类型按联合分发，`Volatile<T> | undefined` 会得到 `T | undefined` */
type Unwrapped<T> = T extends VolatileRef<infer V> ? V : T

/** 解开 volatile 引用取当前值；普通值原样返回（headless 组合里拿到的就是普通值） */
export function live<T>(value: T): Unwrapped<T> {
  return (isVolatileRef(value) ? value.get() : value) as Unwrapped<T>
}
