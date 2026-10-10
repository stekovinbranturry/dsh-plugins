import type { ServerResponse } from 'node:http'

export function errText(error: unknown): string {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return String((error as { message?: unknown }).message || error)
}

/** /api 承运通道上的 handler 回这个（fetch 形态） */
export function jsonResponse(status: number, payload: unknown): Response {
  return Response.json(payload, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

/** 自留的 webServer 路由（SSE 长连）还是 Node res，错误路径用它 */
export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}
