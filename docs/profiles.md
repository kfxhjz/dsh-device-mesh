# DSH profiles

[简体中文](zh/profiles.zh.md) | English

`dsh-device-mesh` is a **DSH bundle**: it is installed into one DSH **profile**.
`--profile <name>` is required by `dsh plugin` because the same machine can hold
several independent profiles, and a bundle installed into one profile is
invisible to the others.

## What a profile is

A profile is a named, ordered stack of plugin-bundle patch layers under
`$DSH_HOME/profiles/<name>/` (`~/.dsh/profiles` by default). It owns:

- `package.json` — out-of-tree dependencies and `dsh.profile.bundles`, the
  ordered list of bundles applied at startup;
- `cordis.patch.yml` — your own layer, applied after every bundle layer;
- `node_modules/` — packages installed for this profile.

At startup DSH applies each bundle patch in list order, then the profile's own
patch, then the home-level patch, then `--patch` overlays. Later layers win per
row. Installing a bundle appends it to `dsh.profile.bundles`; removing it removes
both the dependency and the layer.

## Which profile do I install into?

| You start | Install into |
|---|---|
| DSH Desktop app | `desktop` |
| `dsh web` | `web` |
| `dsh headless` | `headless` |
| `dsh tui` | `tui` |
| `dsh sdk` / `dsh --profile acp` | `sdk` / `acp` |
| `dsh --profile <name>` (custom) | `<name>` |

The Desktop app uses its own `desktop` profile (managed by the app); the CLI
`dsh web` uses `web`. A custom profile can be created or reset from a shipped
template:

```sh
dsh --from-default-profile web --profile edge --dump-config
```

## Install examples

```sh
# DSH Desktop
dsh plugin --profile desktop add dsh-device-mesh

# Headless server running `dsh web`
dsh plugin --profile web add dsh-device-mesh

# A custom profile
dsh plugin --profile edge add dsh-device-mesh

# Prebuilt tarball instead of npm
dsh plugin --profile desktop add ./dsh-device-mesh-0.1.2.tgz
```

`dsh plugin` forwards everything after the profile flag to pnpm in the profile
directory, so `add`, `remove`, `why`, `list` and the other pnpm verbs work. The
first use initializes the profile with `@deepseek-ai/dsh-base`.

## Inspect and remove

```sh
# Installed packages in the profile
dsh plugin --profile desktop list --depth 0

# Composed patch layers, including the "# == dsh-device-mesh" layer
dsh --profile desktop --dump-config

# Remove the bundle and its layer
dsh plugin --profile desktop remove dsh-device-mesh
```

Never edit `$DSH_HOME/profiles/<name>/package.json` by hand for installs; use
`dsh plugin` so the bundle list and pnpm lockfile stay consistent. Device
identity and pairings live in `$DSH_HOME/device-mesh/`, not in the profile, so
removing/reinstalling the bundle preserves them.
