// 客户端半的测试入口：把纯逻辑与胶水层都从源码再导出一遍，让 test/client.test.mjs
// 能直接吃它们（不打 React 渲染，只测数据与副作用分支）。
export { registerSettingsNavIcon, SETTINGS_NAV_ATTRIBUTE } from '../src/client/settings-nav-icon.js'
export { createController, apply, name, inject } from '../src/client/index.js'
export { readBootMeta, ackEnabled, openStream } from '../src/client/host.js'
export {
  createStore,
  reduceAppend,
  reduceDismiss,
  toastLines,
  EMPTY_STATE,
} from '../src/client/store.js'
export { formatDuration } from '../src/shared/duration.js'
export { browserBody, notificationPermission, resetTitleMarker, titleMarker } from '../src/client/effects.js'
export { activateCard, browserAskable, isButtonClick, ToastStack } from '../src/client/Toasts.js'
// ToastCard 不含任何 hook：测试可以直接当函数调，拿到元素树验"按钮接的是哪个 handler"
export { ToastCard } from '../src/client/ToastCard.js'
export { requestPermission, notificationSupported, probeBrowserNotification, pageHidden, showBrowserNotification } from '../src/client/effects.js'
export { TITLE_PREFIX, TOAST_TTL, KIND_TITLE } from '../src/client/constants.js'
// 设置页：表单模型（普通对象，可当 hooks 源也能直接断言写哪一笔）、解析纯函数、座位常量。
// 组件本身带 hook（useSettings/useState），只能走 react-dom/server 渲染，不能当函数调。
export {
  installSettingsSection,
  NotifySettingsModel,
  NotifySettingsSection,
  parseHeaders,
  formatHeaders,
  sameHeaders,
  SETTINGS_FIELDS,
  SETTINGS_LABEL,
  SETTINGS_NS,
  SETTINGS_ORDER,
  SETTINGS_SECTION,
  TIMING_TOGGLES,
  CHANNEL_TOGGLES,
  CONTENT_TOGGLES,
} from '../src/client/settings.js'
