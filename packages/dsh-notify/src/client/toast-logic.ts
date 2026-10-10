// 提示条卡片的三个交互纯函数。单独一个文件是为了打破循环：ToastStack 要渲染 ToastCard，
// 而 ToastCard 要用这几个函数 —— 留在 Toasts.tsx 会让两个组件文件互相 import。
//
// 对外仍从 Toasts.tsx re-export，测试入口（test/client-entry.ts）的 import 路径不变。
import type { Permission } from './types.js'

export type ClickLike = { target: EventTarget | null; currentTarget: EventTarget | null }

/** 卡片里有按钮：点按钮时不要再让卡片自己处理一次点击。导出供单测直接吃。 */
export function isButtonClick(event: ClickLike): boolean {
  let node = event.target as HTMLElement | null
  const stop = event.currentTarget as HTMLElement | null
  while (node && node !== stop) {
    if (node.tagName === 'BUTTON') return true
    node = node.parentElement
  }
  return false
}

/**
 * 卡片被点 / 被回车：能跳就跳回对话，跳完顺手收掉这条（跳过去了它就没用了）。
 * 没有 sessions 服务时 onOpen 是 undefined，只当作普通点击，什么也不做。
 */
export function activateCard(
  openable: boolean,
  handlers: { onOpen?: () => void; onDismiss: () => void },
): boolean {
  if (!openable) return false
  handlers.onOpen?.()
  handlers.onDismiss()
  return true
}

/**
 * 什么时候给"开启系统通知"按钮：只有还没问过（default）时才有意义。
 * 被拒之后 requestPermission() 不会再弹窗，那时给按钮等于给一个点不动的按钮，
 * 指引改由自检卡上的体检结论承担。
 */
export function browserAskable(permission: Permission): boolean {
  return permission === 'default'
}
