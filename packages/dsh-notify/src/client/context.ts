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

/** 浏览器半的 ctx：只需要 effect / get（uiWorkspace 与 sessions 都走 get，不进门控） */
export interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): unknown
  /** 平台服务查找：`get` 不要求声明 inject（属性访问才要求） */
  get(name: string): unknown
}
