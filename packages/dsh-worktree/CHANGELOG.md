# @zhanghanxuan/dsh-worktree

## 0.2.0

### Minor Changes

- 5497f7a: 包名挪到 `@zhanghanxuan` scope 下。npm 上的 `dsh-notify`（Pasumao/dsh-plugin-notify）与 `dsh-worktree`（FlashingChen/dsh-worktree）已被他人占用，非 scope 名发不出去。
  
  插件的运行时身份一律不变：cordis 插件名、`/api/dsh-notify.*` / `/api/dsh-worktree.*`、`/dsh-notify/stream`、`sidebar.footer.action` 插槽注册名、四个 `worktree_*` 工具名都保持原样，只有包名与安装命令变了。
