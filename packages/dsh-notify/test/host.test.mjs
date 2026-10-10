#!/usr/bin/env node
// 宿主半的行为测试：不起真 DSH、不起浏览器，用一个真 Cordis 上下文 + 三个桩服务把
// "事件 → 通知"的整条链走一遍。
//
// 覆盖：
//   - 三类来源各自能产出通知（turn/end、approval/request、user-questions/request）
//   - aborted / interrupted 的 turn/end 不发
//   - 同一来源的重复事件在去重窗口内只发一次
//   - 关掉某一类开关后该类不发，其余照发
//   - SSE 连接能收到 hello 与 notify 帧
//   - 围栏与浏览器认证交给 /api 承运通道（自留的 SSE 路由问它要裁定）
//   - 原生通知已移除，剩余渠道全关时不发
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assistantMessage, check, eq, report, sessionEvent, userMessage } from './harness.mjs'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const subscribe = (bus, name, listener) => {
  const list = bus.get(name) ?? []
  list.push(listener)
  bus.set(name, list)
}


const { Context } = require('@deepseek-ai/cordis')
const notifierModule = await import(path.join(ROOT, 'dist', 'host', 'notifier.js'))
const durationModule = await import(path.join(ROOT, 'dist', 'shared', 'duration.js'))
const textModule = await import(path.join(ROOT, 'dist', 'host', 'text.js'))
const configModule = await import(path.join(ROOT, 'dist', 'host', 'config.js'))
const plugin = await import(path.join(ROOT, 'dist', 'host', 'index.js'))

// ── 纯函数 ────────────────────────────────────────────────────────────────
console.log('\n== pure helpers ==')
eq(textModule.plainText([{ type: 'text', text: 'hello  world' }]), 'hello world', 'plainText collapses whitespace')
eq(textModule.plainText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a b', 'plainText walks content blocks')
eq(textModule.plainText({ type: 'image' }), '', 'plainText ignores non-text blocks')
eq(textModule.plainText('x'.repeat(400)).length, 120, 'plainText truncates to the limit')
eq(durationModule.formatDuration(900), '1s', 'formatDuration rounds to seconds')
eq(durationModule.formatDuration(65_000), '1m5s', 'formatDuration shows minutes')
eq(durationModule.formatDuration(3_725_000), '1h2m', 'formatDuration shows hours')

const defaults = configModule.resolveConfig(undefined)
check(defaults.notifyOnTurnEnd && defaults.notifyOnApproval && defaults.notifyOnQuestion, 'all three kinds default on')
check(defaults.ack && defaults.sound && defaults.title, 'ack/sound/title default on')
check(!Object.hasOwn(defaults, 'native'), 'resolved config no longer exposes native')
const schema = configModule.Config.toJSON()
check(!Object.hasOwn(schema.refs[schema.uid].dict, 'native'), 'schema no longer exposes native')
check(!Object.hasOwn(configModule.resolveConfig({ native: true }), 'native'), 'legacy native config is ignored')
check(defaults.browser === true, 'browser notification channel defaults on (permission is asked on first gesture)')
check(defaults.includeSubagents === false, 'subagent sessions default off')
eq(configModule.resolveConfig({ notifyOnApproval: false }).notifyOnApproval, false, 'explicit off wins')

// ── 一个能当 webServer 用的最小 hub ───────────────────────────────────────
function makeHub() {
  const frames = []
  const routes = new Map()
  const clients = new Set()
  const hub = {
    frames,
    register(route) {
      routes.set(route.kind + ':' + route.path, route)
      return () => routes.delete(route.kind + ':' + route.path)
    },
    get port() {
      return 1234
    },
  }
  const fakeResponse = () => {
    const res = {
      chunks: [],
      listeners: new Map(),
      closed: false,
      status: 0,
      writeHead(status) {
        res.status = status
        return res
      },
      write(chunk) {
        res.chunks.push(String(chunk))
        const notify = /^event: notify\ndata: (.*)$/m.exec(String(chunk))
        if (notify) frames.push(JSON.parse(notify[1]))
        return true
      },
      end() {
        res.closed = true
      },
      on(name, listener) {
        res.listeners.set(name, listener)
        return res
      },
    }
    clients.add(res)
    return res
  }
  return {
    frames,
    register: hub.register,
    port: 1234,
    clients,
    routes,
    fakeResponse,
    get stream() {
      return routes.get('exact:/dsh-notify/stream')
    },
  }
}

// 承运通道的桩：记录注册的路由与每一次围栏问询。裁定由 verdict 控制，
// 真实裁定在承运层里（这里测的是"我们问它、并按它的答案回"）
function makeConnection() {
  const routes = new Map()
  const rejections = []
  const connection = {
    verdict: undefined,
    routes,
    rejections,
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    requestRejection(request) {
      rejections.push(request.headers)
      return connection.verdict
    },
  }
  return connection
}

// ── 装插件 ────────────────────────────────────────────────────────────────
console.log('\n== plugin wiring ==')
const ctx = new Context()
const bus = new Map()
const hub = makeHub()
const connection = makeConnection()
const sessions = new Map()
const titles = new Map()

const services = {
  webServer: hub,
  connection,
  sessions: { get: (id) => sessions.get(id) },
  sessionTitle: { get: (session) => (session && titles.has(session.id) ? { title: titles.get(session.id) } : undefined) },
}
for (const [key, value] of Object.entries(services)) {
  Object.defineProperty(ctx, key, { get: () => value, configurable: true })
}
Object.defineProperty(ctx, 'get', {
  value: (name) => services[name],
  configurable: true,
})
Object.defineProperty(ctx, 'inject', {
  value: (names, callback) => {
    for (const name of names) {
      if (services[name] === undefined) return
    }
    callback(ctx)
  },
  configurable: true,
})
Object.defineProperty(ctx, 'on', {
  value: (name, listener) => {
    subscribe(bus, name, listener)
    return () => {}
  },
  configurable: true,
})
ctx.effect = ctx.effect ?? (() => () => {})

const escalators = new Set()
const escalate = (err) => {
  escalators.add(err)
}
const fire = async (name, ...args) => {
  const list = bus.get(name) ?? []
  if (args.length > 0 && typeof args[args.length - 1] === 'function') {
    // waterfall：最后一个参数是 next
    return await list[0](...args)
  }
  for (const listener of list) {
    try {
      await listener(...args)
    } catch (error) {
      escalate(error)
    }
  }
  return null
}

plugin.apply(ctx, {})
await new Promise((resolve) => setTimeout(resolve, 5))

check(typeof hub.stream?.handler === 'function', '长连自留 webServer（一条 exact 路由）')
eq([...connection.routes.keys()].join(','), '/api/dsh-notify.state,/api/dsh-notify.test', '一个 JSON 方法一条 /api 承运路由')
check(
  [...connection.routes.values()].every((route) => JSON.stringify(route.methods) === '["POST"]' && route.requestBody === 'buffered'),
  'JSON 路由只收 POST 且读缓冲体',
)
check(bus.has('session/event'), 'session/event listener wired')
check(bus.has('approval/request'), 'approval/request listener wired')
check(bus.has('user-questions/request'), 'user-questions/request listener wired')

const session = { id: 'sess-1', header: { id: 'sess-1', cwd: '/tmp/proj', meta: {} } }
sessions.set('sess-1', session)
titles.set('sess-1', '修登录超时')

const req = { method: 'GET', headers: { host: '127.0.0.1:3080' }, url: '/dsh-notify/stream', on: () => {} }
const res = hub.fakeResponse()
hub.stream.handler(req, res)
await new Promise((resolve) => setTimeout(resolve, 5))
check(res.chunks.some((chunk) => chunk.includes('event: hello')), 'stream sends hello frame')

// ── turn/end ──────────────────────────────────────────────────────────────
console.log('\n== kind: turn-end ==')
await fire('session/event', session, sessionEvent('turn/start', { turn: 1 }))
await fire('session/event', session, sessionEvent('user/message', userMessage('把登录超时改掉')))
await fire('session/event', session, sessionEvent('assistant/message', assistantMessage('已经把超时从 5s 调到 30s')))
await fire('session/event', session, sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
await new Promise((resolve) => setTimeout(resolve, 20))

eq(hub.frames.length, 1, 'completed turn produces exactly one notification')
const wire = hub.frames[0]
eq(wire.kind, 'turn-end', 'kind is turn-end')
eq(wire.sessionId, 'sess-1', 'session id carried')
eq(wire.sessionTitle, '修登录超时', 'session title read from the title service')
eq(wire.workspace, 'proj', 'workspace name derived from cwd')
eq(wire.turn.turn, 1, 'turn number carried')
eq(wire.turn.status, 'completed', 'status is completed')
check(typeof wire.turn.elapsedMs === 'number' && wire.turn.elapsedMs >= 0, 'elapsed measured')
eq(wire.turn.reply, '已经把超时从 5s 调到 30s', 'reply preview captured')
// user/message 的载荷就是 message 本身；读成 data.message 时这里会恒为 undefined
eq(wire.turn.prompt, '把登录超时改掉', 'prompt preview captured from the real user/message shape')
check(wire.title.includes('修登录超时'), 'title includes the session title')

// 同一 turn 再来一次：去重
await fire('session/event', session, sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
await new Promise((resolve) => setTimeout(resolve, 10))
eq(hub.frames.length, 1, 'the same turn is not notified twice')

// aborted / interrupted 不发
await fire('session/event', session, sessionEvent('turn/start', { turn: 2 }))
await fire('session/event', session, sessionEvent('turn/end', { turn: 2, reason: { kind: 'aborted', reason: 'user' } }))
await fire('session/event', session, sessionEvent('turn/start', { turn: 3 }))
await fire('session/event', session, sessionEvent('turn/end', { turn: 3, reason: { kind: 'interrupted' } }))
await new Promise((resolve) => setTimeout(resolve, 10))
eq(hub.frames.length, 1, 'aborted / interrupted turns stay silent')

// 第 5 轮必须报"第 5 轮"：这是真出现过的 bug —— 轮次从事件顶层读，恒为 0
await fire('session/event', session, sessionEvent('turn/start', { turn: 5 }))
await fire('session/event', session, sessionEvent('user/message', userMessage('再来一轮')))
await fire('session/event', session, sessionEvent('assistant/message', assistantMessage('这轮也好了')))
await fire('session/event', session, sessionEvent('turn/end', { turn: 5, reason: { kind: 'completed' } }))
await new Promise((resolve) => setTimeout(resolve, 10))
eq(hub.frames.length, 2, 'a later turn still notifies')
eq(hub.frames[1].turn.turn, 5, 'the later turn carries its own number, not 0')
eq(hub.frames[1].turn.prompt, '再来一轮', 'the later turn carries its own prompt')
eq(hub.frames[1].turn.reply, '这轮也好了', 'the later turn carries its own reply')

// 轮次缺失：通知照发，但不写轮次；去重键用 seq 兜底，不能与其它轮次撞键
const beforeNoTurn = hub.frames.length
await fire('session/event', session, sessionEvent('turn/start', { turn: 6 }))
await fire('session/event', session, sessionEvent('turn/end', { reason: { kind: 'completed' } }))
await new Promise((resolve) => setTimeout(resolve, 10))
eq(hub.frames.length, beforeNoTurn + 1, 'a turn/end without a turn number still notifies')
eq(hub.frames[beforeNoTurn].turn.turn, undefined, 'it carries no turn number rather than a fake 0')
// 同一个会话再发一条同样没有轮次的 turn/end：seq 不同，不能被上一条的键吃掉
await fire('session/event', session, {
  type: 'turn/end',
  seq: 999_002,
  time: Date.now(),
  data: { reason: { kind: 'completed' } },
})
await new Promise((resolve) => setTimeout(resolve, 10))
eq(hub.frames.length, beforeNoTurn + 2, 'a second turn number-less turn does not collide with the first')

// 信封里没有 data（老形状、字段摊在顶层）→ 描述不了，跳过也不该崩
const beforeLegacy = hub.frames.length
await fire('session/event', session, { type: 'turn/end', turn: 7, reason: { kind: 'completed' } })
await new Promise((resolve) => setTimeout(resolve, 10))
eq(hub.frames.length, beforeLegacy, 'a legacy top-level payload is not mistaken for a real turn')

// error 与 max-tokens 要发
const beforeError = hub.frames.length
await fire('session/event', session, sessionEvent('turn/start', { turn: 4 }))
await fire('session/event', session, sessionEvent('turn/end', {
  turn: 4,
  reason: { kind: 'error', error: { message: 'model exploded', code: 'UNKNOWN' } },
}))
await new Promise((resolve) => setTimeout(resolve, 10))
eq(hub.frames.length, beforeError + 1, 'error turn notifies')
eq(hub.frames[beforeError].turn.turn, 4, 'error turn carries its number')
eq(hub.frames[beforeError].turn.status, 'error', 'status is error')
eq(hub.frames[beforeError].turn.error, 'model exploded', 'error message carried')

// subagent 默认静音
const beforeSubagent = hub.frames.length
const child = { id: 'sess-child', header: { id: 'sess-child', cwd: '/tmp/proj', meta: { origin: 'subagent' } } }
sessions.set('sess-child', child)
await fire('session/event', child, sessionEvent('turn/start', { turn: 1 }))
await fire('session/event', child, sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
await new Promise((resolve) => setTimeout(resolve, 10))
eq(hub.frames.length, beforeSubagent, 'subagent turns stay silent by default')

// ── approval ──────────────────────────────────────────────────────────────
console.log('\n== kind: approval ==')
const approvalFramesBefore = hub.frames.length
let nextCalled = false
await fire('approval/request', { agent: { id: 'sess-1' }, toolName: 'bash', reason: '要跑 rm -rf' }, async () => {
  nextCalled = true
  return 'allowed-once'
})
await new Promise((resolve) => setTimeout(resolve, 10))
check(nextCalled, 'approval listener passes control down the waterfall')
eq(hub.frames.length, approvalFramesBefore + 1, 'approval notifies')
const approval = hub.frames[hub.frames.length - 1]
eq(approval.kind, 'approval', 'kind is approval')
eq(approval.approval.toolName, 'bash', 'tool name carried')
eq(approval.approval.reason, '要跑 rm -rf', 'reason carried')

await fire('approval/request', { agent: { id: 'sess-1' }, toolName: 'bash', reason: '要跑 rm -rf' }, async () => 'allowed-once')
await new Promise((resolve) => setTimeout(resolve, 10))
eq(hub.frames.length, approvalFramesBefore + 1, 'duplicate approval inside the window is deduped')

// ── question ──────────────────────────────────────────────────────────────
console.log('\n== kind: question ==')
const questionFramesBefore = hub.frames.length
let questionNext = false
await fire(
  'user-questions/request',
  {
    agent: { id: 'sess-1' },
    questions: [{ id: 'q1', header: '先跑哪个', question: '先跑单测还是先打标签？', options: [] }],
  },
  async () => {
    questionNext = true
    return { answers: [] }
  },
)
await new Promise((resolve) => setTimeout(resolve, 10))
check(questionNext, 'question listener passes control down the waterfall')
eq(hub.frames.length, questionFramesBefore + 1, 'question notifies')
const question = hub.frames[hub.frames.length - 1]
eq(question.kind, 'question', 'kind is question')
eq(question.question.header, '先跑哪个', 'question header carried')
eq(question.question.count, 1, 'question count carried')

// ── 开关 ──────────────────────────────────────────────────────────────────
console.log('\n== switches ==')
const offHub = makeHub()
const offCtx = new Context()
const offBus = new Map()
const offSessions = new Map([['s2', { id: 's2', header: { id: 's2', cwd: '/tmp/p2', meta: {} } }]])
const offConnection = makeConnection()
Object.defineProperty(offCtx, 'webServer', { get: () => offHub, configurable: true })
Object.defineProperty(offCtx, 'connection', { get: () => offConnection, configurable: true })
Object.defineProperty(offCtx, 'sessions', { get: () => ({ get: (id) => offSessions.get(id) }), configurable: true })
Object.defineProperty(offCtx, 'sessionTitle', { get: () => ({ get: () => undefined }), configurable: true })
Object.defineProperty(offCtx, 'get', {
  value: (name) =>
    name === 'webServer' ? offHub
      : name === 'connection' ? offConnection
        : name === 'sessions' ? { get: (id) => offSessions.get(id) }
          : undefined,
  configurable: true,
})
Object.defineProperty(offCtx, 'inject', {
  value: (names, callback) => {
    callback(offCtx)
  },
  configurable: true,
})
Object.defineProperty(offCtx, 'on', {
  value: (name, listener) => {
    subscribe(offBus, name, listener)
    return () => {}
  },
  configurable: true,
})
offCtx.effect = () => () => {}

plugin.apply(offCtx, { notifyOnApproval: false, notifyOnQuestion: false, notifyOnTurnEnd: true, browser: false })
await new Promise((resolve) => setTimeout(resolve, 5))
const offRes = offHub.fakeResponse()
offHub.stream.handler(
  { method: 'GET', headers: { host: '127.0.0.1:3080' }, url: '/dsh-notify/stream', on: () => {} },
  offRes,
)
const fireOff = async (name, ...args) => {
  for (const listener of offBus.get(name) ?? []) await listener(...args)
}
await fireOff('session/event', offSessions.get('s2'), sessionEvent('turn/start', { turn: 1 }))
await fireOff('session/event', offSessions.get('s2'), sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
await fireOff('approval/request', { agent: { id: 's2' }, toolName: 'bash' }, async () => 'allowed-once')
await fireOff('user-questions/request', { agent: { id: 's2' }, questions: [{ id: 'q', question: '?' }] }, async () => ({
  answers: [],
}))
await new Promise((resolve) => setTimeout(resolve, 10))
eq(offHub.frames.length, 1, 'only the enabled kind notifies')
eq(offHub.frames[0].kind, 'turn-end', 'the enabled kind is turn-end')

// ── 围栏与浏览器认证：交给承运层 ──────────────────────────────────────────
console.log('\n== 围栏与认证：问承运层要裁定 ==')
{
  const streamReq = (headers) => ({ method: 'GET', headers, url: '/dsh-notify/stream', on: () => {} })
  const beforeFence = hub.frames.length

  connection.verdict = 403
  const blocked = hub.fakeResponse()
  hub.stream.handler(streamReq({ host: 'evil.example.com' }), blocked)
  eq(blocked.status, 403, '承运层判 403 → 长连回 403')
  check(blocked.closed, '被挡下的长连不挂住响应')
  check(!blocked.chunks.some((chunk) => chunk.includes('event: hello')), '被挡下的长连不推流')

  connection.verdict = 401
  const unauth = hub.fakeResponse()
  hub.stream.handler(streamReq({ host: '127.0.0.1:3080' }), unauth)
  eq(unauth.status, 401, '浏览器认证没过 → 401')

  connection.verdict = undefined
  const allowed = hub.fakeResponse()
  hub.stream.handler(streamReq({ host: '127.0.0.1:3080' }), allowed)
  check(allowed.chunks.some((chunk) => chunk.includes('event: hello')), '裁定通过才推流')
  eq(hub.frames.length, beforeFence, '这一轮没有产生通知帧')

  check(connection.rejections.length >= 3, '每次都问一次承运层')
  check(
    connection.rejections.every((headers) => headers && headers.host !== undefined),
    '把请求头原样交给承运层判（自己不看 host/origin）',
  )

  // 宿主半自己不再判：围栏逻辑只该存在于承运层里
  const webSource = readFileSync(path.join(ROOT, 'dist', 'host', 'web.js'), 'utf8')
  check(webSource.indexOf('sec-fetch-site') < 0, '宿主半不碰 sec-fetch-site')
  check(webSource.indexOf('trustedHosts') < 0, '宿主半不再读 webRuntime.trustedHosts')

  // 拿不到承运通道就不开浏览器面（fail closed）：长连的围栏与认证都在它那里
  const noConnHub = makeHub()
  const noConnCtx = new Context()
  const noConnServices = { webServer: noConnHub, sessions: { get: () => undefined } }
  Object.defineProperty(noConnCtx, 'get', { value: (name) => noConnServices[name], configurable: true })
  Object.defineProperty(noConnCtx, 'inject', { value: (_names, callback) => callback(noConnCtx), configurable: true })
  Object.defineProperty(noConnCtx, 'on', { value: () => () => {}, configurable: true })
  noConnCtx.effect = () => () => {}
  plugin.apply(noConnCtx, {})
  await new Promise((resolve) => setTimeout(resolve, 5))
  check(noConnHub.stream === undefined, '没有 connection 服务时不开长连（宁可不服务）')
}

// ── 全渠道关闭 ────────────────────────────────────────────────────────────
console.log('\n== all channels disabled ==')
const mutedNotifier = new notifierModule.Notifier(ctx, {
  ...defaults,
  native: true, // 旧配置不能再打开一个已删除的渠道
  ack: false,
  browser: false,
  sound: false,
  title: false,
  webhookUrl: '',
})
eq(mutedNotifier.publishFull({
  kind: 'turn-end',
  title: '不该发出',
  sessionId: 'muted',
  sessionTitle: '',
  workspace: '',
}), null, 'all remaining channels disabled suppresses notification')
eq(mutedNotifier.deliveredCount, 0, 'suppressed notification is not delivered')

// ── API 方法 ──────────────────────────────────────────────────────────────
console.log('\n== api methods ==')
const stateRoute = connection.routes.get('/api/dsh-notify.state')
const stateRes = await stateRoute.fetch(new Request('http://dsh.internal/api/dsh-notify.state', { method: 'POST', body: '{}' }))
eq(stateRes.status, 200, 'api/state answers 200')
eq((await stateRes.json()).config.ack, true, 'api/state reports the ack switch')
check(
  connection.routes.get('/api/dsh-notify.test') !== undefined,
  '测试通知的端点也在同一条承运通道上',
)

console.log('\n' + (escalators.size > 0 ? 'listener errors: ' + [...escalators].map(String).join(', ') : 'no listener errors'))
check(escalators.size === 0, 'no listener threw out of an event dispatch')

report('host.test')
