// 平台种子模块 @deepseek-ai/dsh-client-ui-primitives 的类型垫层。这个包不在插件的依赖里
// ——它是浏览器运行时静态模块表里的一项，由 shell 提供实例，bundle 里只会留下
// require("@deepseek-ai/dsh-client-ui-primitives")（见 tsdown.config.ts 的 neverBundle）。
// 这里只声明本插件真正用到的那几个导出，够 tsc 抓住用错的 props 即可。
//
// 为什么不用同包的 Toast：它是"单条、top-center、pointer-events: none、到点淡出并卸载"
// 的瞬时横幅，装不下这个插件的四种形态（最多 4 条堆栈、20s 常驻等用户动作、多行体检块、
// 整卡可点跳会话）。组件层复用 Button / Tag / Icon* 这几个真正契合的就够了。
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'

  /** 按钮视觉族，各自对应一组 --dsw-alias-button-* token */
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  /** 按钮：variant 默认 ghost，size='sm' 是 28px 控件 */
  export function Button(
    props: {
      variant?: ButtonVariant
      size?: 'md' | 'sm'
      icon?: ReactNode
      className?: string
      children?: ReactNode
    } & ButtonHTMLAttributes<HTMLButtonElement>,
  ): ReactElement

  /** 只读标签：tone 决定配色，success/warning/info 都带 10-12% 底色 */
  export function Tag(props: {
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string
    children?: ReactNode
  }): ReactElement

  /** 产品图标：size 默认各自绘制尺寸，颜色随 currentColor */
  export interface IconProps {
    size?: number
    className?: string
  }

  export function IconCheckCircleOutlineRegular(props: IconProps): ReactElement
  export function IconShieldOutlineRegular(props: IconProps): ReactElement
  export function IconQuestionOutlineRegular(props: IconProps): ReactElement
  export function IconCloseOutlineRegular(props: IconProps): ReactElement
}
