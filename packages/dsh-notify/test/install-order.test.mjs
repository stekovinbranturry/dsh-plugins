#!/usr/bin/env node
// 回归：承运通道迟到时，浏览器面也必须装上。
//
// 真部署里 connection 的 apply 是 async 的（`await BrowserAuth.create(...)` 先要 credentials），
// 所以在 webServer 到位那一刻它经常还没 provide 出来。本插件曾经只 `ctx.inject(['webServer'])`，
// 回调一跑发现 connection 缺席就永久关掉整条浏览器面（/dsh-notify/stream 404、/api 方法没有、
// index 里没有 meta）——0.2.0-rc.1 上的表现就是"浏览器通知全失效"。
//
// 这里用一个"受闸门控制的 connection"把那个竞态固定成确定性顺序：先让 webServer 到位、再激活
// 本插件、最后才放行 connection。断言三件事：SSE 路由在、/api 两个方法注册在、index meta 在。
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, eq, report } from './harness.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const requireHere = createRequire(import.meta.url)

const { Context } = requireHere('@deepseek-ai/cordis')
const webServerModule = await import(requireHere.resolve('@deepseek-ai/dsh-host-webserver'))
const plugin = await import(path.join(ROOT, 'dist', 'host', 'index.js'))

const WebServer = webServerModule.default ?? webServerModule.WebServer ?? webServerModule

function request(port, options, body) {
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

console.log('\n== compose: connection arrives after the plugin ==')
const ctx = new Context()

// connection 的替身：apply 卡在闸门上，闸门由测试放行 —— 真 connection 的 async apply 就是这个形状
let releaseConnection = () => {}
const connectionGate = new Promise((resolve) => {
  releaseConnection = resolve
})
const apiRoutes = new Map()
let connectionFiber

const connectionStub = {
  name: 'stub-connection',
  apply: async (scope) => {
    await connectionGate
    scope.provide('connection', {
      fetch: {
        register(route) {
          apiRoutes.set(route.path, route)
          return () => apiRoutes.delete(route.path)
        },
      },
      // 未认证一律 401：自留的 SSE 路由靠这条裁定
      requestRejection: () => 401,
    })
  },
}

const webServerFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await webServerFiber
const port = ctx.get('webServer').port
check(typeof port === 'number' && port > 0, 'webServer bound a port', String(port))

// 都不 await：connection 与插件同时激活，插件先看到 webServer、后看到 connection
connectionFiber = ctx.plugin(connectionStub, {})
const notifyFiber = ctx.plugin({ apply: plugin.apply, name: plugin.name, Config: plugin.Config })

// 先放行插件自己的激活，再放行 connection —— 把竞态钉死成"connection 迟到"
await notifyFiber
releaseConnection()
await connectionFiber
await new Promise((resolve) => setTimeout(resolve, 50))

console.log('\n== browser surface still installs ==')
const stream = await request(port, {
  method: 'GET',
  path: '/dsh-notify/stream',
  headers: { accept: 'text/event-stream' },
})
eq(stream.status, 401, 'SSE 路由已注册（未认证被承运层裁定挡下，而不是 404 路由缺席）')

check(apiRoutes.has('/api/dsh-notify.state'), '/api/dsh-notify.state 已注册到承运通道')
check(apiRoutes.has('/api/dsh-notify.test'), '/api/dsh-notify.test 已注册到承运通道')
check(!apiRoutes.has('/api/dsh-notify.nope'), '只注册声明的两个方法')

const stateRoute = apiRoutes.get('/api/dsh-notify.state')
if (stateRoute) {
  const response = await stateRoute.fetch(new Request('http://127.0.0.1/api/dsh-notify.state', { method: 'POST' }))
  const payload = await response.json()
  eq(response.status, 200, 'state 方法应答 200')
  eq(payload.ok, true, 'state 方法回了 ok')
  eq(payload.config.browser, true, 'state 快照里浏览器系统通知是开的')
}

const rows = []
ctx.events.emit('webserver/index-inject', rows)
const metaRow = rows.find((row) => typeof row.html === 'string' && row.html.includes('name="dsh-notify"'))
check(metaRow !== undefined, 'index 里注入了 dsh-notify 的 meta')
if (metaRow) {
  eq(metaRow.placement, 'head', 'meta 注入在 head')
  const value = /content='([^']*)'/.exec(metaRow.html)?.[1] ?? ''
  const meta = JSON.parse(value.replace(/&#39;/g, "'"))
  eq(meta.endpoint, '/dsh-notify/stream', 'meta 里带着流地址')
  eq(meta.channels.browser, true, 'meta 里浏览器系统通知是开的')
}

console.log('\n== teardown ==')
await notifyFiber.dispose()
await new Promise((resolve) => setTimeout(resolve, 50))
const afterDispose = await request(port, { method: 'GET', path: '/dsh-notify/stream' })
eq(afterDispose.status, 404, '卸载后自留路由被摘掉')
check(!apiRoutes.has('/api/dsh-notify.state'), '卸载后承运通道上的方法被摘掉')
await connectionFiber.dispose()
await webServerFiber.dispose()

report('install-order.test')
