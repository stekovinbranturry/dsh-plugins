// 通知中枢：去重、渲染正文、然后往两条出口送 —— 客户端 SSE 流、外部 webhook。
// 所有副作用都收敛在这里，事件接线（events.ts）只负责"什么时候该通知"。
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { NotifyConfig } from './config.js'
import {
  FALLBACK_SESSION_TITLE,
  HEARTBEAT_MS,
  STREAM_PATH,
  TURN_STATUS_LABEL,
  WEBHOOK_TIMEOUT_MS,
} from './constants.js'
import { errText } from './http.js'
import { sessionsOf, sessionOf, sessionTitleOf, workspaceName } from './services.js'
import { channelsOf } from '../shared/channels.js'
import { formatDuration } from '../shared/duration.js'
import type { NotifyKind, NotifyWire, TurnEndPayload } from '../shared/types.js'

interface ClientConnection {
  id: number
  res: ServerResponse
}

/** 会话上"上一次看到的东西"：完成通知的正文靠它拼 */
interface SessionMemo {
  lastPrompt: string
  lastReply: string
}

export interface NotifySources {
  /** webhook 的 POST body 里带一份人话正文，方便机器人直接转发 */
  text: string
}

/** 一段时间内同一来源只通知一次（同一 subagent 反复触发同一审批时压掉重复） */
const DEDUP_MS = 2_000
const MEMO_LIMIT = 400

export class Notifier {
  private readonly ctx: Context
  private config: NotifyConfig
  private readonly clients = new Map<number, ClientConnection>()
  private readonly seen = new Map<string, number>()
  private readonly turns = new Map<string, number>()
  private readonly memo = new Map<string, SessionMemo>()
  private seq = 0
  private clientSeq = 0
  private heartbeat: NodeJS.Timeout | null = null
  private lastWire: NotifyWire | null = null
  private lastText = ''
  private delivered = 0

  constructor(ctx: Context, config: NotifyConfig) {
    this.ctx = ctx
    this.config = config
  }

  /** 事件接线层需要会话服务时用它 */
  get context(): Context {
    return this.ctx
  }

  updateConfig(config: NotifyConfig): void {
    this.config = config
  }

  getConfig(): NotifyConfig {
    return this.config
  }

  get lastNotification(): { wire: NotifyWire; text: string } | null {
    if (!this.lastWire) return null
    return { wire: this.lastWire, text: this.lastText }
  }

  get clientCount(): number {
    return this.clients.size
  }

  get deliveredCount(): number {
    return this.delivered
  }

  endpoint(): string {
    return STREAM_PATH
  }

  /** 这条来源最近是否已经通知过（构建之前调用，重复的直接不构建） */
  claim(key: string): boolean {
    const now = Date.now()
    const at = this.seen.get(key)
    if (at !== undefined && now - at < DEDUP_MS) return false
    this.seen.set(key, now)
    // 顺手清过期项，sessionId 数量级很小，不需要更聪明的结构
    if (this.seen.size > 256) {
      for (const [k, v] of this.seen) {
        if (now - v >= DEDUP_MS) this.seen.delete(k)
      }
    }
    return true
  }

  noteTurnStart(sessionId: string): void {
    this.turns.set(sessionId, Date.now())
    const memo = this.memo.get(sessionId) ?? { lastPrompt: '', lastReply: '' }
    memo.lastPrompt = ''
    memo.lastReply = ''
    this.memo.set(sessionId, memo)
  }

  noteUserMessage(sessionId: string, text: string): void {
    if (text === '') return
    const memo = this.memo.get(sessionId) ?? { lastPrompt: '', lastReply: '' }
    memo.lastPrompt = text.slice(0, MEMO_LIMIT)
    memo.lastReply = ''
    this.memo.set(sessionId, memo)
  }

  noteAssistantMessage(sessionId: string, text: string): void {
    if (text === '') return
    const memo = this.memo.get(sessionId) ?? { lastPrompt: '', lastReply: '' }
    memo.lastReply = text.slice(0, MEMO_LIMIT)
    this.memo.set(sessionId, memo)
  }

  /** 收尾：返回本轮耗时并从计时表里移除 */
  takeElapsed(sessionId: string): number | undefined {
    const started = this.turns.get(sessionId)
    this.turns.delete(sessionId)
    return started === undefined ? undefined : Math.max(0, Date.now() - started)
  }

  memoFor(sessionId: string): SessionMemo {
    return this.memo.get(sessionId) ?? { lastPrompt: '', lastReply: '' }
  }

  forgetSession(sessionId: string): void {
    this.turns.delete(sessionId)
    this.memo.delete(sessionId)
  }

  /**
   * 组装一条通知（同步、无 I/O），然后交给 deliver。返回 null 表示这条不该发。
   * `input.title` 由调用方按"事件 + 会话标题"拼好。
   */
  publishFull(input: Omit<NotifyWire, 'seq' | 'at'>): NotifyWire | null {
    const config = this.config
    if (!this.kindEnabled(input.kind)) return null
    if (!config.ack && !config.browser && !config.sound && !config.title
      && config.webhookUrl === '') {
      return null
    }
    const wire: NotifyWire = { seq: ++this.seq, at: Date.now(), ...input }
    this.lastWire = wire
    this.lastText = this.renderText(wire)
    this.deliver(wire)
    return wire
  }

  private kindEnabled(kind: NotifyKind): boolean {
    if (kind === 'turn-end') return this.config.notifyOnTurnEnd
    if (kind === 'approval') return this.config.notifyOnApproval
    return this.config.notifyOnQuestion
  }

  private deliver(wire: NotifyWire): void {
    const text = this.lastText

    this.broadcast(wire)
    this.delivered += 1

    if (this.config.webhookUrl !== '') this.postWebhook(wire, text)
  }

  /** 一次追踪到底的后台任务：宿主卸载时 disposer 会等它结束 */
  private track(task: () => Promise<void>): void {
    try {
      this.ctx.effect(async () => {
        try {
          await task()
        } catch (error) {
          this.warn('background notify failed: ' + errText(error))
        }
        return () => {}
      }, 'dsh-notify: background')
    } catch (error) {
      this.warn('cannot track background notify: ' + errText(error))
    }
  }

  /** 给全部挂着的浏览器连推送一帧；断掉的连接顺手清掉 */
  private broadcast(wire: NotifyWire): void {
    if (this.clients.size === 0) return
    const frame = 'event: notify\ndata: ' + JSON.stringify(wire) + '\n\n'
    for (const [id, client] of this.clients) {
      try {
        client.res.write(frame)
      } catch (error) {
        this.clients.delete(id)
        this.warn('client ' + id + ' write failed: ' + errText(error))
      }
    }
  }

  private postWebhook(wire: NotifyWire, text: string): void {
    const url = this.config.webhookUrl
    const headers = this.config.webhookHeaders
    this.track(async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ ...wire, text }),
          signal: controller.signal,
        })
        if (!response.ok) this.warn('webhook HTTP ' + response.status)
      } finally {
        clearTimeout(timer)
      }
    })
  }

  /** 一条通知的人话正文（给 webhook / 日志） */
  renderText(wire: NotifyWire): string {
    return wire.title + '：' + this.renderBody(wire)
  }

  /** 通知正文：一行是事件，一行是会话/工作区提示 */
  renderBody(wire: NotifyWire): string {
    const lines: string[] = []
    if (wire.kind === 'turn-end' && wire.turn) {
      lines.push(this.turnLine(wire.turn))
    } else if (wire.kind === 'approval' && wire.approval) {
      const reason = wire.approval.reason ? ' · ' + wire.approval.reason : ''
      lines.push('工具 ' + wire.approval.toolName + ' 等待授权' + reason)
    } else if (wire.kind === 'question' && wire.question) {
      const more = wire.question.count > 1 ? '（共 ' + wire.question.count + ' 题）' : ''
      lines.push((wire.question.header ? wire.question.header + '：' : '') + wire.question.question + more)
    }
    const where = wire.sessionTitle !== '' ? wire.sessionTitle : FALLBACK_SESSION_TITLE
    const place = wire.workspace !== '' ? ' · ' + wire.workspace : ''
    lines.push(where + place)
    if (this.config.showPreview && wire.kind === 'turn-end' && wire.turn) {
      const preview = wire.turn.reply || wire.turn.prompt || ''
      if (preview !== '') lines.push('“' + preview + '”')
    }
    return lines.join('\n')
  }

  private turnLine(turn: TurnEndPayload): string {
    const status = TURN_STATUS_LABEL[turn.status]
    // 拿不到轮次就不写数字：宁可只说状态，也不写"第 undefined 轮"
    const bits = [typeof turn.turn === 'number' ? '第 ' + turn.turn + ' 轮 ' + status : status]
    if (turn.elapsedMs !== undefined) bits.push(formatDuration(turn.elapsedMs))
    if (turn.status === 'error' && turn.error) bits.push(turn.error)
    return bits.join(' · ')
  }

  /** 浏览器半的 SSE 入口；由 index.ts 注册到 webServer */
  handleStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const id = ++this.clientSeq
    this.clients.set(id, { id, res })
    res.write('event: hello\ndata: ' + JSON.stringify({
      ok: true,
      endpoint: STREAM_PATH,
      channels: channelsOf(this.config),
    }) + '\n\n')
    this.ensureHeartbeat()

    const drop = (): void => {
      if (this.clients.delete(id)) this.stopHeartbeatIfIdle()
    }
    res.on('close', drop)
    res.on('error', drop)
    req.on('close', drop)
    this.log('client ' + id + ' attached (now ' + this.clients.size + ')')
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      for (const [id, client] of this.clients) {
        try {
          client.res.write(': ping\n\n')
        } catch {
          this.clients.delete(id)
        }
      }
      this.stopHeartbeatIfIdle()
    }, HEARTBEAT_MS)
    // 心跳不应该拖着进程不退出
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref()
  }

  private stopHeartbeatIfIdle(): void {
    if (this.heartbeat && this.clients.size === 0) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  dispose(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const client of this.clients.values()) {
      try {
        client.res.end()
      } catch {
        // 已经断了就算了
      }
    }
    this.clients.clear()
  }

  /** 当前配置快照（给客户端 GET state） */
  snapshot(): {
    ack: boolean
    browser: boolean
    sound: boolean
    title: boolean
    showPreview: boolean
    notifyOnTurnEnd: boolean
    notifyOnApproval: boolean
    notifyOnQuestion: boolean
    includeSubagents: boolean
  } {
    const c = this.config
    return {
      ack: c.ack,
      browser: c.browser,
      sound: c.sound,
      title: c.title,
      showPreview: c.showPreview,
      notifyOnTurnEnd: c.notifyOnTurnEnd,
      notifyOnApproval: c.notifyOnApproval,
      notifyOnQuestion: c.notifyOnQuestion,
      includeSubagents: c.includeSubagents,
    }
  }

  /** 会话标题与工作区名：标题服务缺失时退化成空串，不抛 */
  describeSession(sessionId: string): { sessionTitle: string; workspace: string } {
    let sessionTitle = ''
    let workspace = ''
    try {
      const session = sessionOf(this.ctx, sessionId)
      const titleService = sessionTitleOf(this.ctx)
      if (session && titleService) {
        const snapshot = titleService.get(session)
        if (snapshot && typeof snapshot.title === 'string') sessionTitle = snapshot.title
      }
      workspace = workspaceName(session?.header?.cwd ?? null)
    } catch (error) {
      this.warn('session describe failed: ' + errText(error))
    }
    return { sessionTitle, workspace }
  }

  /** 会话在注册表里还在不在（宿主半只对活会话发通知） */
  sessionAlive(sessionId: string): boolean {
    try {
      return sessionsOf(this.ctx)?.get(sessionId) !== undefined
    } catch {
      return false
    }
  }

  log(message: string): void {
    console.log('[dsh-notify] ' + message)
  }

  warn(message: string): void {
    console.warn('[dsh-notify] ' + message)
  }
}

/** 1h2m3s / 2m3s / 3s */
