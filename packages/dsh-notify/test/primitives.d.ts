// 让 tsc 认下测试替身：源码 import 的是平台种子模块名，测试构建把它 alias 到
// ./primitives-shim.cjs（见 tsdown.test.config.ts）。形状与 src/client/primitives.d.ts 一致。
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  export function Button(
    props: {
      variant?: ButtonVariant
      size?: 'md' | 'sm'
      icon?: ReactNode
      className?: string
      children?: ReactNode
    } & ButtonHTMLAttributes<HTMLButtonElement>,
  ): ReactElement

  export function Tag(props: {
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string
    children?: ReactNode
  }): ReactElement

  export interface IconProps {
    size?: number
    className?: string
  }

  export function IconCheckCircleOutlineRegular(props: IconProps): ReactElement
  export function IconShieldOutlineRegular(props: IconProps): ReactElement
  export function IconQuestionOutlineRegular(props: IconProps): ReactElement
  export function IconCloseOutlineRegular(props: IconProps): ReactElement
}
