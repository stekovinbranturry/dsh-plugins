// 客户端半的测试入口：把纯逻辑与胶水层都从源码再导出一遍，让 test/client.test.mjs
// 能直接吃它们（不打 React 渲染，只测数据与副作用分支）。
export { createController, apply, name, inject } from '../src/client/index.js'
export { readBootMeta, ackEnabled } from '../src/client/host.js'
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
export { requestPermission, notificationSupported, probeBrowserNotification, pageHidden, showBrowserNotification } from '../src/client/effects.js'
export { TITLE_PREFIX, TOAST_TTL, KIND_TITLE } from '../src/client/constants.js'
