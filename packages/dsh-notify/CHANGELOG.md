# @zhanghanxuan/dsh-notify

## 0.2.1

### Patch Changes

- 新增通知设置面板，渠道开关保存后实时同步到已打开页面，无需刷新；通知设置导航使用铃铛图标，优化通知点击与当前会话提醒行为。精简安装使用文档，补充真实设置截图及市场截图清单。

## 0.2.0

### Minor Changes

- 5497f7a: 包名挪到 `@zhanghanxuan` scope 下。npm 上的 `dsh-notify`（Pasumao/dsh-plugin-notify）与 `dsh-worktree`（FlashingChen/dsh-worktree）已被他人占用，非 scope 名发不出去。
  
  插件的运行时身份一律不变：cordis 插件名、`/api/dsh-notify.*` / `/api/dsh-worktree.*`、`/dsh-notify/stream`、`sidebar.footer.action` 插槽注册名、四个 `worktree_*` 工具名都保持原样，只有包名与安装命令变了。
