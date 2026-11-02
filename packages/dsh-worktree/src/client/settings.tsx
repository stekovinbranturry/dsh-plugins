// 设置页：把 worktree 的 6 个配置项做成 DSH 设置对话框里的一页（导航文案"Worktree"，
// 与侧边栏入口、README 里的叫法一致）。
//
// 为什么必须自己画页：本版 DSH（0.2.1-rc.2）没有任何客户端自动表单渲染器 —— `autoGenerate`
// 只出现在 wire schema 与宿主实现里，全安装 grep 不到消费它的渲染分支。宿主侧把 Config 的
// volatile 字段投影成表单之后，还得由插件自己在客户端注册一页来接。
//
// 座位是 `settings.section`（设置对话框左侧导航的一项）。两道门都得过：
//   - `ctx.configForms.whileServed(['dsh-worktree'])`：宿主真的在服务这个命名空间才注册；
//   - `ctx.slots.inject('settings.section', …)`：设置对话框声明了这个插槽才注册（直接 register
//     会撞 SlotOwnershipError）。
// 命名空间 = profile patch 条目的 id（`dsh-worktree`），不是包名（`@zhanghanxuan/dsh-worktree`）——
// 宿主侧 dsh-settings 的 `describe()` 用 `entry.options.id` 派生，写错这里就拿不到表单。
//
// 写值一律走 ConfigForm 的 set / unset：它内部串行排队、带 revision 围栏，被拒时返回 false
// 而不是抛 —— 所以 UI 只要把 false 翻成一句提示就行。清空文本框走 unset（回落 schema 默认值），
// 而不是写一个空串进去。
//
// 文案写死中文：插件其余文案本来就是中文，为一个设置页引入 locale 服务不值。
import * as React from 'react'
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

import type {
  ClientContext,
  ConfigForm,
  ConfigFormSnapshot,
  ConfigFormsService,
  SlotsService,
} from './types.js'
import { registerSettingsNavIcon } from './settings-nav-icon.js'

/** 设置命名空间：profile patch 条目的 id（见 cordis.patch.yml 的 `- id:`） */
export const SETTINGS_NS = 'dsh-worktree'
/** 座位：设置对话框左侧导航的一项 */
export const SETTINGS_SECTION = 'settings.section'
/** 官方已占用 order：account -10 / general 0 / models 10 / plugins 15 / agent-presets 20 */
export const SETTINGS_ORDER = 61
/** 设置对话框导航里的标题：插件永远叫 Worktree（侧边栏入口与 README 同名） */
export const SETTINGS_LABEL = 'Worktree'

/** 宿主 Config 的 6 个字段在浏览器侧的投影（volatile 引用盒子已被宿主解包成裸值） */
export interface WorktreeSettingsView {
  worktreeRoot: string
  titleTemplate: string
  sessionTitleTemplate: string
  handoffTemplate: string
  registerProject: boolean
  writeExclude: boolean
}

type SettingsSnapshot = ConfigFormSnapshot<WorktreeSettingsView>

type TextField = 'worktreeRoot' | 'titleTemplate' | 'sessionTitleTemplate' | 'handoffTemplate'
type ToggleField = 'registerProject' | 'writeExclude'

interface TextSpec {
  field: TextField
  label: string
  hint: string
  /** 模板类字段用多行框（primitives 没有多行输入，这里用原生 textarea） */
  multiline?: boolean
  placeholder?: string
}

interface ToggleSpec {
  field: ToggleField
  label: string
  hint: string
}

/** 路径与命名 */
export const PATH_TEXT_FIELDS: readonly TextSpec[] = [
  {
    field: 'worktreeRoot',
    label: 'worktree 根目录',
    hint: '相对仓库根；留空恢复默认',
    placeholder: '.worktrees',
  },
  {
    field: 'titleTemplate',
    label: '工作区名模板',
    hint: '可用 {compact} {spaced} {name} {repo}',
    multiline: true,
  },
  {
    field: 'sessionTitleTemplate',
    label: '会话名模板',
    hint: '默认 {spaced}（连字符换空格）',
    multiline: true,
  },
]

/** 交接消息 */
export const HANDOFF_TEXT_FIELDS: readonly TextSpec[] = [
  {
    field: 'handoffTemplate',
    label: '交接消息模板',
    hint: '可用 {name} {branch} {path} {repo} {task}；留空 = 新会话一条消息都不发',
    multiline: true,
  },
]

/** 项目登记 */
export const REGISTER_TOGGLES: readonly ToggleSpec[] = [
  {
    field: 'registerProject',
    label: '注册成独立项目',
    hint: '把 worktree 目录注册成独立项目，左侧栏按项目分组',
  },
  {
    field: 'writeExclude',
    label: '写 .git/info/exclude',
    hint: '把 worktree 根目录写进共享的 .git/info/exclude，避免出现在 git status 里',
  },
]

/** 这一页覆盖的字段。测试拿它跟宿主 Config 的字段表对账 —— 加了配置项忘了上页会当场红。 */
export const SETTINGS_FIELDS: readonly (keyof WorktreeSettingsView)[] = [
  ...PATH_TEXT_FIELDS.map((spec) => spec.field),
  ...HANDOFF_TEXT_FIELDS.map((spec) => spec.field),
  ...REGISTER_TOGGLES.map((spec) => spec.field),
]

/**
 * 设置页的表单模型：包一层 ConfigForm，把"用户动作"翻成"写哪个字段"。
 *
 * 做成不含 React 的普通对象有两个用处：它自带 `getSnapshot`/`subscribe`，正好当渲染器的
 * hooks 源（`hooks: { worktreeSettings: model }` → 组件拿到 `useWorktreeSettings`）；测试里也能
 * 直接断言"拨一下开关 / 失焦一次到底写了哪个字段"，不用真跑 React。
 */
export class WorktreeSettingsModel {
  constructor(private readonly form: ConfigForm<WorktreeSettingsView>) {}

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

  /** 失焦提交一个文本框；没变返回 undefined（不写），清空走 unset（回落默认值） */
  commitText(field: TextField, text: string): Promise<boolean> | undefined {
    const next = text.trim()
    if (next === (this.snapshotValue()?.[field] ?? '')) return undefined
    return next === '' ? this.form.unset(field) : this.form.set(field, next)
  }

  private snapshotValue(): WorktreeSettingsView | undefined {
    return this.form.getSnapshot().value
  }
}

/**
 * 设置页的 props。渲染器会把 inject 面里的 `hooks.worktreeSettings` 按
 * `use` + 首字母大写变成 `useWorktreeSettings`（`standardHookPropName`），其余键原样传进来。
 *
 * 两个都可能是 undefined（宿主版本不对、加载顺序不对），所以整页按"拿不到就不渲染表单"处理。
 */
export interface WorktreeSettingsProps {
  useWorktreeSettings?: (
    select: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  ) => SettingsSnapshot
  settings?: WorktreeSettingsModel
}

export function WorktreeSettingsSection(props: WorktreeSettingsProps): React.ReactElement {
  const hook = props.useWorktreeSettings
  const settings = props.settings
  if (hook === undefined || settings === undefined) {
    return (
      <p className="wt-set-note">设置页没拿到平台表单（宿主版本或加载顺序不对），重开设置面板试试。</p>
    )
  }
  return <WorktreeSettingsForm useSettings={hook} settings={settings} />
}

interface WorktreeSettingsFormProps {
  useSettings: NonNullable<WorktreeSettingsProps['useWorktreeSettings']>
  settings: WorktreeSettingsModel
}

function WorktreeSettingsForm(props: WorktreeSettingsFormProps): React.ReactElement {
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
  const textField = (spec: TextSpec): React.ReactElement => (
    <TextField
      key={spec.field}
      spec={spec}
      value={view === undefined ? '' : view[spec.field]}
      disabled={disabled}
      onCommit={(text) => run(props.settings.commitText(spec.field, text))}
    />
  )

  return (
    <div className="wt-set">
      <p className="wt-set-intro">新建 worktree 放在哪、叫什么、开成什么项目。</p>
      {ready ? (
        <React.Fragment>
          {snapshot.writable ? null : (
            <p className="wt-set-note">当前部署把插件设置存成只读，改不了。</p>
          )}
          <Group title="路径与命名">{PATH_TEXT_FIELDS.map(textField)}</Group>
          <Group title="交接消息">{HANDOFF_TEXT_FIELDS.map(textField)}</Group>
          <Group title="项目登记">
            {REGISTER_TOGGLES.map((spec) => (
              <ToggleRow
                key={spec.field}
                spec={spec}
                checked={view[spec.field]}
                disabled={disabled}
                onToggle={(next) => run(props.settings.setToggle(spec.field, next))}
              />
            ))}
          </Group>
        </React.Fragment>
      ) : (
        <p className="wt-set-note">
          {snapshot.status === 'loading'
            ? '正在读取设置…'
            : '这个插件当前没在运行，暂时没有可配置的设置。'}
        </p>
      )}
      {note === '' ? null : (
        <p className="wt-set-status" role="status">
          {note}
        </p>
      )}
    </div>
  )
}

function TextField(props: {
  spec: TextSpec
  value: string
  disabled: boolean
  onCommit: (text: string) => void
}): React.ReactElement {
  const id = 'wt-set-' + props.spec.field
  // 非受控 + 值变了才重挂：写成功或清空后回显归位，用户敲字时不动它
  const remountKey = props.spec.field + ':' + props.value
  return (
    <div className="wt-set-field">
      <label className="wt-set-label" htmlFor={id}>
        {props.spec.label}
      </label>
      {props.spec.multiline === true ? (
        <textarea
          id={id}
          className="wt-set-textarea"
          key={remountKey}
          defaultValue={props.value}
          rows={3}
          spellCheck={false}
          placeholder={props.spec.placeholder}
          disabled={props.disabled}
          onBlur={(event) => props.onCommit(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          key={remountKey}
          defaultValue={props.value}
          spellCheck={false}
          placeholder={props.spec.placeholder}
          disabled={props.disabled}
          onBlur={(event) => props.onCommit(event.target.value)}
        />
      )}
      <p className="wt-set-hint">{props.spec.hint}</p>
    </div>
  )
}

function Group(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="wt-set-group">
      <h3 className="wt-set-group-title">{props.title}</h3>
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
    <div className="wt-set-row">
      <div className="wt-set-row-main">
        <span className="wt-set-label">{props.spec.label}</span>
        <span className="wt-set-hint">{props.spec.hint}</span>
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
 * 只是没有设置页 —— 这也是本插件一贯的做法（见 index.tsx 对 uiWorkspace 的软依赖）。
 */
export function installSettingsSection(ctx: ClientContext): void {
  ctx.inject(['slots', 'configForms'], (scope) => {
    const slots = scope.get('slots') as SlotsService | undefined
    const configForms = scope.get('configForms') as ConfigFormsService | undefined
    if (slots === undefined || configForms === undefined) return
    const settings = new WorktreeSettingsModel(configForms.get<WorktreeSettingsView>(SETTINGS_NS))
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
                inject: () => ({ hooks: { worktreeSettings: settings }, settings }),
              },
              WorktreeSettingsSection,
            ),
          ),
        ),
      'dsh-worktree: settings page',
    )
    // 导航图标：settings.section 契约里没有 icon 字段（见 settings-nav-icon.ts 的说明），
    // 只能在对话框挂载后认领自己那一行、用 CSS 换成插件自己的图标。
    scope.effect(() => registerSettingsNavIcon(() => SETTINGS_LABEL), 'dsh-worktree: settings nav icon')
  })
}
