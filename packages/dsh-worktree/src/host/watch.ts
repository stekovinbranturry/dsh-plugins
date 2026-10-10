import { existsSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

import type { ClientModules } from './services.js'
import type { Context } from '@deepseek-ai/cordis'

// 客户端 bundle 的内容变更只能经 ClientModuleRegistry.rebuilt() 进入 boot graph
// （见 @deepseek-ai/dsh-client-modules 的类型注释：它是唯一入口），浏览器 HMR
// 接收器随后换用新的 revisioned combo URL。开发树里自己盯 dist/client.js，就能做到
// 改客户端不重启 DSH
//
// 必须盯目录而不是文件：macOS 上 watch(文件) 走 kqueue、句柄绑 inode，而构建脚本
// 的第一件事是 `rm -rf dist`；被盯的 inode 一删，后续所有构建都收不到事件（只有那次
// 删除本身会触发一下）。盯父目录走 FSEvents、按路径重新绑定，目录被删再建也能继续收
const DISABLE_ENV = 'DSH_WORKTREE_NO_WATCH'
const DEBOUNCE_MS = 80

export function installClientWatch(ctx: Context, entryId: string, bundlePath: string): boolean {
  if (process.env[DISABLE_ENV] === '1') return false
  // 只有开发树（link 安装）才盯盘；打包安装的路径里带 node_modules
  if (bundlePath.includes('node_modules')) return false
  if (!existsSync(bundlePath)) {
    console.warn('[dsh-worktree] no client bundle at ' + bundlePath + ' - run `npm run build`')
    return false
  }
  const registry = ctx.get('clientModules') as ClientModules | undefined
  if (!registry || typeof registry.rebuilt !== 'function') return false

  ctx.effect(() => {
    let timer: NodeJS.Timeout | null = null
    let watcher: FSWatcher
    const dir = dirname(bundlePath)
    const target = basename(bundlePath)
    try {
      watcher = watch(dir, { persistent: false })
    } catch (error) {
      console.warn(
        '[dsh-worktree] cannot watch client bundle dir: '
          + (error instanceof Error ? error.message : String(error)),
      )
      return () => {}
    }
    // 同目录还有 .map 等文件；filename 为 null 的平台（如某些 Linux）不过滤，宁可多算一次
    const onEvent = (_event: string, filename: string | null): void => {
      if (filename !== null && filename !== target) return
      // 构建器写文件往往是多次事件，合并后只重算一次
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        try {
          const rev = registry.rebuilt(entryId)
          if (rev) console.log('[dsh-worktree] client bundle rebuilt -> rev ' + rev)
          else console.warn('[dsh-worktree] rebuilt() does not know entry ' + entryId)
        } catch (error) {
          console.warn(
            '[dsh-worktree] rebuilt() failed: '
              + (error instanceof Error ? error.message : String(error)),
          )
        }
      }, DEBOUNCE_MS)
    }
    watcher.on('change', onEvent)
    watcher.on('rename', onEvent)
    return () => {
      if (timer) clearTimeout(timer)
      watcher.close()
    }
  }, 'dsh-worktree: client bundle watch')
  return true
}
