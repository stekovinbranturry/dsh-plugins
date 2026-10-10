// 事件接线：只回答"什么时候该通知"，正文与投递都在 Notifier 里。
//
// 三类来源：
//   1. `session/event` 的 turn/start + turn/end —— 一次会话跑完（含出错 / 达到输出上限）
//   2. `approval/request` —— 有工具在等用户点同意
//   3. `user-questions/request` —— 有题目在等用户回答
//
// 2 与 3 都是 Cordis waterfall：监听器必须调用 next() 把决定权交回下游，自己绝不能
// 返回一个 outcome/answer 去"替用户点同意"。通知只是旁路。
//
// session/event 是同步 emit，回调里不能有 I/O（会拖慢 Session.append 的观察者阶段），
// 所以这里只做纯计算 + Notifier 内部的异步投递。
import type { Context } from '@deepseek-ai/cordis'

import { KIND_LABEL, PREVIEW_LIMIT } from './constants.js'
import type { Notifier } from './notifier.js'
import { isSubagentSession, sessionOf } from './services.js'
import { plainText } from './text.js'
import type { TurnStatus } from '../shared/types.js'

type SessionEventHandler = (session: unknown, event: unknown) => void

/**
 * `session/event` 的信封是 `{ type, seq, time, data }` —— 载荷在 `data` 里，不在事件顶层。
 * 曾经按顶层读 `event.turn` / `event.message`，结果轮次永远 0、预览永远空、去重键恒定。
 */
interface SessionLikeEvent {
  type?: unknown
  seq?: unknown
  data?: unknown
}

interface TurnEventData {
  turn?: unknown
  reason?: unknown
}

interface AssistantMessageData {
  message?: unknown
}

interface ApprovalRequestLike {
  agent?: { id?: unknown }
  toolName?: unknown
  callId?: unknown
  reason?: unknown
}

interface QuestionRequestLike {
  agent?: { id?: unknown }
  questions?: unknown
}

interface QuestionItemLike {
  id?: unknown
  header?: unknown
  question?: unknown
}

/** 通知标题 = 事件类别 + 会话标题 */
function composeTitle(kind: keyof typeof KIND_LABEL, sessionTitle: string): string {
  const label = KIND_LABEL[kind]
  return sessionTitle === '' ? label : label + ' · ' + sessionTitle
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function agentSessionId(agent: unknown): string {
  if (typeof agent === 'string') return agent
  if (agent !== null && typeof agent === 'object') {
    const id = (agent as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return ''
}

function turnStatusOf(reason: unknown): TurnStatus {
  const kind = reason !== null && typeof reason === 'object'
    ? (reason as { kind?: unknown }).kind
    : undefined
  if (kind === 'max-tokens') return 'max-tokens'
  if (kind === 'error') return 'error'
  return 'completed'
}

function errorTextOf(reason: unknown): string | undefined {
  if (reason === null || typeof reason !== 'object') return undefined
  const error = (reason as { error?: unknown }).error
  if (error === null || error === undefined) return undefined
  if (typeof error === 'string') return error
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/**
 * 子代理会话默认静音。返回 true 表示这条不该发。
 * turn-end / approval / question 三类来源共用这一处判断，不再各写一遍。
 */
function silencedSubagent(notifier: Notifier, sessionId: string): boolean {
  return isSubagentSession(sessionOf(notifier.context, sessionId))
    && !notifier.getConfig().includeSubagents
}

export function wireNotifyEvents(ctx: Context, notifier: Notifier): void {
  // Cordis 的事件名是字符串索引的，宿主包的类型增强不一定被本包看到；这里显式断言成
  // 我们真正读的字段形状，剩下的用 unknown 收敛。
  const onSessionEvent = ((session: unknown, event: unknown): void => {
    try {
      handleSessionEvent(notifier, session, event)
    } catch (error) {
      notifier.warn('session event handler failed: ' + String(error))
    }
  }) as SessionEventHandler

  ctx.on('session/event' as never, onSessionEvent as never)

  ctx.on('approval/request' as never, (async (req: ApprovalRequestLike, next: () => Promise<unknown>) => {
    try {
      notifyApproval(ctx, notifier, req)
    } catch (error) {
      notifier.warn('approval hook failed: ' + String(error))
    }
    return await next()
  }) as never)

  ctx.on('user-questions/request' as never, (async (req: QuestionRequestLike, next: () => Promise<unknown>) => {
    try {
      notifyQuestion(ctx, notifier, req)
    } catch (error) {
      notifier.warn('question hook failed: ' + String(error))
    }
    return await next()
  }) as never)
}

function handleSessionEvent(notifier: Notifier, session: unknown, raw: unknown): void {
  const event = (raw ?? {}) as SessionLikeEvent
  const id = session !== null && typeof session === 'object'
    ? stringOf((session as { id?: unknown }).id)
    : ''
  if (id === '') return
  const type = stringOf(event.type)

  if (type === 'turn/start') {
    notifier.noteTurnStart(id)
    return
  }

  if (type === 'user/message') {
    // user/message 的 data 就是 UserMessage 本身（agent-loop 直接 append 了 message），
    // 没有 message 包装层；assistant/message 才是 { turn, step, message }
    notifier.noteUserMessage(id, plainText(event.data, PREVIEW_LIMIT))
    return
  }

  if (type === 'assistant/message') {
    const message = (event.data as AssistantMessageData | undefined)?.message
    notifier.noteAssistantMessage(id, plainText(message, PREVIEW_LIMIT))
    return
  }

  if (type !== 'turn/end') return

  const data = (event.data ?? {}) as TurnEventData
  const reason = data.reason
  // 连 reason 都没有（比如老形状把字段摊在信封顶层）就不是我们能描述的一条 turn/end，跳过；
  // 少了 reason 就写不出状态，发出去只会是一条没内容的通知
  if (reason === undefined || reason === null) {
    notifier.warn('turn/end without a reason; skipping')
    notifier.takeElapsed(id)
    return
  }
  const status = turnStatusOf(reason)
  // aborted / interrupted 是用户自己打断或崩溃补记，不该再弹一条
  const kind = typeof reason === 'object'
    ? (reason as { kind?: unknown }).kind
    : undefined
  if (kind === 'aborted' || kind === 'interrupted') {
    notifier.takeElapsed(id)
    return
  }
  if (id === '' || !notifier.sessionAlive(id)) return

  // 拿不到轮次：正文里不写轮次（也没法写），但这条通知照发 —— 少一个数字，好过少一条通知。
  // 去重键必须逐事件唯一，这时用信封里的 seq 兜底；否则所有轮次会撞成同一个键、只发得出第一条。
  const turn = typeof data.turn === 'number' ? data.turn : undefined
  if (turn === undefined) notifier.warn('turn/end without a turn number; falling back to seq for dedup')
  const seq = typeof event.seq === 'number' ? event.seq : undefined
  const dedupKey = turn !== undefined
    ? 'turn:' + id + ':' + turn
    : 'turn:' + id + ':seq:' + String(seq)
  if (!notifier.claim(dedupKey)) return

  if (silencedSubagent(notifier, id)) return

  const memo = notifier.memoFor(id)
  const elapsedMs = notifier.takeElapsed(id)
  const { sessionTitle, workspace } = notifier.describeSession(id)
  const config = notifier.getConfig()

  notifier.publishFull({
    kind: 'turn-end',
    title: composeTitle('turn-end', sessionTitle),
    sessionId: id,
    sessionTitle,
    workspace,
    turn: {
      turn,
      status,
      elapsedMs,
      error: status === 'error' ? errorTextOf(reason) : undefined,
      prompt: config.showPreview && memo.lastPrompt !== '' ? memo.lastPrompt : undefined,
      reply: config.showPreview && memo.lastReply !== '' ? memo.lastReply : undefined,
    },
  })
}

function notifyApproval(ctx: Context, notifier: Notifier, req: ApprovalRequestLike): void {
  // 这一类是否开着由 publishFull 的 kindEnabled 统一裁决，这里不再重复判断
  const sessionId = agentSessionId(req.agent)
  if (sessionId === '' || !notifier.sessionAlive(sessionId)) return
  const callId = stringOf(req.callId)
  const toolName = stringOf(req.toolName)
  const key = 'approval:' + sessionId + ':' + toolName + ':' + callId
  if (!notifier.claim(key)) return

  if (silencedSubagent(notifier, sessionId)) return

  const { sessionTitle, workspace } = notifier.describeSession(sessionId)
  notifier.publishFull({
    kind: 'approval',
    title: composeTitle('approval', sessionTitle),
    sessionId,
    sessionTitle,
    workspace,
    approval: {
      toolName: toolName === '' ? '未知工具' : toolName,
      reason: stringOf(req.reason) || undefined,
      callId: callId === '' ? undefined : callId,
    },
  })
}

function notifyQuestion(ctx: Context, notifier: Notifier, req: QuestionRequestLike): void {
  const sessionId = agentSessionId(req.agent)
  if (sessionId === '' || !notifier.sessionAlive(sessionId)) return

  const items = Array.isArray(req.questions) ? (req.questions as QuestionItemLike[]) : []
  const first = items[0]
  if (!first) return
  const key = 'question:' + sessionId + ':' + stringOf(first.id) + ':' + plainText(first.question, 40)
  if (!notifier.claim(key)) return

  if (silencedSubagent(notifier, sessionId)) return

  const { sessionTitle, workspace } = notifier.describeSession(sessionId)
  notifier.publishFull({
    kind: 'question',
    title: composeTitle('question', sessionTitle),
    sessionId,
    sessionTitle,
    workspace,
    question: {
      header: stringOf(first.header) || undefined,
      question: plainText(first.question, PREVIEW_LIMIT),
      count: items.length,
    },
  })
}
