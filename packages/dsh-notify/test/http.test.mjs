#!/usr/bin/env node
// 端到端：真的起一个 HTTP 服务器（DSH 自己的 webServer 插件 + 真的 /api 承运通道
// dsh-client-connection，随机端口），把本插件装上去，然后用真 socket 做四件事 ——
//   1. 走一次真实的浏览器认证，拿会话 cookie（没认证就该 401）
//   2. GET /dsh-notify/stream 建长连，验证 hello 帧与真流式写出
//   3. 在真 Cordis 上下文里 emit 三类事件，验证通知帧真的从 socket 推出来
//   4. POST /api/dsh-notify.state 验证 JSON 方法；非本地 Host 验证承运层的围栏
//
// 这一层补的是 host.test.mjs 用桩服务测不到的东西：真路由注册（承运层会校验端点形状）、
// 真 head 头、真流式写出、真围栏与真浏览器认证。
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assistantMessage, check, eq, report, sessionEvent, userMessage } from './harness.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const requireHere = createRequire(import.meta.url)

const { Context } = requireHere('@deepseek-ai/cordis')
const webServerModule = await import(requireHere.resolve('@deepseek-ai/dsh-host-webserver'))
const connectionModule = await import(requireHere.resolve('@deepseek-ai/dsh-client-connection'))
const plugin = await import(path.join(ROOT, 'dist', 'host', 'index.js'))

const WebServer = webServerModule.default ?? webServerModule.WebServer ?? webServerModule
const asPlugin = (module) => ({ apply: module.apply, name: module.name, inject: module.inject, Config: module.Config })

console.log('\n== compose a real Cordis app ==')
const ctx = new Context()
const sessions = new Map([['sess-e2e', { id: 'sess-e2e', header: { id: 'sess-e2e', cwd: '/tmp/e2e-proj', meta: {} } }]])

// 真上下文里补三个桩服务：sessions / sessionTitle 是本插件的软依赖，credentials 是承运层
// 存浏览器会话签名密钥的地方（真部署里由 profile 的凭证插件提供）
ctx.provide('sessions', { get: (id) => sessions.get(id) })
ctx.provide('sessionTitle', { get: (session) => ({ title: '端到端会话 ' + (session?.id ?? '?') }) })
const credentialRecords = new Map()
ctx.provide('credentials', {
  async modifyRecord(key, updater) {
    const current = credentialRecords.get(key)
    const next = await updater(current)
    if (next === undefined) return current
    credentialRecords.set(key, next)
    return next
  },
})

const webServerFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await webServerFiber
const port = ctx.get('webServer').port
check(typeof port === 'number' && port > 0, 'the real webServer bound an OS-assigned port', String(port))

const connectionFiber = ctx.plugin(asPlugin(connectionModule), {})
await connectionFiber
const connection = ctx.get('connection')
check(connection !== undefined && typeof connection.authenticatedUrl === 'function', '真 /api 承运通道已挂上')

const notifyFiber = ctx.plugin({ apply: plugin.apply, name: plugin.name })
await notifyFiber
await new Promise((resolve) => setTimeout(resolve, 50))

// ── 真 socket ─────────────────────────────────────────────────────────────
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// 真浏览器认证：launch token 换会话 cookie。真部署里这一步发生在 GET / 上
// （dsh-host-frontend-static 调 connection.authorizeIndex）；这里没有前端静态层，
// 就直接调承运层的授权口，拿真 cookie 去走后面所有请求
const launchToken = new URL(connection.authenticatedUrl('http://127.0.0.1:' + String(port))).searchParams.get('token')
check(typeof launchToken === 'string' && launchToken !== '', '承运层给出了 launch token')
const handed = { status: 0, headers: {} }
const authority = '127.0.0.1:' + String(port)
const servedIndex = connection.authorizeIndex(
  { method: 'GET', url: '/?token=' + String(launchToken), headers: { host: authority } },
  {
    writeHead(status, headers) {
      handed.status = status
      handed.headers = headers ?? {}
      return this
    },
    end() {},
  },
)
eq(servedIndex, false, '授权口接管了这句响应（303 + Set-Cookie）')
eq(handed.status, 303, '带着 launch token 的 index 请求被换成了 cookie')
const cookie = String(handed.headers['set-cookie'] ?? '').split(';')[0]
check(cookie.includes('='), '拿到了会话 cookie')

console.log('\n== 认证与围栏：承运层判 ==')
const jsonHeaders = { 'content-type': 'application/json' }
const anonymous = await request(
  { method: 'POST', path: '/api/dsh-notify.state', headers: jsonHeaders },
  '{}',
)
eq(anonymous.status, 401, '不带会话 cookie → 401')

const foreignHost = await request(
  { method: 'POST', path: '/api/dsh-notify.state', headers: { ...jsonHeaders, host: 'evil.example.com', cookie } },
  '{}',
)
eq(foreignHost.status, 403, '非本地 Host → 403（DNS rebinding 被承运层挡下）')

const streamNoCookie = await request({ method: 'GET', path: '/dsh-notify/stream', headers: { accept: 'text/event-stream' } })
eq(streamNoCookie.status, 401, '长连没认证也是 401（自留路由问承运层要的裁定）')

console.log('\n== SSE stream over a real socket ==')
const frames = []
const streamRequest = http.request(
  {
    host: '127.0.0.1',
    port,
    path: '/dsh-notify/stream',
    method: 'GET',
    headers: { accept: 'text/event-stream', cookie },
  },
  (res) => {
    check(res.statusCode === 200, 'stream answers 200')
    check(String(res.headers['content-type']).includes('text/event-stream'), 'stream advertises text/event-stream')
    check(String(res.headers['cache-control']).includes('no-store'), 'stream disables caching')
    let buffer = ''
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const event = /^event: (\S+)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (event) frames.push({ event, data: data === undefined ? undefined : JSON.parse(data) })
        index = buffer.indexOf('\n\n')
      }
    })
  },
)
streamRequest.end()

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

await waitFor(() => frames.length > 0)
check(frames.length > 0, 'the stream pushed a hello frame')
eq(frames[0].event, 'hello', 'first frame is hello')
eq(frames[0].data.endpoint, '/dsh-notify/stream', 'hello carries the endpoint')

console.log('\n== notifications over a real socket ==')
const session = sessions.get('sess-e2e')
const ctxEmit = (name, ...args) => ctx.events.emit(name, ...args)

ctxEmit('session/event', session, sessionEvent('turn/start', { turn: 1 }))
ctxEmit('session/event', session, sessionEvent('user/message', userMessage('端到端跑一遍')))
ctxEmit('session/event', session, sessionEvent('assistant/message', assistantMessage('跑完了')))
ctxEmit('session/event', session, sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
await waitFor(() => frames.length > 1)
const turnFrame = frames.find((frame) => frame.event === 'notify')
check(turnFrame !== undefined, 'turn/end reached the browser stream')
if (turnFrame) {
  eq(turnFrame.data.kind, 'turn-end', 'the pushed notification is turn-end')
  eq(turnFrame.data.sessionId, 'sess-e2e', 'the pushed notification carries the session id')
  eq(turnFrame.data.sessionTitle, '端到端会话 sess-e2e', 'the pushed notification carries the title')
  eq(turnFrame.data.turn.turn, 1, 'the pushed notification carries the real turn number')
  eq(turnFrame.data.turn.prompt, '端到端跑一遍', 'the pushed notification carries the prompt preview')
  eq(turnFrame.data.turn.reply, '跑完了', 'the pushed notification carries the reply preview')
}

const before = frames.length
await ctx.events.waterfall('approval/request', {
  agent: { id: 'sess-e2e' },
  toolName: 'bash',
  reason: '端到端',
}, async () => 'allowed-once')
await waitFor(() => frames.length > before)
const approvalFrame = frames.filter((frame) => frame.event === 'notify').pop()
eq(approvalFrame.data.kind, 'approval', 'approval reached the browser stream')
eq(approvalFrame.data.approval.toolName, 'bash', 'approval carries the tool name')

const beforeQuestion = frames.length
await ctx.events.waterfall('user-questions/request', {
  agent: { id: 'sess-e2e' },
  questions: [{ id: 'q1', header: '端到端', question: '继续吗？' }],
}, async () => ({ answers: [] }))
await waitFor(() => frames.length > beforeQuestion)
const questionFrame = frames.filter((frame) => frame.event === 'notify').pop()
eq(questionFrame.data.kind, 'question', 'question reached the browser stream')
eq(questionFrame.data.question.question, '继续吗？', 'question carries the text')

console.log('\n== /api 承运通道上的 JSON 方法 ==')
const state = await request(
  { method: 'POST', path: '/api/dsh-notify.state', headers: { ...jsonHeaders, cookie } },
  '{}',
)
eq(state.status, 200, 'api/state answers 200')
const stateBody = JSON.parse(state.body)
eq(stateBody.ok, true, 'api/state ok')
eq(stateBody.config.ack, true, 'api/state reports ack')
eq(stateBody.clients, 1, 'api/state counts the attached client')
check(!Object.hasOwn(stateBody.config, 'native'), 'api/state no longer exposes native')

const beforeTest = frames.length
const selfTest = await request(
  { method: 'POST', path: '/api/dsh-notify.test', headers: { ...jsonHeaders, cookie } },
  '{}',
)
eq(selfTest.status, 200, 'api/test answers 200')
eq(JSON.stringify(JSON.parse(selfTest.body)), JSON.stringify({
  ok: true,
  webhook: { attempted: false, ok: false },
  clients: 1,
}), 'api/test only returns webhook and client results (no native)')
await waitFor(() => frames.length > beforeTest)
const testFrame = frames.slice(beforeTest).find((frame) => frame.event === 'notify' && frame.data.test === true)
check(testFrame !== undefined, 'api/test still sends a test notification over SSE')

const notFound = await request(
  { method: 'POST', path: '/api/dsh-notify.nope', headers: { ...jsonHeaders, cookie } },
  '{}',
)
eq(notFound.status, 404, 'unknown api method is 404')

const badMethod = await request({ method: 'GET', path: '/api/dsh-notify.state', headers: { cookie } })
eq(badMethod.status, 404, 'wrong HTTP method never reaches the handler (404)')

// index 注入：真的渲染一遍 index.html
const injected = ctx.get('webServer').renderIndex('<html><head></head><body></body></html>')
check(injected.includes('meta name="dsh-notify"'), 'index injection renders the meta tag')
check(injected.includes('/dsh-notify/stream'), 'the meta tag carries the stream endpoint')
const metaTag = /<meta name="dsh-notify"[^>]*>/.exec(injected)?.[0] ?? ''
check(metaTag !== '' && !metaTag.includes('</script'), 'the injected meta tag is self-contained')

console.log('\n== teardown ==')
streamRequest.destroy()
await notifyFiber.dispose()
check(ctx.get('webServer') !== undefined, 'disposing the plugin leaves webServer alone')
const afterDispose = await request(
  { method: 'POST', path: '/api/dsh-notify.state', headers: { ...jsonHeaders, cookie } },
  '{}',
).catch(() => ({ status: 404 }))
eq(afterDispose.status, 404, 'routes are gone after disposal')
const streamAfterDispose = await request({ method: 'GET', path: '/dsh-notify/stream', headers: { accept: 'text/event-stream', cookie } })
eq(streamAfterDispose.status, 404, 'the stream route is gone after disposal')
await connectionFiber.dispose()
await webServerFiber.dispose()

report('http.test')
