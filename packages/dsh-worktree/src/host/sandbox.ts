// 沙箱可写范围的前置判定。
//
// DSH 的 workspace-write 只放行「会话工作区」这一个根（外加宿主临时目录），而面板可以
// 选任意工作区。目标仓库落在根外时，宿主沙箱（macOS Seatbelt / Linux Landlock）会让
// 子进程拿到 EPERM，git 只打印 "Operation not permitted"，从文案上看不出是权限范围问题。
// 所以建 worktree 之前先在这里判一次，给出能直接照做的错误；真正的写权限仍由宿主强制，
// 这里只是把"看不懂的失败"翻译成"看得懂的拒绝"。
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve, sep } from 'node:path'

import { ERR } from './constants.js'
import type { SandboxPolicyLike } from './services.js'

/**
 * 归一成真实路径：不存在的尾巴按"最近存在的祖先"展开（realpath 只对已存在的部分有效），
 * 这样 /tmp 与 /private/tmp 这类同一位置的两种写法不会互相误判。
 */
export function canonicalPath(target: string): string {
  const absolute = resolve(target)
  const tail: string[] = []
  let current = absolute
  for (let depth = 0; depth < 64; depth++) {
    try {
      return resolve(realpathSync(current), ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.push(basename(current))
      current = parent
    }
  }
  return absolute
}

/** target 是否落在 root 内（root 自身也算在内） */
export function isInsideRoot(root: string, target: string): boolean {
  const base = canonicalPath(root)
  const path = canonicalPath(target)
  if (path === base) return true
  return path.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * workspace-write 真正放行的写根：会话工作区 + 宿主临时区域（`/tmp` 与 `os.tmpdir()`）。
 *
 * 上游 `@deepseek-ai/dsh-sandbox` 的 `writableRoots()` 就是这套语义，本地 provider 直接
 * 拿它生成 Seatbelt/Landlock 规则；但那个包没有 `dsh` manifest、不是公共契约（见仓库
 * AGENTS.md），所以这里按语义重写，少一个要跟着上游改的 import。
 */
export function writableRoots(policy: SandboxPolicyLike): string[] {
  if (policy.mode !== 'workspace-write') return []
  const roots: string[] = []
  for (const root of [policy.workspaceRoot, '/tmp', tmpdir()]) {
    if (typeof root !== 'string' || root === '') continue
    const canonical = canonicalPath(root)
    if (roots.indexOf(canonical) < 0) roots.push(canonical)
  }
  return roots
}

export interface SandboxRefusal {
  error: string
  detail: string
}

/**
 * 建 worktree 前的前置判定；返回 null = 放行。
 *
 * - 拿不到策略（宿主没挂沙箱服务）或 danger-full-access：不判
 * - read-only：任何写都会被拒，直接说清楚，别让 git 去撞
 * - workspace-write：目标仓库与 worktree 目录都必须落在某个可写根内（会话工作区 / 临时区域）
 */
export function sandboxRefusal(
  policy: SandboxPolicyLike | undefined,
  targets: readonly string[],
): SandboxRefusal | null {
  if (!policy) return null
  if (policy.mode === 'danger-full-access') return null
  if (policy.mode === 'read-only') {
    return {
      error: ERR.sandboxReadOnly,
      detail: '当前会话的文件权限是只读（read-only）：建 worktree 要写目标仓库，先把权限切到 workspace-write',
    }
  }
  const roots = writableRoots(policy)
  // 认不出的模式（上游将来新增）不判：宁可不拦，也不要因为不认识就拒绝
  if (roots.length === 0) return null
  const outside = targets.filter((target) => !roots.some((root) => isInsideRoot(root, target)))
  if (outside.length === 0) return null
  return {
    error: ERR.sandboxOutside,
    detail:
      `目标不在沙箱的可写范围内（目标：${outside[0]}；可写根：${roots.join('、')}）。` +
      'workspace-write 只允许写会话工作区与宿主临时目录（没有会话时回退到宿主启动目录）：' +
      '请在以该仓库为工作区的会话里创建 worktree，或把当前会话的工作区切到该仓库后重试',
  }
}

/**
 * git 的失败原文是不是"写被内核拒了"。macOS 沙箱拒写回 EPERM，git 的表现是
 * "Operation not permitted"（常见于 cannot lock ref）；Linux 侧可能是 EACCES。
 * 只认这两个信号，别把并发产生的陈旧锁也误判成沙箱。
 */
export function looksLikeWriteDenied(text: string): boolean {
  return /Operation not permitted|Permission denied/i.test(text)
}
