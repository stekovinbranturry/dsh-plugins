// 浏览器半用到的契约。DSH 客户端服务（uiWorkspace / slots）由平台在运行时提供，插件不该
// 依赖它们的内部类型，所以按"真正用到的那几个方法"声明。
import type { BranchItem, WorktreeItem } from '../shared/types.js'

/** 当前会话列表快照里我们真正要用的两样：选中项与每行的 cwd/更新时间 */
export interface SessionSummaryClient {
  id: string
  cwd?: string
  updatedAt?: number
}

export interface SessionListState {
  current?: string
  byId: Record<string, SessionSummaryClient>
}

/** 工作区快照（@deepseek-ai/dsh-api-workspace-controller 的 WorkspaceSnapshot 子集） */
export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
  createdAt: string
}

export interface WorkspaceSnapshot {
  items: readonly WorkspaceView[]
}

/**
 * 界面的导航服务（@deepseek-ai/dsh-client-ui-workspace 提供，服务名 `uiWorkspace`）。
 *
 * 0.1.7 把 `sessions.open(id)` 整个删了（0.1.5 的 ClientSessions 还剩 `manager.select`），
 * 切主视图的动作搬到这里 —— 官方侧边栏的会话行就是 `uiWorkspace.openSession(sessionId)`。
 */
export interface UiWorkspaceService {
  openSession(sessionId: string): void
}

/** 插槽注册：只用到 name/id/order/registrant */
export interface SlotRegistration {
  name: string
  id: string
  order?: number
  registrant?: string
}

export interface SlotsService {
  /** 第二个参数是占用者组件：平台会带 ownerProps + 标准 props 调用它 */
  register(registration: SlotRegistration, component: (props: SlotStandardProps) => unknown): () => void
  inject(name: string, callback: () => () => void): () => void
}

/** 浏览器半的 ctx：只需要 effect / get / slots（uiWorkspace 走 get，不进门控） */
export interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): unknown
  /** 平台服务查找：`get` 不要求声明 inject（属性访问才要求） */
  get(name: string): unknown
  slots: SlotsService
}

/** 插槽宿主传给占用者的标准 props */
export interface SlotStandardProps {
  useWorkspaces: <S>(selector: (state: WorkspaceSnapshot) => S) => S
  useSessions: <S>(selector: (state: SessionListState) => S) => S
  /**
   * 侧边栏是展开列（true）还是收起的窄轨（false）。官方 settings 触发器用同一个
   * 标志决定"图标 + 文字"还是"只有图标"，入口要跟它长得一样就必须吃这个标志。
   */
  wide?: boolean
}

export interface ContextResult {
  ok: true
  repoRoot: string
  worktreeRoot: string
  items: WorktreeItem[]
  branches: BranchItem[]
  warnings: string[]
}

export interface ErrorResult {
  ok: false
  error: string
  detail?: string
  warnings?: string[]
  /**
   * 失败之前已经有副作用落下了（删除 worktree 才会用到）：归档会话与注销工作区登记在
   * 删目录之前，删目录那一步失败时它们已经生效了 —— 这时不能说「什么都没变」。
   */
  partial?: boolean
}

export interface CreateResult {
  ok: true
  item: WorktreeItem
  warnings: string[]
  sessionId?: string
}

export interface OpenResult {
  ok: true
  sessionId: string
  title: string
  path: string
  branch: string | null
  warnings: string[]
}

export interface RemoveResult {
  ok: true
  name: string
  path: string
  /** 这个 worktree 检出的分支；detached 时为 null */
  branch: string | null
  /** `remove` = 目录还在，走 git worktree remove；`prune` = 目录本来就不在了，只清元数据 */
  how: 'remove' | 'prune'
  /** 这次真正归档掉的会话数 */
  archived: number
  /** 本来就已经归档过、这次跳过的会话数 */
  alreadyArchived: number
  /** 真正删掉的本地分支；没删成（detached / 没勾 / git 拒绝）时为 null */
  branchDeleted: string | null
  /** 真正删掉的远端分支；没删成时为 null */
  remoteDeleted: string | null
  warnings: string[]
}
