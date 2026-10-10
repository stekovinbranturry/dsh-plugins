// 页内提示条的状态：一个极小 observable，React 用 useSyncExternalStore 订阅。
// 纯数据 + 纯函数，行为单测直接吃这些函数（不依赖 React 渲染）。
import { MAX_TOASTS } from './constants.js'
import { formatDuration } from '../shared/duration.js'
import type { NotifyWire, Permission } from './types.js'

export interface StoreState {
  items: NotifyWire[]
  /** 未看过的通知条数：写进标签页标题，页面可见时清零 */
  unread: number
  /** 流是否已经连上（UI 可以据此提示"通知未连接"） */
  connected: boolean
  /** 客户端是否已经拿到系统通知授权 */
  permission: Permission
}

export const EMPTY_STATE: StoreState = {
  items: [],
  unread: 0,
  connected: false,
  permission: 'default',
}

export interface Store {
  getState(): StoreState
  subscribe(listener: () => void): () => void
  append(wire: NotifyWire): void
  dismiss(seq: number): void
  clear(): void
  markRead(): void
  setConnected(connected: boolean): void
  setPermission(permission: Permission): void
  /** 把一条自检的体检结论挂到那张卡片上 */
  setReport(seq: number, report: string[]): void
}

/** 最新一条在最前面，最多留 MAX_TOASTS 条；同一 seq 只进一次 */
export function reduceAppend(state: StoreState, wire: NotifyWire): StoreState {
  if (state.items.some((item) => item.seq === wire.seq)) return state
  const items = [wire, ...state.items].slice(0, MAX_TOASTS)
  return { ...state, items, unread: state.unread + 1 }
}

/** 自检结论挂到对应卡片上；卡片已经被点掉就什么也不做 */
export function reduceReport(state: StoreState, seq: number, report: string[]): StoreState {
  if (!state.items.some((item) => item.seq === seq)) return state
  return { ...state, items: state.items.map((item) => (item.seq === seq ? { ...item, report } : item)) }
}

export function reduceDismiss(state: StoreState, seq: number): StoreState {
  const items = state.items.filter((item) => item.seq !== seq)
  return items.length === state.items.length ? state : { ...state, items }
}

export function createStore(): Store {
  let state: StoreState = EMPTY_STATE
  const listeners = new Set<() => void>()

  const set = (next: StoreState): void => {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    append(wire) {
      set(reduceAppend(state, wire))
    },
    dismiss(seq) {
      set(reduceDismiss(state, seq))
    },
    clear() {
      if (state.items.length === 0) return
      set({ ...state, items: [] })
    },
    markRead() {
      if (state.unread === 0) return
      set({ ...state, unread: 0 })
    },
    setConnected(connected) {
      if (state.connected === connected) return
      set({ ...state, connected })
    },
    setPermission(permission) {
      if (state.permission === permission) return
      set({ ...state, permission })
    },
    setReport(seq, report) {
      set(reduceReport(state, seq, report))
    },
  }
}

/** 一条通知在提示条里显示的两行文字 */
export function toastLines(wire: NotifyWire): { title: string; body: string; meta: string } {
  const bodyLines: string[] = []
  if (wire.kind === 'turn-end' && wire.turn) {
    const bits: string[] = []
    if (typeof wire.turn.turn === 'number') bits.push('第 ' + wire.turn.turn + ' 轮')
    if (wire.turn.elapsedMs !== undefined) bits.push(formatDuration(wire.turn.elapsedMs))
    if (wire.turn.status === 'max-tokens') bits.push('达到输出上限')
    if (wire.turn.status === 'error') bits.push('出错')
    bodyLines.push(bits.join(' · '))
    if (wire.turn.error) bodyLines.push(wire.turn.error)
    const preview = wire.turn.reply || wire.turn.prompt || ''
    if (preview !== '') bodyLines.push(preview)
  } else if (wire.kind === 'approval' && wire.approval) {
    bodyLines.push('工具 ' + wire.approval.toolName + ' 等待授权')
    if (wire.approval.reason) bodyLines.push(wire.approval.reason)
  } else if (wire.kind === 'question' && wire.question) {
    const head = wire.question.header ? wire.question.header + '：' : ''
    bodyLines.push(head + wire.question.question)
    if (wire.question.count > 1) bodyLines.push('共 ' + wire.question.count + ' 题')
  }
  const metaBits: string[] = []
  if (wire.sessionTitle !== '') metaBits.push(wire.sessionTitle)
  if (wire.workspace !== '') metaBits.push(wire.workspace)
  return {
    title: wire.title,
    body: bodyLines.join('\n'),
    meta: metaBits.join(' · '),
  }
}
