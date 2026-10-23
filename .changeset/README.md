# Changesets

这个目录是 [Changesets](https://github.com/changesets/changesets) 的工作区，`.github/workflows/release.yml` 靠它自动发版。

## 改完一个插件，怎么发出去

1. 跑 `pnpm changeset`，选要发的包和版本级别（patch / minor / major），写一句人话的变更说明 —— 会在 `.changeset/` 下生成一个 md 文件，**跟代码一起提交**。
2. PR 合进 `main` 后，`release.yml` 自动开一个标题是 "Version Packages" 的 PR：里面是版本号提升 + 各包 `CHANGELOG.md` 的汇总。
3. 合掉那个 PR，同一条 workflow 就会构建并发版到 npm，并给每个包打 `vX.Y.Z` 的 tag。

没有新的 changeset 文件时，`main` 上的推送不会发版。

## 首次发版

`@stekovinbranturry/dsh-notify` 与 `@stekovinbranturry/dsh-worktree` 在 npm 上还不存在，需要仓库 secret `NPM_TOKEN`（npm Automation token，账号要拥有 `@stekovinbranturry` 这个 scope）。

仓库里已经放好一个 changeset（`rename-packages-to-scope.md`），所以第一次跑的顺序是：推 `main` → 自动开 "Version Packages" PR（0.1.0 → 0.2.0）→ 合掉它才真正发版。**没配 `NPM_TOKEN` 时第 3 步会失败，不会发出任何东西。**
