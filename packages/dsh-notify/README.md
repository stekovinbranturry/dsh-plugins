# dsh-notify

## 安装

需要 Node.js 24+、pnpm 11.25.0 和已安装的 DSH Web。以下命令从仓库根目录运行：

```bash
git clone https://github.com/stekovinbranturry/dsh-plugins.git
cd dsh-plugins
pnpm install --frozen-lockfile
pnpm --filter dsh-notify run build
pnpm --filter dsh-notify run install:profile
```

这是本地 link 安装，请保留仓库目录。**安装后必须重启 DSH，并刷新页面。**
浏览器系统通知需要在浏览器中允许通知权限。
卸载：`pnpm --filter dsh-notify run uninstall:profile`。

## 本地开发

```bash
pnpm --filter dsh-notify run build
pnpm --filter dsh-notify run dev:client
pnpm --filter dsh-notify run dev:host
pnpm --filter dsh-notify run test
```

客户端改动在构建完成后刷新页面生效；宿主改动需要重启 DSH，再刷新页面。
