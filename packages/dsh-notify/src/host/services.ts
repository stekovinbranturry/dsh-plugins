// 宿主的服务契约。只用 ctx.get(name) 拿服务，所以这里按"本插件真正用到的形状"声明，
// 不把宿主的内部包类型引进来，避免绑定非公开契约。
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type { Context }

/** 会话的存储头：meta 里有 cwd / 子代理标记，title 另有服务 */
export interface SessionHeaderLike {
  id: string
  cwd?: string
  meta?: {
    cwd?: string
    createdAt?: number
    parentSession?: string
    origin?: 'subagent'
    delegationDepth?: number
    agentPreset?: string
  }
}

/** 会话上我们真正用到的那几个读取口 */
export interface SessionLike {
  id: string
  header: SessionHeaderLike
}

export interface Sessions {
  get(id: string): SessionLike | undefined
}

export interface SessionTitleSnapshot {
  title?: string
}

/** @deepseek-ai/dsh-session-title：同步读日志折出来的标题 */
export interface SessionTitle {
  get(session: unknown): SessionTitleSnapshot | undefined
}

export interface ClientModules {
  /** bundle 内容变更进入 boot graph 的唯一入口 */
  rebuilt(id: string): string | undefined
}

export interface IndexInjectionRow {
  kind: 'global' | 'script' | 'script-src' | 'script-preload' | 'style' | 'html'
  placement?: 'head' | 'body'
  name?: string
  value?: unknown
  text?: string
  src?: string
  html?: string
}

/** SSE 长连自留 webServer：只有 exact 一种形状（JSON 方法走下面的承运通道） */
export interface WebRoute {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebServer {
  register(route: WebRoute): () => void
  readonly port: number
}

/**
 * 承运通道（ctx.connection，dsh-client-connection）。这里用到两片：
 * - fetch.register：一个方法一条精确路由，围栏与浏览器认证由它在进 handler 之前做完
 * - requestRejection：自留的 webServer 路由（SSE 长连）拿它的裁定，围栏逻辑留在承运层里
 */
export interface ConnectionTrustRequest {
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
}

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
  requestRejection(request: ConnectionTrustRequest): 401 | 403 | undefined
}

/** 结构化取服务：缺了就返回 undefined，调用方决定降级还是报错 */
export function service<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

export function sessionsOf(ctx: Context): Sessions | undefined {
  const sessions = service<Sessions>(ctx, 'sessions')
  return sessions && typeof sessions.get === 'function' ? sessions : undefined
}

export function sessionOf(ctx: Context, id: string | null | undefined): SessionLike | undefined {
  if (!id) return undefined
  try {
    return sessionsOf(ctx)?.get(id)
  } catch {
    return undefined
  }
}

export function sessionTitleOf(ctx: Context): SessionTitle | undefined {
  const titles = service<SessionTitle>(ctx, 'sessionTitle')
  return titles && typeof titles.get === 'function' ? titles : undefined
}

export function clientModulesOf(ctx: Context): ClientModules | undefined {
  const modules = service<ClientModules>(ctx, 'clientModules')
  return modules && typeof modules.rebuilt === 'function' ? modules : undefined
}

/** 会话 cwd：没有会话、没有 cwd、服务缺失都返回 null */
export function sessionCwd(ctx: Context, sessionId: string | null | undefined): string | null {
  const cwd = sessionOf(ctx, sessionId)?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

/** cwd 的目录名，作为通知里的"工作区"一行 */
export function workspaceName(cwd: string | null): string {
  if (!cwd) return ''
  const trimmed = cwd.replace(/[/\\]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at >= 0 ? trimmed.slice(at + 1) : trimmed
}

/** 子代理会话：按约定不打扰用户（可配置打开） */
export function isSubagentSession(session: SessionLike | undefined): boolean {
  const meta = session?.header?.meta
  if (!meta) return false
  if (meta.origin === 'subagent') return true
  return typeof meta.delegationDepth === 'number' && meta.delegationDepth > 0
}
