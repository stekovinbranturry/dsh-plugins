// 设置页：把 notify 的 11 个配置项做成 DSH 设置对话框里的一页（导航文案"通知"）。
//
// 为什么必须自己画页：本版 DSH（0.2.1-rc.2）没有任何客户端自动表单渲染器 —— `autoGenerate`
// 只出现在 wire schema 与宿主实现里，全安装 grep 不到消费它的渲染分支。宿主侧把 Config 的
// volatile 字段投影成表单之后，还得由插件自己在客户端注册一页来接。
//
// 座位是 `settings.section`（设置对话框左侧导航的一项）。两道门都得过：
//   - `ctx.configForms.whileServed(['dsh-notify'])`：宿主真的在服务这个命名空间才注册；
//   - `ctx.slots.inject('settings.section', …)`：设置对话框声明了这个插槽才注册（直接 register
//     会撞 SlotOwnershipError）。
// 命名空间 = profile patch 条目的 id（`dsh-notify`），不是包名（`@zhanghanxuan/dsh-notify`）——
// 宿主侧 dsh-settings 的 `describe()` 用 `entry.options.id` 派生，写错这里就拿不到表单。
//
// 写值一律走 ConfigForm 的 set / unset：它内部串行排队、带 revision 围栏，被拒时返回 false
// 而不是抛 —— 所以 UI 只要把 false 翻成一句提示就行。
//
// 文案写死中文：插件其余文案（提示条按钮等）本来就是中文，为一个设置页引入 locale 服务不值。
import * as React from 'react'
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerSettingsNavIcon } from './settings-nav-icon.js'

import type {
  ClientContext,
  ConfigForm,
  ConfigFormSnapshot,
  ConfigFormsService,
  SlotsService,
} from './context.js'

/** 设置命名空间：profile patch 条目的 id（见 cordis.patch.yml 的 `- id:`） */
export const SETTINGS_NS = 'dsh-notify'
/** 座位：设置对话框左侧导航的一项 */
export const SETTINGS_SECTION = 'settings.section'
/** 官方已占用 order：account -10 / general 0 / models 10 / plugins 15 / agent-presets 20 */
export const SETTINGS_ORDER = 60
/** 设置对话框导航里的标题 */
export const SETTINGS_LABEL = '通知'

/** 宿主 Config 的 11 个字段在浏览器侧的投影（volatile 引用盒子已被宿主解包成裸值） */
export interface NotifySettingsView {
  notifyOnTurnEnd: boolean
  notifyOnApproval: boolean
  notifyOnQuestion: boolean
  includeSubagents: boolean
  browser: boolean
  ack: boolean
  sound: boolean
  title: boolean
  showPreview: boolean
  webhookUrl: string
  webhookHeaders: Record<string, string>
}

type SettingsSnapshot = ConfigFormSnapshot<NotifySettingsView>

type ToggleField =
  | 'notifyOnTurnEnd'
  | 'notifyOnApproval'
  | 'notifyOnQuestion'
  | 'includeSubagents'
  | 'browser'
  | 'ack'
  | 'sound'
  | 'title'
  | 'showPreview'

interface ToggleSpec {
  field: ToggleField
  label: string
  hint: string
}

/** 什么时候提醒 */
export const TIMING_TOGGLES: readonly ToggleSpec[] = [
  { field: 'notifyOnTurnEnd', label: '回合结束', hint: '会话跑完一轮时提醒' },
  { field: 'notifyOnApproval', label: '等待审批', hint: '有工具调用等你批准时提醒' },
  { field: 'notifyOnQuestion', label: '需要回答', hint: 'Agent 向你提问时提醒' },
  { field: 'includeSubagents', label: '子代理也算', hint: '子代理会话也提醒；默认不打扰' },
]

/** 用什么提醒 */
export const CHANNEL_TOGGLES: readonly ToggleSpec[] = [
  { field: 'browser', label: '系统通知', hint: '浏览器级通知，页面被遮住也能看到；需要授权' },
  { field: 'ack', label: '页内提示条', hint: '页面右上角的提示卡片，可点回对话' },
  { field: 'sound', label: '提示音', hint: '提醒时响一声' },
  { field: 'title', label: '标签页角标', hint: '把未读数写到标签页标题' },
]

/** 提醒内容 */
export const CONTENT_TOGGLES: readonly ToggleSpec[] = [
  { field: 'showPreview', label: '内容预览', hint: '通知正文里带上会话标题与回复片段' },
]

/** 这一页覆盖的字段。测试拿它跟宿主 Config 的字段表对账 —— 加了配置项忘了上页会当场红。 */
export const SETTINGS_FIELDS: readonly (keyof NotifySettingsView)[] = [
  ...TIMING_TOGGLES.map((spec) => spec.field),
  ...CHANNEL_TOGGLES.map((spec) => spec.field),
  ...CONTENT_TOGGLES.map((spec) => spec.field),
  'webhookUrl',
  'webhookHeaders',
]

/**
 * `key=value` 每行一条 → 对象。空行与 `#` 开头的行忽略；没有 `=` 或 key 为空的行也忽略；
 * 值里的 `=` 保留（只切第一个）。
 */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key === '') continue
    out[key] = line.slice(at + 1).trim()
  }
  return out
}

/** 对象 → `key=value` 每行一条（parseHeaders 的逆，用来给文本框填初值） */
export function formatHeaders(headers: Record<string, string> | undefined): string {
  if (headers === undefined) return ''
  return Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/** 两个 header 表是否等价（顺序无关）—— 决定失焦时要不要真写一次 */
export function sameHeaders(
  left: Record<string, string>,
  right: Record<string, string> | undefined,
): boolean {
  const other = right ?? {}
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(other).length) return false
  return keys.every((key) => other[key] === left[key])
}

/**
 * 设置页的表单模型：包一层 ConfigForm，把"用户动作"翻成"写哪个字段"。
 *
 * 做成不含 React 的普通对象有两个用处：它自带 `getSnapshot`/`subscribe`，正好当渲染器的
 * hooks 源（`hooks: { notifySettings: model }` → 组件拿到 `useNotifySettings`）；测试里也能
 * 直接断言"拨一下开关到底写了哪个字段"，不用真跑 React。
 */
export class NotifySettingsModel {
  constructor(private readonly form: ConfigForm<NotifySettingsView>) {}

  getSnapshot(): SettingsSnapshot {
    return this.form.getSnapshot()
  }

  subscribe(listener: () => void): () => void {
    return this.form.subscribe(listener)
  }

  /** 拨一个开关：直接写它自己的字段 */
  setToggle(field: ToggleField, next: boolean): Promise<boolean> {
    return this.form.set(field, next)
  }

  /** 失焦提交转发地址；没变返回 undefined（不写） */
  commitUrl(text: string): Promise<boolean> | undefined {
    const next = text.trim()
    if (next === (this.snapshotValue()?.webhookUrl ?? '')) return undefined
    return next === '' ? this.form.unset('webhookUrl') : this.form.set('webhookUrl', next)
  }

  /** 失焦提交附加请求头；没变返回 undefined（不写） */
  commitHeaders(text: string): Promise<boolean> | undefined {
    const next = parseHeaders(text)
    if (sameHeaders(next, this.snapshotValue()?.webhookHeaders)) return undefined
    return Object.keys(next).length === 0
      ? this.form.unset('webhookHeaders')
      : this.form.set('webhookHeaders', next)
  }

  private snapshotValue(): NotifySettingsView | undefined {
    return this.form.getSnapshot().value
  }
}

/**
 * 设置页的 props。渲染器会把 inject 面里的 `hooks.notifySettings` 按
 * `use` + 首字母大写变成 `useNotifySettings`（`standardHookPropName`），其余键原样传进来。
 *
 * 两个都可能是 undefined（宿主版本不对、加载顺序不对），所以整页按"拿不到就不渲染表单"处理。
 */
export interface NotifySettingsProps {
  useNotifySettings?: (
    select: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  ) => SettingsSnapshot
  settings?: NotifySettingsModel
}

export function NotifySettingsSection(props: NotifySettingsProps): React.ReactElement {
  const hook = props.useNotifySettings
  const settings = props.settings
  if (hook === undefined || settings === undefined) {
    return (
      <p className="nt-set-note">设置页没拿到平台表单（宿主版本或加载顺序不对），重开设置面板试试。</p>
    )
  }
  return <NotifySettingsForm useSettings={hook} settings={settings} />
}

interface NotifySettingsFormProps {
  useSettings: NonNullable<NotifySettingsProps['useNotifySettings']>
  settings: NotifySettingsModel
}

function NotifySettingsForm(props: NotifySettingsFormProps): React.ReactElement {
  // 选整份快照：ConfigForm 的 getSnapshot() 返回稳定引用，identity 选择器不会白渲染。
  const snapshot = props.useSettings((state) => state)
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState('')

  const run = (write: Promise<boolean> | undefined): void => {
    if (write === undefined) return
    setBusy(true)
    setNote('')
    write
      .then((accepted) => {
        setNote(accepted ? '已保存' : '宿主没有接受这次修改，请重试。')
      })
      .catch(() => {
        setNote('写入失败，请重试。')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const view = snapshot.value
  const ready = snapshot.status === 'ready' && view !== undefined
  const disabled = !snapshot.writable || busy

  return (
    <div className="nt-set">
      <p className="nt-set-intro">会话跑完、需要你审批、或者需要你回答时提醒你。渠道可以单独关。</p>
      {ready ? (
        <React.Fragment>
          {snapshot.writable ? null : (
            <p className="nt-set-note">当前部署把插件设置存成只读，改不了。</p>
          )}
          <Group title="什么时候提醒">
            {TIMING_TOGGLES.map((spec) => (
              <ToggleRow
                key={spec.field}
                spec={spec}
                checked={view[spec.field]}
                disabled={disabled}
                onToggle={(next) => run(props.settings.setToggle(spec.field, next))}
              />
            ))}
          </Group>
          <Group title="用什么提醒">
            {CHANNEL_TOGGLES.map((spec) => (
              <ToggleRow
                key={spec.field}
                spec={spec}
                checked={view[spec.field]}
                disabled={disabled}
                onToggle={(next) => run(props.settings.setToggle(spec.field, next))}
              />
            ))}
          </Group>
          <Group title="提醒内容">
            {CONTENT_TOGGLES.map((spec) => (
              <ToggleRow
                key={spec.field}
                spec={spec}
                checked={view[spec.field]}
                disabled={disabled}
                onToggle={(next) => run(props.settings.setToggle(spec.field, next))}
              />
            ))}
          </Group>
          <Group title="Webhook 转发">
            <div className="nt-set-field">
              <label className="nt-set-label" htmlFor="nt-set-webhook-url">
                转发地址
              </label>
              <Input
                id="nt-set-webhook-url"
                // 非受控 + 值变了才重挂：写成功或清空后回显归位，用户敲字时不动它
                key={'url:' + view.webhookUrl}
                defaultValue={view.webhookUrl}
                placeholder="https://example.com/hook"
                spellCheck={false}
                disabled={disabled}
                onBlur={(event) => run(props.settings.commitUrl(event.target.value))}
              />
              <p className="nt-set-hint">POST 一条通知 JSON；留空表示不转发。</p>
            </div>
            <div className="nt-set-field">
              <label className="nt-set-label" htmlFor="nt-set-webhook-headers">
                附加请求头
              </label>
              {/* primitives 里没有多行输入（只有 Input / InlineEditor），这里用原生 textarea */}
              <textarea
                id="nt-set-webhook-headers"
                className="nt-set-textarea"
                key={'headers:' + formatHeaders(view.webhookHeaders)}
                defaultValue={formatHeaders(view.webhookHeaders)}
                rows={3}
                spellCheck={false}
                placeholder={'Authorization=Bearer …\nX-Env=dev'}
                disabled={disabled}
                onBlur={(event) => run(props.settings.commitHeaders(event.target.value))}
              />
              <p className="nt-set-hint">每行一条 key=value；# 开头的行忽略。清空即恢复默认。</p>
            </div>
          </Group>
        </React.Fragment>
      ) : (
        <p className="nt-set-note">
          {snapshot.status === 'loading'
            ? '正在读取设置…'
            : '这个插件当前没在运行，暂时没有可配置的设置。'}
        </p>
      )}
      {note === '' ? null : (
        <p className="nt-set-status" role="status">
          {note}
        </p>
      )}
    </div>
  )
}

function Group(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="nt-set-group">
      <h3 className="nt-set-group-title">{props.title}</h3>
      {props.children}
    </section>
  )
}

function ToggleRow(props: {
  spec: ToggleSpec
  checked: boolean
  disabled: boolean
  onToggle: (next: boolean) => void
}): React.ReactElement {
  return (
    <div className="nt-set-row">
      <div className="nt-set-row-main">
        <span className="nt-set-label">{props.spec.label}</span>
        <span className="nt-set-hint">{props.spec.hint}</span>
      </div>
      <Switch
        checked={props.checked}
        label={props.spec.label}
        disabled={props.disabled}
        onChange={props.onToggle}
      />
    </div>
  )
}

/**
 * 把设置页挂进 DSH 设置对话框。在 `apply` 里调一次。
 *
 * 用 `ctx.inject` 而不是静态 inject：拿不到 slots / configForms 的组合（headless、SDK）照常装，
 * 只是没有设置页 —— 这也是本插件一贯的做法（见 host 半对 webServer 的软依赖）。
 */
export function installSettingsSection(ctx: ClientContext): void {
  ctx.inject(['slots', 'configForms'], (scope) => {
    const slots = scope.get('slots') as SlotsService | undefined
    const configForms = scope.get('configForms') as ConfigFormsService | undefined
    if (slots === undefined || configForms === undefined) return
    const settings = new NotifySettingsModel(configForms.get<NotifySettingsView>(SETTINGS_NS))
    scope.effect(
      () =>
        configForms.whileServed([SETTINGS_NS], () =>
          slots.inject(SETTINGS_SECTION, () =>
            slots.register(
              {
                name: SETTINGS_SECTION,
                id: SETTINGS_NS,
                order: SETTINGS_ORDER,
                label: () => SETTINGS_LABEL,
                inject: () => ({ hooks: { notifySettings: settings }, settings }),
              },
              NotifySettingsSection,
            ),
          ),
        ),
      'dsh-notify: settings page',
    )
    scope.effect(() => registerSettingsNavIcon(() => SETTINGS_LABEL), 'dsh-notify: settings nav icon')
  })
}
