// 一张提示条卡片。点卡片（或卡片上的"打开会话"）通过 uiWorkspace.openSession(sessionId)
// 跳回那个对话；没有这个服务时整张卡片都不可点，"打开会话"按钮也不显示。
//
// 组件层复用 DSH primitives：Button（按钮）、Tag（通知类型标签）、Icon*（产品图标）。
// 原来这里手写了一套 .nt-btn 和四个 SVG，各自都是 primitives 已有的等价物 —— 抄的每一行
// 都是将来要跟着上游改的一行。样式层只保留布局与动效，配色全走 --dsw-* token。
import * as React from 'react'
import {
  Button,
  IconCheckCircleOutlineRegular,
  IconCloseOutlineRegular,
  IconQuestionOutlineRegular,
  IconShieldOutlineRegular,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { KIND_ACCENT, KIND_TONE } from './constants.js'
import { toastLines } from './store.js'
import { activateCard, browserAskable, isButtonClick } from './toast-logic.js'
import type { NotifyWire, Permission } from './types.js'

export interface ToastCardProps {
  wire: NotifyWire
  onDismiss: () => void
  onOpen?: () => void
  onAskBrowser?: () => void
  browserPermission?: Permission
}

/** 三种通知各一枚产品图标，取 primitives 的常规描边版（与卡片 16px 图标位一致） */
function KindIcon(props: { kind: NotifyWire['kind'] }): React.ReactElement {
  const size = 16
  if (props.kind === 'approval') return <IconShieldOutlineRegular size={size} />
  if (props.kind === 'question') return <IconQuestionOutlineRegular size={size} />
  return <IconCheckCircleOutlineRegular size={size} />
}

export function ToastCard(props: ToastCardProps): React.ReactElement {
  const { wire } = props
  const lines = toastLines(wire)
  const openable = typeof props.onOpen === 'function' && wire.sessionId !== ''
  const activate = { onOpen: props.onOpen, onDismiss: props.onDismiss }
  // 自检卡片上挂一个显式的授权入口：浏览器不给权限，切走之后的系统通知就发不出来
  const permission = props.browserPermission ?? 'unsupported'
  const askable = typeof props.onAskBrowser === 'function' && browserAskable(permission)

  const clickCard = (event: React.MouseEvent<HTMLElement>): void => {
    if (isButtonClick(event)) return
    activateCard(openable, activate)
  }

  const keyCard = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    activateCard(openable, activate)
  }

  return (
    <div
      className={openable ? 'nt-card nt-card-open' : 'nt-card'}
      role={openable ? 'button' : 'status'}
      tabIndex={openable ? 0 : undefined}
      title={openable ? '点击回到这个对话' : undefined}
      onClick={clickCard}
      onKeyDown={keyCard}
    >
      {/* 图标用自己的语义色，不再靠整卡 color 继承（那会把标题也染上色，压过正文层级） */}
      <span className="nt-icon" style={{ color: KIND_ACCENT[wire.kind] }}>
        <KindIcon kind={wire.kind} />
      </span>
      <div className="nt-main">
        <div className="nt-head">
          <Tag tone={KIND_TONE[wire.kind]} className="nt-kind">{lines.title}</Tag>
          {lines.meta !== '' ? <span className="nt-meta" title={lines.meta}>{lines.meta}</span> : null}
        </div>
        {lines.body !== '' ? <div className="nt-body">{lines.body}</div> : null}
        {wire.report && wire.report.length > 0 ? (
          <div className="nt-report">
            {wire.report.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        ) : null}
        <div className="nt-actions">
          {askable ? (
            <Button variant="primary" size="sm" onClick={props.onAskBrowser}>
              开启系统通知
            </Button>
          ) : null}
          {openable ? (
            <Button variant="primary" size="sm" onClick={props.onOpen}>
              打开会话
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={props.onDismiss}>
            {openable ? '稍后' : '知道了'}
          </Button>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="nt-close"
        onClick={props.onDismiss}
        aria-label="关闭"
      >
        <IconCloseOutlineRegular size={16} />
      </Button>
    </div>
  )
}
