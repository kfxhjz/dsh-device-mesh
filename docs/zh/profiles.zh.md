# DSH profile

[English](../profiles.md) | 简体中文

`dsh-device-mesh` 是一个 **DSH bundle**，需要安装到某个 DSH **profile** 中。
`dsh plugin` 要求 `--profile <name>`，因为同一台机器可以有多套互相独立的 profile，
装进一个 profile 的 bundle 不会出现在另一个 profile 中。

## profile 是什么

profile 是 `$DSH_HOME/profiles/<name>/`（默认 `~/.dsh/profiles`）下按顺序叠加插件
bundle patch 层的具名环境，包含：

- `package.json` — 树外依赖与 `dsh.profile.bundles`（启动时按顺序应用）；
- `cordis.patch.yml` — 你自己的层，在所有 bundle 层之后应用；
- `node_modules/` — 这个 profile 安装的包。

启动时 DSH 依次应用 bundle patch、profile 自己的 patch、home 级 patch、`--patch`
overlay；后应用的层按行胜出。安装 bundle 会把它追加到 `dsh.profile.bundles`；移除时
依赖与该层一起删除。

## 应该装进哪个 profile

| 你的启动方式 | 安装到 |
|---|---|
| DSH Desktop 桌面版 | `desktop` |
| `dsh web` | `web` |
| `dsh headless` | `headless` |
| `dsh tui` | `tui` |
| `dsh sdk` / `dsh --profile acp` | `sdk` / `acp` |
| `dsh --profile <name>`（自定义） | `<name>` |

桌面版使用它自己的 `desktop` profile（由应用管理）；CLI 的 `dsh web` 使用 `web`。
自定义 profile 可以用随附模板创建或重置：

```sh
dsh --from-default-profile web --profile edge --dump-config
```

## 安装示例

```sh
# DSH Desktop 桌面版
dsh plugin --profile desktop add dsh-device-mesh

# 运行 `dsh web` 的无头服务器
dsh plugin --profile web add dsh-device-mesh

# 自定义 profile
dsh plugin --profile edge add dsh-device-mesh

# 从预构建 tarball 安装（代替 npm）
dsh plugin --profile desktop add ./dsh-device-mesh-0.1.2.tgz
```

`dsh plugin` 把 profile 参数之后的全部参数转发给 profile 目录里的 pnpm，因此
`add`、`remove`、`why`、`list` 等 pnpm 子命令都可用；首次使用会以
`@deepseek-ai/dsh-base` 初始化 profile。

## 检查与移除

```sh
# profile 中已安装的包
dsh plugin --profile desktop list --depth 0

# 组合后的 patch 层（包含 "# == dsh-device-mesh" 层）
dsh --profile desktop --dump-config

# 移除 bundle 及其层
dsh plugin --profile desktop remove dsh-device-mesh
```

不要手工编辑 `$DSH_HOME/profiles/<name>/package.json` 来安装插件；请使用
`dsh plugin`，以保证 bundle 列表与 pnpm lockfile 一致。设备身份与配对数据在
`$DSH_HOME/device-mesh/`，不在 profile 里，所以移除/重装 bundle 不会丢失配对。
