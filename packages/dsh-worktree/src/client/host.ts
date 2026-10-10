/** 宿主调用：唯一的网络出口，以及错误码到人话的翻译。 */
import { apiPath } from '../shared/api.js'
import type { ErrorResult } from './types.js'

// 打的是 DSH 的 /api 承运通道（ctx.connection.fetch.register 注册的端点）：同源普通 fetch
// 即可，Host/Origin 围栏与浏览器认证由承运层在进入宿主 handler 之前做完，401/403 都是它回的
export async function callHost<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(apiPath(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (res.status === 401 || res.status === 403) throw new Error('unauthorized')
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return (await res.json()) as T
}

/** 宿主只回错误码，翻译成人话在这一层做一次 */
export function errLabel(result: ErrorResult): string {
  const detail = result.detail ? '（' + result.detail + '）' : ''
  switch (result.error) {
    case 'no-workspace':
      return '还没有选中的工作区：先在左侧添加/选择一个工作区' + detail
    case 'not-a-git-repo':
      return '选中的工作区不是 git 仓库' + detail
    case 'bad-branch':
      return '分支名不可用' + detail
    case 'branch-not-found':
      return '找不到这个分支' + detail
    case 'branch-already-checked-out':
      return '这个分支已经在别的 worktree 里检出了' + detail
    case 'branch-already-exists':
      return '本地已经有同名分支了' + detail
    case 'base-not-found':
      return '起点分支不存在' + detail
    case 'missing-branch-target':
      return '填一个新分支名，或选一个已有分支' + detail
    case 'bad-worktree-name':
      return '目录名不合法' + detail
    case 'worktree-exists':
      return '同名目录已经存在' + detail
    case 'worktree-not-found':
      return '找不到这个 worktree' + detail
    case 'worktree-add-failed':
      return 'git worktree add 失败' + detail
    case 'sandbox-read-only':
      return '当前会话是只读权限，建不了 worktree' + detail
    case 'workspace-outside-sandbox':
      return '这个仓库不在沙箱的可写范围内' + detail
    case 'sandbox-write-denied':
      return '写被拒绝（沙箱范围或文件权限）' + detail
    case 'open-session-failed':
      return '创建会话失败' + detail
    default:
      return result.error + detail
  }
}
