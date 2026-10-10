// 宿主只回 JSON：请求体解析与错误到文本。
//
// 路由注册在 ctx.connection 的 /api 通道上，所以 handler 是 fetch 形态（Request → Response），
// 不是 webServer 的 Node req/res —— 信任围栏与浏览器认证由承运层先做完，这里只管业务。

export type ApiArgs = Record<string, unknown>

export const BODY_LIMIT = 1 << 20

export function errText(error: unknown): string {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return String((error as { message?: unknown }).message || error)
}

export function jsonResponse(status: number, payload: unknown): Response {
  return Response.json(payload, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

// 体先整段读进来再判上限：承运层给这类路由的缓冲上限远大于面板接口需要的量，
// 这里的 1MiB 才是真正的闸门
export async function readJsonRequest(request: Request): Promise<ApiArgs> {
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > BODY_LIMIT) throw new Error('payload-too-large')
  if (text.trim() === '') return {}
  const parsed: unknown = JSON.parse(text)
  // 非对象体一律当空参数，交给各 handler 的参数校验去拒
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as ApiArgs)
    : {}
}
