/**
 * 工作区选择：和 DSH 自己的工作区选择器一致 —— **单选**，点标题展开一个浮层菜单
 * （文件夹图标 + 标题，当前项打勾），**没有**输入搜索框。
 *
 * 浮层直接用平台的 `Menu`：0.1.7 起 `--dsw-specific-menu` 是带 alpha 的色
 * （浅色 `#f8f9fa94` / 深色 `#30313680`），官方 `.list` 靠
 * `backdrop-filter: var(--dsw-menu-backdrop-filter)` 把它磨成毛玻璃；原先手写的那份
 * 只抄了 `background`，于是浮层整块透明、底下的文字全透出来。换成平台组件顺带白拿
 * 键盘走查（Tab / 方向键 / Esc）、外点关闭、选中后焦点回到触发器，以及 `portal`
 * 渲染到 body 躲开祖先的 overflow 裁剪。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'

import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'

import type { WorkspaceView } from './types.js'
import { IconChevronDown, IconFolder, IconFolderOption } from './icons.js'

interface WorkspaceComboProps {
  items: readonly WorkspaceView[]
  /** 当前选中的工作区 id（Menu 的 selectedId 用它画勾） */
  value: string | null
  /** 还没匹配到工作区时触发器展示的文本（通常是当前工作区路径） */
  display: string
  onPick: (workspaceId: string) => void
}

export function WorkspaceCombo({ items, value, display, onPick }: WorkspaceComboProps): ReactElement {
  const [open, setOpen] = useState(false)
  const chosen = items.find((item) => item.workspaceId === value) ?? null

  return (
    <Menu
      className="wt-ws-picker"
      open={open}
      portal
      align="end"
      onClose={() => setOpen(false)}
      selectedId={value ?? undefined}
      items={items.map((item) => ({ id: item.workspaceId, label: item.title, icon: <IconFolderOption /> }))}
      onSelect={(id) => {
        setOpen(false)
        onPick(id)
      }}
      anchor={
        <button
          type="button"
          className={'wt-ws-trigger' + (open ? ' wt-ws-trigger-open' : '')}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="选择工作区"
          onClick={() => setOpen((previous) => !previous)}
        >
          <span className="wt-ws-trigger-icon">
            <IconFolder />
          </span>
          <span className="wt-ws-trigger-label">{chosen?.title ?? display}</span>
          <span className={'wt-ws-chevron' + (open ? ' wt-ws-chevron-open' : '')}>
            <IconChevronDown />
          </span>
        </button>
      }
    />
  )
}
