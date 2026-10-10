// 浏览器半与宿主半共用线格式，这里再导出一份给客户端源码 import（tsc 按相对路径解析）
export type {
  Channels,
  NotifyHello,
  NotifyKind,
  NotifyState,
  NotifyTestResult,
  NotifyWire,
  Permission,
  QuestionPayload,
  TurnEndPayload,
  TurnStatus,
} from '../shared/types.js'
