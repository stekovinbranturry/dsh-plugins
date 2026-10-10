// 会话层：worktree 在 DSH 里"就是一个新会话"。这里只负责建会话、起标题、投递交接
// 消息，以及把 worktree 目录注册成独立项目。
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { errorText } from './git.js'
import type { Context, PromptSignal, SessionController, WorkspaceRegistry } from './services.js'
import { service, sessionControllerOf } from './services.js'

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

/** 供模板替换用：{name} {branch} {base} {sha} {path} {repo} {task} */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

export type { SessionController }
