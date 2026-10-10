#!/usr/bin/env node
// 浏览器半的测试：先在一个最小 DOM 桩里加载真的 dist/client.js（验信封 + 挂载 + 订阅），
// 再直接吃 test/.build/client-logic.cjs 里的纯逻辑（状态垫层、meta 解析、控制面分支）。
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { check, eq, report } from './harness.mjs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// 这个文件是 ESM：自检那一段要真的 await（宿主往返 + 系统通知探测）。
// 几个 CJS 依赖（React / 编译出来的测试产物）用 createRequire 拿。
const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(ROOT, 'dist', 'client.js')


// ── 1. 真 bundle：在 DOM 桩里跑一遍 ModuleLoader 信封 ────────────────────
console.log('\n== client bundle ==')

const loaded = new Map()
globalThis.window = globalThis
globalThis.window.__ModuleLoader__ = {
  load(entry) {
    loaded.set(entry.id, entry.factory)
  },
}

const styleNodes = []
const created = []
function makeElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    attributes: {},
    children: [],
    textContent: '',
    parentNode: null,
    style: {},
    setAttribute(name, value) {
      node.attributes[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null
    },
    appendChild(child) {
      node.children.push(child)
      child.parentNode = node
      return child
    },
    removeChild(child) {
      node.children = node.children.filter((item) => item !== child)
      return child
    },
    querySelector() {
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }
  created.push(node)
  return node
}

const head = makeElement('head')
const body = makeElement('body')
const listeners = new Map()

globalThis.document = {
  head,
  body,
  title: 'DSH',
  visibilityState: 'visible',
  createElement: makeElement,
  querySelector(selector) {
    if (selector === 'meta[name="dsh-notify"]') return null
    return null
  },
  addEventListener(name, listener) {
    listeners.set(name, listener)
  },
  removeEventListener(name) {
    listeners.delete(name)
  },
}
globalThis.AudioContext = undefined
// 系统通知的桩：初始没授权，requestPermission() 之后给 granted。
// 这是"切到别的软件还能收到通知"那条路的开关，必须能测。
// 必须是可真构造的：自检要用 `new Notification(...)` 探一条出来，只会传对象会探失败，
// 体检结论就会误报"被系统挡了"。
let permissionCalls = 0
function NotificationStub(title, options) {
  this.title = title
  this.options = options
  this.closed = false
  this.close = () => { this.closed = true }
  NotificationStub.instances.push(this)
}
NotificationStub.permission = 'default'
NotificationStub.instances = []
NotificationStub.requestPermission = async () => {
  permissionCalls++
  NotificationStub.permission = 'granted'
  return 'granted'
}
globalThis.Notification = NotificationStub
const windowListeners = new Map()
globalThis.window.addEventListener = (name, listener) => {
  windowListeners.set(name, listener)
}
globalThis.window.removeEventListener = (name) => {
  windowListeners.delete(name)
}

// 客户端唯一的外部出口是 fetch（问宿主状态 / 自检）；单测里给它一个立刻返回的桩，
// 免得真去打网络
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    ok: true,
    webhook: { attempted: false, ok: false },
    clients: 1,
  }),
})

const opened = []
globalThis.EventSource = class FakeEventSource {
  constructor(url) {
    this.url = url
    this.handlers = {}
    opened.push(this)
  }
  addEventListener(name, listener) {
    this.handlers[name] = listener
  }
  removeEventListener(name) {
    delete this.handlers[name]
  }
  close() {
    this.closed = true
  }
  emit(name, payload) {
    if (this.handlers[name]) this.handlers[name](payload)
  }
}

const seedReact = require('react')
const seedReactDomClient = require('react-dom/client')
const roots = []// 只给测试用一份 root 桩：真 createRoot 要真 DOM，这里只关心"渲染了什么、卸载了没"
seedReactDomClient.createRoot = (container) => {
  const root = { container, rendered: [], unmounted: false }
  root.render = (element) => {
    root.rendered.push(element)
  }
  root.unmount = () => {
    root.unmounted = true
  }
  roots.push(root)
  return root
}

const SEEDS = {
  react: seedReact,
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-dom': require('react-dom'),
  'react-dom/client': seedReactDomClient,
  // 平台种子模块（shell 运行时提供，npm 上没有）：真 bundle 里是 require 出来的，
  // 给它一份替身，替身与 test 构建的 alias 共用同一份
  '@deepseek-ai/dsh-client-ui-primitives': require(path.join(ROOT, 'test', 'primitives-shim.cjs')),
}

const bundleSource = fs.readFileSync(BUNDLE, 'utf8')
check(bundleSource.startsWith('window.__ModuleLoader__.load({'), 'bundle registers through the module loader')
// 在真实全局作用域里跑：bundle 是 classic script，只用 window / document / EventSource 这些裸全局，
// 没有 import，所以 runInThisContext 就是它真实的运行环境（用 vm sandbox 反而隔离掉了这些桩）
vm.runInThisContext(bundleSource, { filename: 'client.js' })

check(loaded.has('dsh-notify'), 'bundle declares the dsh-notify module id')
const factory = loaded.get('dsh-notify')
const exportsObject = factory((id) => {
  if (!SEEDS[id]) throw new Error('unexpected require: ' + id)
  return SEEDS[id]
})
eq(exportsObject.name, 'dsh-notify', 'client module exports its name')
eq(typeof exportsObject.apply, 'function', 'client module exports apply()')

// apply 的 ctx：只要 effect / get（跳转走 uiWorkspace 服务，0.1.7 的 sessions.open 已删）
const disposers = []
const openedSessions = []
const uiWorkspace = { openSession: (id) => openedSessions.push(id) }
// 会话控制器的替身：快照形状就是官方那份，只有 sess-current 的 mainView 引用计数为正。
// 探针读的就是 byId[id].retainedBy.mainView（官方 ui-session 的 isMain() 同款判据）。
const sessionsStub = {
  list: {
    getSnapshot: () => ({
      byId: {
        'sess-current': { retainedBy: { mainView: 1 } },
        'sess-other': { retainedBy: { mainView: 0 } },
      },
    }),
  },
}
const applyCtx = {
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  get: (key) => {
    if (key === 'uiWorkspace') return uiWorkspace
    if (key === 'sessions') return sessionsStub
    return undefined
  },
}
exportsObject.apply(applyCtx)
check(disposers.length >= 2, 'apply() registers its disposers through ctx.effect')
check(head.children.some((node) => node.tagName === 'STYLE'), 'apply() inserts its stylesheet')
check(body.children.some((node) => node.getAttribute('data-dsh-notify-root') !== null), 'apply() mounts its toast root')
eq(roots.length, 1, 'apply() creates exactly one React root')
eq(opened.length, 1, 'apply() opens exactly one notification stream')
eq(opened[0].url, '/dsh-notify/stream', 'the stream uses the default endpoint when the meta is missing')
eq(globalThis.window.__dshNotifyTest !== undefined, true, 'apply() exposes the console self-test hook')
check(typeof globalThis.window.__dshNotifyAsk === 'function', 'apply() exposes the permission hook')
check(windowListeners.has('pointerdown'), 'apply() arms the first-gesture permission request')

// 跳回对话：0.1.7 走 uiWorkspace.openSession（sessions.open 已经不存在了）
eq(globalThis.window.__dshNotifyOpen('sess-1'), true, 'the self-test hook can jump back to a session')
eq(openedSessions[0], 'sess-1', 'it uses uiWorkspace.openSession with the id it was given')
eq(globalThis.window.__dshNotifyOpen(''), false, 'an empty id is refused instead of navigated to')
const realGet = applyCtx.get
applyCtx.get = () => undefined
eq(globalThis.window.__dshNotifyOpen('sess-2'), false, '没有 uiWorkspace 时返回 false，不抛也不误跳')
applyCtx.get = realGet

// 第一次交互：应当真的去申请授权（这是切走之后还能收到通知的前提）
eq(permissionCalls, 0, 'permission is not asked before any gesture')
const gesture = windowListeners.get('pointerdown')
eq(typeof gesture, 'function', 'the gesture listener is callable')
void gesture()
const permissionDeadline = Date.now() + 500
while (permissionCalls === 0 && Date.now() < permissionDeadline) {
  // 授权是异步的：这里同步等一小会儿，好让断言不必进 async 函数
  const started = Date.now()
  while (Date.now() - started < 5) {
    /* spin */
  }
}
eq(permissionCalls, 1, 'the first gesture asks for notification permission')

// 页面侧收到一帧后应该出现提示条
const stream = opened[0]
stream.emit('notify', {
  data: JSON.stringify({
    seq: 1,
    kind: 'approval',
    at: Date.now(),
    title: '需要 Approve · 修登录超时',
    sessionId: 'sess-1',
    sessionTitle: '修登录超时',
    workspace: 'proj',
    approval: { toolName: 'bash', reason: '要跑 rm -rf' },
  }),
})
eq(roots[0].rendered.length >= 2, true, 'a notify frame triggers a re-render')
const tree = roots[0].rendered[roots[0].rendered.length - 1]
const cards = JSON.stringify(tree) === undefined ? null : tree
check(cards !== null && tree.type !== undefined, 'the toast stack renders an element')

// 当前对话不通知（端到端）：apply 里的探针真的读到了 ctx.get('sessions') 的
// retainedBy.mainView。正看着的那个对话不该再弹，别的对话照旧弹。
const rendersBeforeCurrent = roots[0].rendered.length
stream.emit('notify', {
  data: JSON.stringify({
    seq: 2,
    kind: 'turn-end',
    at: Date.now(),
    title: '会话完成',
    sessionId: 'sess-current',
    sessionTitle: '正看着的这个',
    workspace: 'proj',
    turn: { turn: 4, status: 'completed', elapsedMs: 1_000, reply: 'done' },
  }),
})
eq(roots[0].rendered.length, rendersBeforeCurrent, '正在看的对话：不再弹提示条（不触发重渲染）')
stream.emit('notify', {
  data: JSON.stringify({
    seq: 3,
    kind: 'turn-end',
    at: Date.now(),
    title: '会话完成',
    sessionId: 'sess-other',
    sessionTitle: '别的对话',
    workspace: 'proj',
    turn: { turn: 5, status: 'completed', elapsedMs: 2_000, reply: 'done' },
  }),
})
eq(roots[0].rendered.length > rendersBeforeCurrent, true, '别的对话：照旧弹')

// 断流 / 卸载路径不该抛
stream.emit('error', {})
for (const dispose of disposers) dispose()
check(roots[0].unmounted === true, 'disposing the plugin unmounts the React root')
check(stream.closed === true, 'disposing the plugin closes the stream')
check(globalThis.window.__dshNotifyTest === undefined, 'disposing removes the console hook')

// ── 2. 纯逻辑 ─────────────────────────────────────────────────────────────
console.log('\n== client logic ==')
const logic = await import(path.join(ROOT, 'test', '.build', 'client-logic.cjs'))

const wire = (over) => ({
  seq: 1,
  kind: 'turn-end',
  at: 0,
  title: 't',
  sessionId: 's',
  sessionTitle: 'st',
  workspace: 'ws',
  turn: { turn: 3, status: 'completed', elapsedMs: 65_000, reply: 'done' },
  ...over,
})

const store = logic.createStore()
eq(store.getState().items.length, 0, 'store starts empty')
store.append(wire({ seq: 2 }))
store.append(wire({ seq: 1 }))
eq(store.getState().items.length, 2, 'two notifications retained')
eq(store.getState().items[0].seq, 1, 'newest notification first')
eq(store.getState().unread, 2, 'unread counts every notification')
store.append(wire({ seq: 1 }))
eq(store.getState().items.length, 2, 'the same seq is never appended twice')
store.markRead()
eq(store.getState().unread, 0, 'markRead clears the unread count')
store.dismiss(1)
eq(store.getState().items.length, 1, 'dismiss removes one card')
store.clear()
eq(store.getState().items.length, 0, 'clear empties the stack')

let capNotified = 0
const unsubscribe = store.subscribe(() => {
  capNotified++
})
store.setConnected(true)
store.setConnected(true)
eq(capNotified, 1, 'subscribe fires on change only')
unsubscribe()
store.setConnected(false)
eq(capNotified, 1, 'unsubscribe stops notifications')

const many = [1, 2, 3, 4, 5, 6].reduce((state, seq) => logic.reduceAppend(state, wire({ seq })), logic.EMPTY_STATE)
eq(many.items.length, 4, 'the stack is capped at four cards')
eq(many.items[0].seq, 6, 'the cap keeps the newest cards')

const lines = logic.toastLines(wire({ kind: 'approval', approval: { toolName: 'bash', reason: 'r' } }))
eq(lines.body, '工具 bash 等待授权\nr', 'approval toast body')
eq(lines.meta, 'st · ws', 'toast meta joins session and workspace')
const questionLines = logic.toastLines(
  wire({ kind: 'question', question: { header: 'h', question: 'q', count: 2 } }),
)
eq(questionLines.body, 'h：q\n共 2 题', 'question toast body')
const errorLines = logic.toastLines(
  wire({ turn: { turn: 1, status: 'error', error: 'boom', reply: 'x' } }),
)
check(errorLines.body.includes('出错') && errorLines.body.includes('boom'), 'error toast shows the failure')
eq(logic.formatDuration(1_000), '1s', 'client formatDuration')
eq(logic.browserBody(wire({})), '第 3 轮完成 · done · st', 'system notification body')

// 轮次拿不到时不能写"第 0 轮"（真出现过的 bug）
const noTurn = wire({ turn: { status: 'completed', reply: 'done' } })
check(!logic.toastLines(noTurn).body.includes('第'), 'missing turn number renders no turn at all')
check(logic.toastLines(noTurn).body.includes('done'), 'missing turn number still shows the preview')
eq(logic.browserBody(noTurn), '本轮完成 · done · st', 'system notification body falls back when the turn is unknown')

const meta = logic.readBootMeta({
  querySelector: () => ({
    getAttribute: () =>
      JSON.stringify({ endpoint: '/x/stream', channels: { ack: false, browser: true, sound: false, title: true } }),
  }),
})
eq(meta.endpoint, '/x/stream', 'meta endpoint parsed')
eq(meta.channels.browser, true, 'meta browser switch parsed')
eq(logic.ackEnabled(meta), false, 'ack switch honoured')
eq(logic.ackEnabled(null), true, 'missing meta defaults to showing toasts')
eq(logic.readBootMeta({ querySelector: () => null }), null, 'missing meta returns null (apply falls back to the default endpoint)')

// 控制面：关掉 ack 时只记未读、不堆卡片
const silent = logic.createController({
  meta: { endpoint: '/dsh-notify/stream', channels: { ack: false, browser: false, sound: false, title: false } },
})
silent.notify(wire({ seq: 9 }))
eq(silent.store.getState().items.length, 0, 'ack=false suppresses the in-page card')
silent.dispose()

const visible = logic.createController({
  meta: { endpoint: '/dsh-notify/stream', channels: { ack: true, browser: false, sound: false, title: true } },
})
visible.notify(wire({ seq: 10 }))
eq(visible.store.getState().items.length, 1, 'ack=true shows the card')
eq(logic.TOAST_TTL.approval > logic.TOAST_TTL['turn-end'], true, 'approval cards live longer than completion cards')

// 当前对话不通知：人正看着这个对话，回复/审批卡就在屏幕上，再弹一条是噪音。
// 只在页面可见时压制 —— 切走了"在对话里"这个前提就不成立了，还得照常叫你。
const visibleMeta = { endpoint: '/dsh-notify/stream', channels: { ack: true, browser: false, sound: false, title: true } }
const current = logic.createController({ meta: visibleMeta, isCurrentSession: (id) => id === 'sess-current' })
current.notify(wire({ seq: 20, sessionId: 'sess-current' }))
eq(current.store.getState().items.length, 0, '当前对话：页面可见时一条都不弹')
eq(current.store.getState().unread, 0, '当前对话：没有未读（不必去标题上找）')
current.notify(wire({ seq: 21, sessionId: 'sess-other' }))
eq(current.store.getState().items.length, 1, '别的对话照旧弹')
eq(current.store.getState().items[0].sessionId, 'sess-other', '弹的是别的对话那条')

// 同一个 controller，把页面切到后台：当前对话也得通知（系统通知/标题角标那条路）
globalThis.document.visibilityState = 'hidden'
current.notify(wire({ seq: 22, sessionId: 'sess-current' }))
eq(current.store.getState().items.length, 2, '当前对话：页面不可见时照常弹（否则切走就彻底没提醒了）')
globalThis.document.visibilityState = 'visible'
current.dispose()

// 拿不到 sessions 服务（探针缺省）时退回旧行为：一律通知
const noProbe = logic.createController({ meta: visibleMeta })
noProbe.notify(wire({ seq: 23, sessionId: 'sess-current' }))
eq(noProbe.store.getState().items.length, 1, '没有 isCurrentSession 探针时不做压制')
noProbe.dispose()

// 探针抛错也不能把通知链搞挂
const throwing = logic.createController({
  meta: visibleMeta,
  isCurrentSession: () => {
    throw new Error('boom')
  },
})
throwing.notify(wire({ seq: 24, sessionId: 'sess-current' }))
eq(throwing.store.getState().items.length, 1, '探针抛错时通知照旧发出（不能让可选服务拖挂链路）')
throwing.dispose()

// ── 点通知回对话 ───────────────────────────────────────────────────────────
console.log('\n== 点通知回对话 ==')
const el = (tag, parent) => {
  const node = { tagName: tag, parentElement: parent ?? null }
  return node
}
const card = el('DIV')
const actions = el('DIV', card)
const openBtn = el('BUTTON', actions)
const cardBody = el('DIV', card)

eq(logic.isButtonClick({ target: openBtn, currentTarget: card }), true, '点卡片里的按钮不算点卡片')
eq(logic.isButtonClick({ target: cardBody, currentTarget: card }), false, '点正文算点卡片')
eq(logic.isButtonClick({ target: card, currentTarget: card }), false, '点卡片本身算点卡片')
eq(logic.isButtonClick({ target: null, currentTarget: card }), false, '拿不到 target 时不炸')

let openCalls = 0
let dismissCalls = 0
const handlers = { onOpen: () => openCalls++, onDismiss: () => dismissCalls++ }

eq(logic.activateCard(true, handlers), true, '能跳的卡片：点一下就去跳')
eq(openCalls, 1, '跳会话被调用一次')
eq(dismissCalls, 1, '跳完顺手收掉这条')

let laterDismissed = 0
eq(logic.activateCard(false, { onDismiss: () => laterDismissed++ }), false, '不能跳的卡片：点击不做任何事（也就不会误收）')
eq(laterDismissed, 0, '不能跳的卡片不会被点掉')

const selfTest = logic.createController({
  meta: { endpoint: '/dsh-notify/stream', channels: { ack: true, browser: false, sound: false, title: false } },
  openSession: () => openCalls++,
})
eq(typeof selfTest.test, 'function', 'controller 暴露自检')

// meta 缺失时的渠道兜底必须与宿主默认一致：以前这里硬编码 browser:false，
// 与宿主默认 true 相反，meta 一解析不出来就永远收不到系统通知
const noMeta = logic.createController({})
eq(noMeta.channels.browser, true, 'meta 缺失时系统通知渠道兜底为开')
eq(noMeta.channels.ack, true, 'meta 缺失时页内提示条兜底为开')

// 被拒之后不再给一个点不动的按钮
eq(logic.browserAskable('default'), true, '还没问过时给授权按钮')
eq(logic.browserAskable('denied'), false, '已被拒绝时不给按钮（点了也不会再弹窗）')
eq(logic.browserAskable('granted'), false, '已授权时不给按钮')

// 自检要给出可读的体检结论：哪条渠道通、哪条不通，用户一眼能看懂
const selfTestReport = await selfTest.test()
check(Array.isArray(selfTestReport) && selfTestReport.length >= 3, '自检返回逐行体检结论', JSON.stringify(selfTestReport))
// 结论要落在"刚发出去的那张自检卡"上，而不是随机一张
const reported = selfTest.store.getState().items.filter((item) => Array.isArray(item.report))
eq(reported.length, 1, '体检结论只写在一张卡上')
check(reported[0]?.test === true, '体检结论落在一张自检卡上')
check(
  selfTest.store.getState().items.every((item) => item.workspace === 'example-project'),
  '所有自检卡片使用通用示例工作区',
)
check(
  Array.isArray(selfTestReport) && selfTestReport.some((line) => line.includes('页内提示条')),
  '结论里有页内提示条',
)
check(
  Array.isArray(selfTestReport) && selfTestReport.some((line) => line.includes('系统通知')),
  '结论里有系统通知',
)
check(
  !selfTestReport.some((line) => line.includes('原生弹窗')),
  '结论里不再有原生弹窗',
)
const reportCard = selfTest.store.getState().items.find((item) => item.report && item.report.length > 0)
check(reportCard !== undefined, '结论挂到了自检卡片上')

// 用户在浏览器里改了授权之后，体检结论必须跟着变 —— 只认创建时的快照会一直说"还没授权"
const prevPermission = globalThis.Notification.permission
globalThis.Notification.permission = 'default'
const beforeGrant = await selfTest.test()
check(beforeGrant.some((line) => line.includes('还没授权')), '授权前结论说还没授权', JSON.stringify(beforeGrant))
globalThis.Notification.permission = 'granted'
const afterGrant = await selfTest.test()
check(
  afterGrant.some((line) => line.startsWith('系统通知') && line.includes('通知创建成功') && line.includes('请确认是否看到测试弹窗')),
  '授权并探通之后仅报告创建成功，实际展示由用户确认',
  JSON.stringify(afterGrant),
)
check(!afterGrant.some((line) => line.includes('系统通知：正常')), '创建成功不再宣称系统展示正常')
const testNotification = NotificationStub.instances.at(-1)
eq(testNotification?.title, 'dsh-notify 自检', '自检弹窗标题明确标识测试')
eq(testNotification?.options.body, '看到这条说明浏览器系统通知已送达', '自检弹窗不再显示这条不该出现')
eq(testNotification?.options.silent, true, '自检弹窗保持静音')
eq(selfTest.store.getState().permission, 'granted', '跑自检会重新读一次授权状态')

const savedNotification = globalThis.Notification
function FailingNotification() { throw new Error('notification constructor failed') }
FailingNotification.permission = 'granted'
globalThis.Notification = FailingNotification
try {
  const failedProbe = await selfTest.test()
  check(failedProbe.some((line) => line.includes('创建失败') && line.includes('notification constructor failed')), '创建失败保留实际错误')
  check(!failedProbe.some((line) => line.includes('被系统挡了')), '创建失败不臆测是系统拦截')
} finally {
  globalThis.Notification = savedNotification
}
globalThis.Notification.permission = prevPermission
selfTest.refreshPermission()
eq(selfTest.store.getState().permission, prevPermission, 'refreshPermission 读回当前状态')

// 系统通知可见性门禁：页面可见时不该发系统通知
const prevVisibility = Object.getOwnPropertyDescriptor(globalThis.document, 'visibilityState')
Object.defineProperty(globalThis.document, 'visibilityState', { value: 'visible', configurable: true })
eq(logic.pageHidden(), false, '页面可见时 pageHidden=false')
eq(logic.showBrowserNotification({ title: 'x', body: 'y' }), false, '页面可见时不发系统通知')
Object.defineProperty(globalThis.document, 'visibilityState', { value: 'hidden', configurable: true })
eq(logic.pageHidden(), true, '页面藏起来时 pageHidden=true')
if (prevVisibility) Object.defineProperty(globalThis.document, 'visibilityState', prevVisibility)

selfTest.dispose()


eq(logic.KIND_TITLE['turn-end'], '会话完成', 'kind titles are localised')
visible.dispose()

report('client.test')
