/** 面板接口在 DSH 的 `/api` 承运通道上的地址：`/api/dsh-worktree.<method>`。
 *
 * 注册在 ctx.connection（dsh-client-connection）而不是自建 webServer 前缀路由：承运层在把请求
 * 交给 handler 之前就已经做完信任围栏（Host / Origin）与浏览器认证，宿主半不需要再抄一份围栏，
 * 也不用自己回 403。命名与 DSH 自己的 present.open 一致，所以客户端半依然是普通同源 fetch
 * （浏览器认证走的是 /api 通道上的 cookie）。
 *
 * 端点段受承运层的 /^[A-Za-z0-9_$.-]+$/ 约束，所以用点连接而不是再分一层路径。
 */
export const API_NAMESPACE = '/api/dsh-worktree'

export function apiPath(method: string): string {
  return API_NAMESPACE + '.' + method
}
