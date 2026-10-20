// 会话层：worktree 在 DSH 里"就是一个新会话"。这里只负责建会话、起标题、投递交接
// 消息，以及把 worktree 目录注册成独立项目。
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { errorText } from './git.js'
import type { Context, PromptSignal, SessionController, WorkspaceRecord, WorkspaceRegistry } from './services.js'
import { service, sessionControllerOf, sessionsOf } from './services.js'

/** 会话标题服务对标题长度有上限，先收窄再加省略号 */
const TITLE_MAX = 120

export function normalizePath(value: string): string {
  const trimmed = value.replace(/[/\\]+$/, '')
  return trimmed === '' ? value : trimmed
}

export function samePath(left: string, right: string): boolean {
  return normalizePath(resolve(left)) === normalizePath(resolve(right))
}

/** 交接消息投递用的门控信号：插件没有调用方的 signal，给一个永远不取消的实现 */
function neverAborted(): PromptSignal {
  return {
    aborted: false,
    throwIfAborted: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

export function clampTitle(title: string): string {
  const single = title.replace(/\s+/g, ' ').trim()
  return single.length <= TITLE_MAX ? single : single.slice(0, TITLE_MAX - 1) + '…'
}

/** 把 worktree 目录注册成独立项目（Q15）：同路径重复调用是幂等的 */
export async function registerProject(ctx: Context, path: string, title: string): Promise<string | null> {
  const registry = service<WorkspaceRegistry>(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.create !== 'function') return null
  try {
    const record = await registry.create(path, title)
    return typeof record?.id === 'string' ? record.id : null
  } catch {
    return null
  }
}

export interface NewSessionRequest {
  path: string
  title: string
  /** 交接消息正文；为空则不发 */
  handoff: string
  /** 已注册的项目 id；给了就用 workspaceId 建会话，会话会挂到该项目下 */
  workspaceId: string | null
  agentPreset?: string
}

export interface NewSessionResult {
  sessionId: string
  warnings: string[]
}

export async function createSession(ctx: Context, request: NewSessionRequest): Promise<NewSessionResult> {
  const controller = sessionControllerOf(ctx)
  if (!controller) throw new Error('session-controller-unavailable')
  const warnings: string[] = []
  const created = await controller.create(
    request.workspaceId === null ? { cwd: request.path } : { workspaceId: request.workspaceId },
  )
  const sessionId = created.sessionId
  try {
    await controller.rename({ sessionId, title: clampTitle(request.title) })
  } catch (error) {
    warnings.push('title-failed: ' + errorText(error))
  }
  if (request.handoff.trim() !== '') {
    try {
      await controller.prompt(
        {
          requestId: `dsh-worktree-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: request.handoff }],
        },
        neverAborted(),
      )
    } catch (error) {
      warnings.push('handoff-failed: ' + errorText(error))
    }
  }
  return { sessionId, warnings }
}

export interface SessionsAtPath {
  /** 该目录下的会话 id：登记表里的持久全集 + 活会话兜底，已去重 */
  ids: string[]
  /** 其中已经归档过的 */
  alreadyArchived: string[]
  /** 这个目录有没有被登记成工作区 */
  registered: boolean
}

/**
 * 枚举"某个目录下的所有会话"。
 *
 * 持久层只有一条路：工作区登记上的 `sessionIds`（官方文档保证它按 canonical cwd 过滤过，
 * 而且**包含已归档的会话**）。活会话再从 ctx.sessions.list() 兜一遍 ——
 * registerProject=false 时 worktree 目录根本没登记，那条路上 sessionIds 是空的。
 *
 * 两个来源都拿不到时如实回空：没有登记过的冷会话，在官方契约里就是枚举不到的。
 */
export async function sessionsAtPath(ctx: Context, path: string): Promise<SessionsAtPath> {
  const ids: string[] = []
  const alreadyArchived: string[] = []
  const seen = new Set<string>()
  let registered = false

  const registry = service<WorkspaceRegistry>(ctx, 'workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    let record: WorkspaceRecord | undefined
    try {
      record =
        typeof registry.resolveByPath === 'function'
          ? await registry.resolveByPath(path)
          : (await registry.list()).find((item) => samePath(item.path, path))
    } catch {
      record = undefined
    }
    if (record) {
      registered = true
      const archived = new Set(record.archivedSessionIds ?? [])
      for (const id of record.sessionIds ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
        if (archived.has(id)) alreadyArchived.push(id)
      }
    }
  }

  const sessions = sessionsOf(ctx)
  if (sessions && typeof sessions.list === 'function') {
    try {
      for (const session of sessions.list()) {
        const cwd = session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '' || !samePath(cwd, path)) continue
        if (seen.has(session.id)) continue
        seen.add(session.id)
        ids.push(session.id)
      }
    } catch {
      // 活会话只是兜底来源，枚举失败就不兜
    }
  }

  return { ids, alreadyArchived, registered }
}

export interface ArchiveSessionsResult {
  /** 这次真正归档掉的会话数 */
  archived: number
  /** 本来就已经归档过、跳过的会话数 */
  skipped: number
  /** 第一个归档失败的会话；非 null 时调用方应当中止删除 */
  failed: { sessionId: string; detail: string } | null
  warnings: string[]
}

/**
 * 归档该目录下的所有会话 —— 删除 worktree 的第一步。
 *
 * 活跃会话一律带 stopActivity：不带它时官方契约要求会话必须 inactive，否则直接
 * reject WorkspaceActiveSessionError，删除就永远做不成；带上则先把它正在跑的活停掉
 * （用户的选择：一次点完，接受打断）。
 *
 * 归档失败**不抛**，而是回一个 `failed`：调用方要中止删除，但"已经归档掉的那几个"
 * 是既成事实（归档可逆，unarchive 就回来了），得如实报出去，不能说"什么都没变"。
 * 服务缺失也不算失败 —— 那是部署被裁剪，降级成一条 warning，与 registerProject 同立场。
 */
export async function archiveSessionsAt(ctx: Context, path: string): Promise<ArchiveSessionsResult> {
  const warnings: string[] = []
  const found = await sessionsAtPath(ctx, path)
  const registry = service<WorkspaceRegistry>(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.archiveSession !== 'function') {
    if (found.ids.length > 0) {
      warnings.push('archive-skipped: 宿主没有 workspaceRegistry.archiveSession，这些会话没能归档')
    }
    return { archived: 0, skipped: 0, failed: null, warnings }
  }
  const already = new Set(found.alreadyArchived)
  let archived = 0
  for (const id of found.ids) {
    if (already.has(id)) continue
    try {
      await registry.archiveSession(id, { stopActivity: true })
    } catch (error) {
      return { archived, skipped: already.size, failed: { sessionId: id, detail: errorText(error) }, warnings }
    }
    archived++
  }
  return { archived, skipped: already.size, failed: null, warnings }
}

/**
 * 注销 worktree 目录的项目登记：只摘掉登记，目录与全部会话日志都留着
 * （官方 `WorkspaceRegistry.delete` 的语义就是"删登记不删东西"）。
 */
export async function unregisterProject(
  ctx: Context,
  path: string,
): Promise<{ removed: boolean; warning: string | null }> {
  const registry = service<WorkspaceRegistry>(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.delete !== 'function' || typeof registry.list !== 'function') {
    return { removed: false, warning: null }
  }
  try {
    const record =
      typeof registry.resolveByPath === 'function'
        ? await registry.resolveByPath(path)
        : (await registry.list()).find((item) => samePath(item.path, path))
    if (!record) return { removed: false, warning: null }
    await registry.delete(record.id)
    return { removed: true, warning: null }
  } catch (error) {
    return { removed: false, warning: 'project-unregister-failed: ' + errorText(error) }
  }
}

/** 供模板替换用：{name} {branch} {base} {sha} {path} {repo} {task} */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

export type { SessionController }
