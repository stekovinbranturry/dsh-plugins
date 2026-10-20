// 宿主的服务契约。只用 ctx.get(name) 拿服务，所以这里按"本插件真正用到的形状"声明，
// 不把宿主的内部包类型引进来，避免绑定非公开契约。
// 例外是 @deepseek-ai/dsh-tools：它是真运行时 API（defineTool），按 peerDependency
// 声明并由宿主提供。
import type { Context } from '@deepseek-ai/cordis'

export type { Context }

export interface ShellResult {
  /** 0.1.7 起允许为 null：进程被信号杀掉时没有退出码 */
  exitCode: number | null
  stdout?: { text?: string }
  stderr?: { text?: string }
}

/**
 * 文件沙箱模式（@deepseek-ai/dsh-sandbox-policy）。read-only 什么都不能写；
 * workspace-write 只允许写「会话工作区」这一个根（外加宿主临时目录）；
 * danger-full-access 不限制。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 一次调用要带上的完整策略：宿主按它决定子进程的可写根 */
export interface SandboxPolicyLike {
  mode: SandboxMode | string
  /** 绝对路径；workspace-write 下就是唯一可写的根 */
  workspaceRoot?: string
}

/** 宿主 sandboxPolicy 服务：按会话解析出本次调用的策略 */
export interface SandboxPolicyService {
  resolve(request?: { session?: SessionLike; mode?: SandboxMode | string }): SandboxPolicyLike
}

export interface ShellSpec {
  command: string
  workdir?: string
  timeoutMs?: number
  stdoutMaxBytes?: number
  /**
   * 逐调用的沙箱策略。**不传就落到部署默认**：workspaceRoot = 宿主进程启动目录
   * （不是本插件的会话工作区），于是任何会话工作区外的 git 写都会被内核拒掉。
   * 与官方 bash 工具一致：按调用方会话解析后带上。
   */
  sandboxPolicy?: SandboxPolicyLike
}

/** 一次执行句柄：前台投影就是 result() */
export interface ShellExecution {
  result(): Promise<ShellResult>
}

/**
 * 宿主的 shell 能力缝，按 0.1.7 的 `ShellExecutor` 声明：`resolve(spec)` 补全默认值，
 * `execute(spec)` 起进程，`result()` 是前台投影。旧版的 `run(spec)` 已经删掉，不认。
 */
export interface Shell {
  resolve(spec: ShellSpec): unknown
  execute(spec: unknown): Promise<ShellExecution>
}

/** 会话的存储头：cwd 是创建时冻结的绝对路径 */
export interface SessionHeaderLike {
  id: string
  cwd?: string
  createdAt?: number
}

export interface SessionLike {
  id: string
  header: SessionHeaderLike
}

export interface Sessions {
  get(id: string): SessionLike | undefined
  /** 当前活着的会话；枚举"某个目录下的会话"时的兜底（登记表缺失时用） */
  list?(): SessionLike[]
}

export interface PromptSignal {
  aborted: boolean
  throwIfAborted(): void
  addEventListener(): void
  removeEventListener(): void
}

/** 宿主 sessionController 里我们真正用到的那三个方法 */
export interface SessionController {
  create(request: { cwd?: string; workspaceId?: string; sessionId?: string; agentPreset?: string }): Promise<{
    sessionId: string
    agentPreset?: string
  }>
  rename(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
  prompt(
    request: {
      requestId: string
      sessionId: string
      mode: 'queue'
      content: { type: 'text'; text: string }[]
    },
    signal?: PromptSignal,
  ): Promise<unknown>
}

export interface WorkspaceRecord {
  id: string
  path: string
  title?: string
  /**
   * 该工作区下的会话 id（官方 Workspace.sessionIds）。文档原文：持久层按会话头过滤过
   * —— 缺头、cwd 非法、canonical cwd 对不上的都不会出现在这里；已归档的会话**仍在**
   * 这个列表里（归档只是从"当前"移走），所以要配合 archivedSessionIds 跳过。
   */
  sessionIds?: readonly string[]
  /** 已经归档的会话 id；归档是幂等的，这些直接跳过 */
  archivedSessionIds?: readonly string[]
}

export interface WorkspaceRegistry {
  create(path: string, title?: string): Promise<WorkspaceRecord>
  list(): WorkspaceRecord[]
  get(id: string): WorkspaceRecord | undefined
  /**
   * 按路径找已登记的工作区（官方 dsh-workspace/lib/types/index.d.ts:264）。
   * 这是"某个目录下有哪些会话"的唯一入口：sessionIds 只能从工作区登记上拿。
   */
  resolveByPath?(path: string): Promise<WorkspaceRecord | undefined>
  /**
   * 归档一个会话：从"当前"列表移走、日志保留、可 unarchive —— 所以它不是删除。
   *
   * 官方契约（dsh-workspace/lib/types/index.d.ts:203-208）：**不带 stopActivity 时会话
   * 必须是 inactive**，否则 reject WorkspaceActiveSessionError；带 true 则不检查活跃度、
   * 直接把归档写下去，然后要求 session-stop providers 停掉它正在跑的活。
   */
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<unknown>
  /** 只注销登记，保留目录与全部会话日志（官方 dsh-workspace/lib/types/index.d.ts:180） */
  delete?(id: string): Promise<boolean>
}

export interface ClientModules {
  /** bundle 内容变更进入 boot graph 的唯一入口 */
  rebuilt(id: string): string | undefined
}

// 承运通道（ctx.connection，dsh-client-connection）：一条精确路由 = 一个插件方法，
// 信任围栏与浏览器认证由它在进 handler 之前做完
export interface ConnectionFetchRoute {
  path: string
  methods: readonly string[]
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}

export interface Connection {
  fetch: {
    register(route: ConnectionFetchRoute): () => void
  }
}

/** 结构化取服务：缺了就返回 undefined，调用方决定降级还是报错 */
export function service<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

export function shellOf(ctx: Context): Shell | undefined {
  const shell = service<Shell>(ctx, 'shell')
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') return undefined
  return shell
}

export function sessionsOf(ctx: Context): Sessions | undefined {
  const sessions = service<Sessions>(ctx, 'sessions')
  return sessions && typeof sessions.get === 'function' ? sessions : undefined
}

export function sessionControllerOf(ctx: Context): SessionController | undefined {
  const controller = service<SessionController>(ctx, 'sessionController')
  return controller && typeof controller.create === 'function' && typeof controller.prompt === 'function'
    ? controller
    : undefined
}

/** 会话 cwd：没有会话、没有 cwd、服务缺失都返回 null */
export function sessionCwd(ctx: Context, sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  const sessions = sessionsOf(ctx)
  if (!sessions) return null
  try {
    const cwd = sessions.get(sessionId)?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
  } catch {
    return null
  }
}

export function sessionOf(ctx: Context, sessionId: string | null | undefined): SessionLike | undefined {
  if (!sessionId) return undefined
  try {
    return sessionsOf(ctx)?.get(sessionId)
  } catch {
    return undefined
  }
}

export function sandboxPolicyOf(ctx: Context): SandboxPolicyService | undefined {
  const policy = service<SandboxPolicyService>(ctx, 'sandboxPolicy')
  return policy && typeof policy.resolve === 'function' ? policy : undefined
}

/**
 * 解析本次调用要带上的沙箱策略 —— 与官方 bash 工具同一套：有会话就按会话解析
 * （mode + 冻结 cwd 作为可写根），没有会话才退回部署默认。
 *
 * 宿主没挂沙箱服务（旧版/被裁掉的部署）或解析异常时返回 undefined，调用方按
 * "不限制"处理：宁可不判，也不要因为拿不到策略就拒绝一个本来能成的请求。
 */
export function resolveCallPolicy(ctx: Context, session?: SessionLike): SandboxPolicyLike | undefined {
  const policy = sandboxPolicyOf(ctx)
  if (!policy) return undefined
  try {
    const resolved = policy.resolve(session ? { session } : {})
    if (!resolved || typeof resolved !== 'object' || typeof resolved.mode !== 'string') return undefined
    return resolved
  } catch {
    return undefined
  }
}
