// 提示条堆栈。状态在 store 里，这里只做渲染 + 交互；单张卡片在 ToastCard.tsx。
//
// 三个交互纯函数（isButtonClick / activateCard / browserAskable）从 toast-logic.ts
// re-export —— 测试入口按这个路径取它们。
import * as React from 'react'

import { ToastCard } from './ToastCard.js'
import type { Store } from './store.js'

export interface ToastStackProps {
  store: Store
  onOpenSession?: (sessionId: string) => void
  /** 点"开启系统通知"：走平台的授权流程 */
  onAskBrowser?: () => void
}

function useStoreState(store: Store): ReturnType<Store['getState']> {
  return React.useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

export { activateCard, browserAskable, isButtonClick } from './toast-logic.js'

export function ToastStack(props: ToastStackProps): React.ReactElement | null {
  const state = useStoreState(props.store)
  if (state.items.length === 0) return null
  return (
    <div className="nt-stack" aria-live="polite">
      {state.items.map((wire) => (
        <ToastCard
          key={wire.seq}
          wire={wire}
          browserPermission={state.permission}
          onDismiss={() => props.store.dismiss(wire.seq)}
          onOpen={props.onOpenSession ? () => props.onOpenSession?.(wire.sessionId) : undefined}
          onAskBrowser={wire.test === true ? props.onAskBrowser : undefined}
        />
      ))}
    </div>
  )
}
