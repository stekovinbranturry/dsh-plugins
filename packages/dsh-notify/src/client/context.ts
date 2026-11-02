/** 浏览器半用到的契约。DSH 客户端服务由平台运行时提供，插件不依赖它们的内部类型。 */

/**
 * 界面的导航服务（@deepseek-ai/dsh-client-ui-workspace 提供，服务名 `uiWorkspace`）。
 *
 * 0.1.7 把 `sessions.open(id)` 整个删了（0.1.5 的 ClientSessions 还有
 * `open(id) { manager.select(id) }`），"选中会话、把它显示成对话"搬到这个服务上 ——
 * 官方侧边栏的会话行就是 `uiWorkspace.openSession(sessionId)`。
 */
export interface UiWorkspaceService {
  openSession(sessionId: string): void
}

/**
 * 会话控制器（服务名 `sessions`，即 @deepseek-ai/dsh-api-session-controller/client 的
 * ISessions）。这里只用它的会话列表快照，取其中一行的本地引用计数。
 */
export interface SessionListSnapshotLike {
  byId: Readonly<
    Record<string, { retainedBy?: Readonly<Partial<Record<string, number>>> } | undefined>
  >
}

export interface SessionsService {
  readonly list: { getSnapshot(): SessionListSnapshotLike }
}

/**
 * 某个宿主插件条目的设置表单快照（@deepseek-ai/dsh-client-ui-settings 的 ConfigFormSnapshot）。
 *
 * - `value` 是当前生效值，`base` 是清掉用户覆盖后回落的组合基座，`user` **有值**才表示这个字段
 *   被用户改过（改成默认值也算改过）
 * - `revision` 是写入围栏：写入要带上读到的 revision，对不上宿主会拒（并发编辑不会静默覆盖）
 */
export interface ConfigFormSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
}

/**
 * 一个宿主插件条目的设置表单（`configForms.get(entryId)`）。
 *
 * `entryId` 是 profile patch 条目的 id（`dsh-notify`），不是包名 —— 宿主侧 dsh-settings 的
 * `describe()` 用 `entry.options.id` 派生命名空间。
 */
export interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>
  /** listener **不带参数**：要自己再读一次 getSnapshot() */
  subscribe(listener: () => void): () => void
  /** 写一个顶层字段；串行排队 + 带 revision 围栏，返回宿主是否接受（被拒时返回 false，不抛） */
  set(field: string, value: unknown): Promise<boolean>
  /** 清掉用户覆盖，回落到默认值 */
  unset(field: string): Promise<boolean>
}

/** 设置表单服务（@deepseek-ai/dsh-client-ui-settings 提供，服务名 `configForms`） */
export interface ConfigFormsService {
  get<T>(entryId: string): ConfigForm<T>
  /**
   * 宿主开始服务这些命名空间时才注册，全都没了就撤销 —— "部署里没有这个宿主插件就一点痕迹都不留"。
   * 它自己不往调用方 ctx 上挂东西，所以调用方要用 `ctx.effect` 包住。
   */
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void
}

/**
 * 插槽注册项。`id` 是槽内唯一键（这里用设置命名空间），`label` 是**函数**：
 * 注册方自己本地化，locale 变化时重新注册一份新文案。
 */
export interface SlotRegistration {
  name: string
  id: string
  order?: number
  label?: () => string
  /**
   * 注入面：`hooks` 里的每一项按名字变成组件的 `useXxx` prop（值可以是 ConfigForm 这种自带
   * `getSnapshot`/`subscribe` 的 store）；其余键原样变成组件 props。
   */
  inject?: () => unknown
}

/** 插槽服务（平台种子模块 @deepseek-ai/dsh-client-ui-slots，实现来自 dsh-client-ui-renderer） */
export interface SlotsService {
  register(registration: SlotRegistration, component: unknown): () => void
  /** 插槽被声明后才注册（没声明就等着）；声明撤掉会 dispose，再声明会重跑 */
  inject(name: string, callback: () => () => void): () => void
}

/** 浏览器半的 ctx：只需要 effect / get / inject（uiWorkspace 与 sessions 都走 get，不进门控） */
export interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): unknown
  /** 平台服务查找：`get` 不要求声明 inject（属性访问才要求） */
  get(name: string): unknown
  /**
   * 软依赖门控：这些服务齐了才跑 callback（回调收到的是子 scope）。
   *
   * 插件照旧 `inject: []` —— 设置页不是"没有它插件就没意义"的服务，headless / SDK 组合里
   * 拿不到 slots / configForms 也该照装，只是没有设置页。
   */
  inject(deps: string[], callback: (scope: ClientContext) => void): unknown
}
