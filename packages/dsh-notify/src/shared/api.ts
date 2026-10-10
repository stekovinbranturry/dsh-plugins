/** 浏览器半调宿主用的地址。
 *
 * JSON 方法挂在 DSH 的 `/api` 承运通道上（`/api/dsh-notify.<method>`，注册在
 * ctx.connection.fetch，见 host/web.ts）：信任围栏与浏览器认证由承运层在进 handler 之前做完，
 * 宿主半不需要再抄一份围栏。
 *
 * 端点段受承运层的 /^[A-Za-z0-9_$.-]+$/ 约束，所以用点连接而不是再分一层路径。
 */
export const API_NAMESPACE = '/api/dsh-notify'

export function apiPath(method: string): string {
  return API_NAMESPACE + '.' + method
}
