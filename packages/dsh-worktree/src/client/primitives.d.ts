// 平台种子模块 @deepseek-ai/dsh-client-ui-primitives 的类型垫层。这个包不在插件的依赖里
// ——它是浏览器运行时的静态模块表（PLATFORM_MODULES）里的一项，由 shell 提供实例，
// bundle 里只会留下 require("@deepseek-ai/dsh-client-ui-primitives")（见 tsdown.config.ts 的
// neverBundle）。这里只声明本插件真正用到的那几个导出，够 tsc 抓住用错的 props 即可。
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement, ReactNode } from 'react'

  /** 一枚可选中的行：icon 是行首图标，选中标记由 Menu 自己按 selectedId 画 */
  export interface MenuItem {
    id: string
    label: ReactNode
    icon?: ReactNode
    disabled?: boolean
    danger?: boolean
  }

  /**
   * 锚定在 anchor 上的下拉菜单（owner 控 open）。align 是相对 anchor 的水平对齐，
   * side 是上下方向，portal 渲染到 document.body 以躲开祖先的 overflow 裁剪 ——
   * 与官方 dsh-client-ui-workspace 的交互一致。
   */
  export interface MenuProps {
    className?: string
    open: boolean
    /** 打开时自动聚焦第一行；不传则保留「打开时整列都不高亮」的视觉 */
    autoFocus?: boolean
    portal?: boolean
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    anchor: ReactElement
    items?: readonly MenuItem[]
    /** 当前选中行的 id（画右侧勾） */
    selectedId?: string
    onSelect?: (id: string) => void
    onClose: () => void
  }

  export function Menu(props: MenuProps): ReactElement

  /** 悬停气泡：label 是气泡文本（必填），disabled 为 true 时气泡完全不出现
   *  （官方 settings 触发器在弹窗打开时用它关掉气泡）。side 默认 right，delayMs 默认 0。 */
  export interface TooltipProps {
    label: string
    side?: 'top' | 'right' | 'bottom' | 'left'
    delayMs?: number
    maxWidth?: number
    disabled?: boolean
    children?: ReactNode
  }

  export function Tooltip(props: TooltipProps): ReactElement
}
