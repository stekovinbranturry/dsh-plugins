// 平台种子模块 @deepseek-ai/dsh-client-ui-primitives 的类型垫层。这个包不在插件的依赖里
// ——它是浏览器运行时的静态模块表（PLATFORM_MODULES）里的一项，由 shell 提供实例，
// bundle 里只会留下 require("@deepseek-ai/dsh-client-ui-primitives")（见 tsdown.config.ts 的
// neverBundle）。这里只声明本插件真正用到的那几个导出，够 tsc 抓住用错的 props 即可。
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'

  export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
  }): ReactElement

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

  /** 平台浮层自动淡出；onDone 由调用方清掉本次反馈。 */
  export function Toast(props: {
    text: string
    icon?: ReactNode
    onDone: () => void
  }): import('react').ReactPortal

  /**
   * 平台模态框。官方「删除工作区」用的就是它：footer 放「取消 + 危险按钮」，deleting 时
   * 按钮 disabled 并给 role="status"，错误给 role="alert"。删 worktree 的确认框同理。
   * 用平台件而不是自绘，是为了跟 shell 的焦点陷阱、Esc 关闭、层叠上下文保持一致。
   */
  export interface ModalProps {
    open: boolean
    onClose: () => void
    title: ReactNode
    /** headless 为 true 时必须是 never —— 平台不画头部，关闭只能靠 onClose */
    closeLabel?: string
    description?: ReactNode
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    onKeyDownCapture?: (event: KeyboardEvent) => void
    backdropBlur?: boolean
    shortcutModal?: boolean
    headless?: boolean
  }

  export function Modal(props: ModalProps): import('react').ReactPortal | null

  /** 平台勾选框。删 worktree 用它承载「强制删除」「连本地分支一起删」这类显式选择。 */
  export function Checkbox(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: ReactNode
    disabled?: boolean
    title?: string
    className?: string
  }): ReactElement

  /** 垃圾桶图标（平台现成，删 worktree 的按钮与菜单项都用它）。size 默认 16，颜色跟 currentColor。 */
  export function IconTrashOutlineRegular(props: { size?: number; className?: string }): ReactElement

  /** 警告三角（平台现成，确认框里标「这个 worktree 在仓库外部」）。size 默认 16，颜色跟 currentColor。 */
  export function IconWarningTriangleOutlineRegular(props: { size?: number; className?: string }): ReactElement
}
