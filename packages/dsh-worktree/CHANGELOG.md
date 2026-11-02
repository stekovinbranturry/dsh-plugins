# @zhanghanxuan/dsh-worktree

## 0.2.1

### Patch Changes

- 新增 Worktree 设置面板，支持保存配置。新建 worktree 分支默认从本地 main 创建，保留手动选择起点；缺少 main 时明确报错，不再默认使用当前分支。精简安装使用文档，补充真实设置截图及市场截图清单。

## 0.2.0

### Minor Changes

- 5497f7a: 包名挪到 `@zhanghanxuan` scope 下。npm 上的 `dsh-notify`（Pasumao/dsh-plugin-notify）与 `dsh-worktree`（FlashingChen/dsh-worktree）已被他人占用，非 scope 名发不出去。
  
  插件的运行时身份一律不变：cordis 插件名、`/api/dsh-notify.*` / `/api/dsh-worktree.*`、`/dsh-notify/stream`、`sidebar.footer.action` 插槽注册名、四个 `worktree_*` 工具名都保持原样，只有包名与安装命令变了。
