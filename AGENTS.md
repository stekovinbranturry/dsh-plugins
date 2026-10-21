# 仓库规则

## README 约束

这两个插件要开源、要上 DSH market，README 就是它们的**产品页** —— 访客从市场点进来，先读 README
再决定装不装。所以按推广口径写：**能卖，但不注水**。

**首屏三件事**，顺序固定，不许被别的章节挤下去：

1. **一句话定位** —— 它替用户解决什么问题（不是功能复述）
2. **主截图** —— 一张最能说明价值的真机截图
3. **安装** —— 最短可用路径，复制粘贴就能装上

**允许写**：功能亮点（短句罗列，不写散文）、使用场景、配置项明细、卸载、本地开发、更多截图。

**仍然不写**：架构说明、分段与插槽细节、决策记录、测试分层与断言数、踩坑日记、更新日志、
"怎么加一个新插件"这类贡献者流程（要写就放 `CONTRIBUTING.md`）。这些进代码注释或 commit message。

- **根 README 是货架**：一句定位 + 一张表（包名 / 一句话作用 / 依赖 / 截图缩略图），每行链到
  各插件的 README，不重复细节
- **截图必须真机跑出来**（隔离实例 + 真浏览器 + 按元素裁剪），不要手绘示意图、不要贴假数据。
  放 `packages/<pkg>/docs/`，README 里用 `![说明](docs/xxx.png)` 引用
- **保持短**：首屏一屏读完。功能亮点宁可少写两条，也不要为了"完整"往回堆

## 上市场要的元数据

市场索引（format 1，`@deepseek-ai/dsh-plugin-market-index`）按包名 + 版本列出可装项。发版前逐项确认：

| 索引字段 | 来源 | 注意 |
|---|---|---|
| `name` | `package.json` `name` | 市场内唯一 |
| `title` / `description` | 索引条目；`description` 惯例同 `package.json` | 支持本地化文本 |
| `icon` | 索引条目 | base64 `data:` URL 或绝对 URL；索引不给就没有图标 |
| `author` / `homepage` | `package.json` | 展示用 |
| `repository{url,directory}` | `package.json` `repository` | `directory` 是包在仓里的相对路径，monorepo 必填 |
| `metadata.keywords` | 惯例取 `package.json` `keywords` | 免费字符串，搜索靠它 |
| `metadata.category` / `labels` | 索引条目 | id 必须在索引里声明过，不能自造 |
| `versions[].source` | `npm`，或 `git` + 40 位 commit | 从哪装 |
| `versions[].engines.dsh` | `package.json` `engines.dsh` | **省略 = 任意 DSH 版本**；一旦声明就**只按它裁决**，`peerDependencies` 里的 dsh 包被完全忽略 |

- 要走 npm 源的包不能 `private: true`；走 git 源则不必发布，但市场条目要钉 40 位 commit
- `engines.dsh` 是给宿主看的运行时门槛（如 `^0.2.1-rc.2`），与 npm 的 `engines.node` 不是一回事

## 复用 DSH 公共能力：先找，再写

改插件代码前先找一遍公共能力：**能 import 就 import → 能问 ctx 服务就问服务 → 都没有才自研**，并在
注释里写清上游为什么满足不了。找法：`grep -rn "@deepseek-ai/dsh-" packages/*/src` 看现有依赖面，再按
同义词去 `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*/lib/types/*.d.ts` 翻真契约。
"官方也手写"不构成理由：抄的每一行都是将来要跟着上游改的一行。

### 宿主半

- **对外接口挂 `/api` 承运通道**，端点地址两端共用一份 `apiPath()`：
  `ctx.connection.fetch.register({ path: apiPath(method), methods: ['POST'], requestBody: 'buffered', fetch })`。
  围栏与浏览器鉴权（401/403）由承运层在 dispatch 之前做完，浏览器半同源 `fetch(apiPath(method))` 调它
  —— 官方 `present.open` 就是这个形状。
- **自留 webServer 路由时**（只有 SSE 长连这类拿不住响应的场景才需要），围栏取
  `ctx.connection.requestRejection({ headers: req.headers })` 的 401/403 裁定；`ctx.webServer.register` 本身
  不含鉴权，拿不到 `connection` 就不服务。
- **平台探测与业务目录问服务**：打开/定位 `ctx.sessionController.openWorkspacePath({ path, action? })`、桌面
  形态 `workspaceDesktop().fileManager`、文件 `ctx.fs` / `ctx.workspaceFiles`、
  会话 `ctx.sessions` / `ctx.sessionQuery`、持久化 `ctx.storageDomain`。目录扫描 + frontmatter + rank 表是
  `dsh-skill-filesystem` 的实现，`process.platform` 只是猜。
- **读技能要么给全 `{ cwd, scope }`，要么走官方会话技能目录**：注册表的 `list({ cwd })` 不给 `scope` 就
  **只读全局层**（`scope` 是调用方 agent / 预设的层级选择器），项目层与预设层全会漏掉 —— 面板上表现
  就是"0 个"。两种正确姿势：① 官方 `@deepseek-ai/dsh-api-session-controller` 的 `SessionSkillCatalog`
  （宿主服务 `sessionSkillCatalog`，浏览器侧命名空间 `ctx.remote.skills`），收 `{ sessionId }`，自己解析
  cwd 与 scope，代价是只回 `name / description / whenToUse / modelInvocable`，**没有 `source`**；
  ② 要按来源分组就只能自己解析后读注册表，照它那套解析抄：`agents.get(sessionId)` 活的 Agent 直接当
  scope，预设有自己的注册表就用 `agentPresets.serviceFor(live, 'skills')`，冷会话再从
  `sessionQuery.observeSession` 的投影拿 `agentPreset`、退到 `standingKeyFor`（observation 是 Disposable，
  用完要释放）。缓存键也得带上会话 —— 同一个 cwd 下不同预设的目录不一样。
- **依赖挑有 `dsh` manifest 的公共包**（如 `dsh-tools`）：进 `peerDependencies`，类型再进 `devDependencies`；
  其余服务走 `inject` / `ctx.get()` + 本地最小类型垫层。无 manifest 的宿主内部 lib（如
  `dsh-native-command`）和别人的 `lib/` 内部路径都不是公共契约。
- **静态 `inject` 只放"没有它插件就没意义"的服务**，其余用 `ctx.inject([...], scope)` 或 `ctx.get()` 降级，
  headless / SDK 组合照样能装。

### 浏览器半

- **公共模块只从平台种子表取**（tsdown `neverBundle`，不装包）：`react`、`react/jsx-runtime`、`react-dom`、
  `react-dom/client`、`@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、
  `dsh-client-ui-primitives`、`dsh-client-ui-dockkit`。
- **组件 / 图标 / 纯函数取 `@deepseek-ai/dsh-client-ui-primitives`**：`Button` `Pill` `Tag` `Input` `Switch`
  `DisclosureRow` `Modal` `HoverCard` `Tooltip` `StateDot` `Toast` `FileTypeIcon` `Icon*` `fileExtension`
  `classifyFileType` `fileSizeText` `writeClipboard` `rankByName` `useAnchoredPosition` …。它不在 npm 上：
  用到哪几个就在 `src/client/primitives.d.ts` 补垫层声明。
- **跨插件依赖在 `dsh.client.inject` 里声明**（如 `@deepseek-ai/dsh-client-ui-sidebar`、
  `@deepseek-ai/dsh-api-workspace-controller`）。
- **属性访问要求 inject，`get()` 不要求**：`ctx.remote.skills` 这种属性访问要该服务在**自己的** inject 里，
  点号路径也得单独列（官方 `dsh-client-ui-skill` 同时列了 `"remote"` 与 `"remote.skills"`；清单里的
  `dsh.client.inject` 只是包级依赖，管加载顺序）。拿到**别人的** ctx（侧边栏交给面板的 `props.ctx`）只能
  `ctx.get(name)`，否则报 `cannot get property "remote.skills" without inject`，报错里挂的还是对方的插件名。
  要属性访问就用自己的 ctx —— 包装 component 时把 `apply(ctx)` 那份一起塞进 props。
- **文件地址取 `@deepseek-ai/dsh-util-workspace-path`**（浏览器安全）：`fileAddressFor` `sessionFileAddress`
  `parseFileAddress` `relativizeToCwd` …
