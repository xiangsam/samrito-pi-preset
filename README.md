# samrito-pi-preset

A portable [pi](https://pi.dev) package that bundles this machine's extension
collection (including the `pi-cliproxyapi-provider` provider) under a single
`pi install`-able package.

Install it from npm in one command:

```bash
pi install npm:samrito-pi-preset
```

The plugins are packed into the tarball (`bundledDependencies`), so nothing is
fetched from the registry at load time and no setup step is required. See
[Publish and install from npm](#publish-and-install-from-npm).

Config templates (appearance, tool rendering) are shipped but never written
behind your back — apply them with one slash command after the first restart:

```
/preset
```

See [Applying the config templates](#applying-the-config-templates).

If you prefer a local checkout:

```bash
node scripts/setup.mjs     # install plugins, write configs
node scripts/verify.mjs    # confirm pi can load everything
pi install "$PWD"          # register with pi
```

> **Migrating an existing machine:** if `settings.json` already lists these
> plugins as individual `npm:` packages, run `setup.mjs --migrate-settings`.
> Leaving both configured makes pi abort startup with tool-conflict errors.

## What's inside

| Resource | Source | Notes |
| --- | --- | --- |
| Extensions | 9 npm plugins + `/preset`, 11 entry files | see [Bundled plugins](#bundled-plugins) |
| `config/zentui.json` | `~/.pi/agent/zentui.json` | pi-zentui appearance |
| `config/pi-tool-display.config.json` | `~/.pi/agent/extensions/pi-tool-display/config.json` | tool rendering |

Personal skills under `~/.agents/skills/` are **not** bundled — keep those
managed separately, or copy the directory to the target machine.

### Bundled plugins

| Plugin | Version | Extension files |
| --- | --- | --- |
| `@gotgenes/pi-subagents` | ^21.6.0 | `src/index.ts` |
| `@juicesharp/rpiv-ask-user-question` | ^2.9.0 | `index.ts` |
| `@juicesharp/rpiv-todo` | ^2.9.0 | `index.ts` |
| `@narumitw/pi-btw` | ^0.58.1 | `dist/index.ts` |
| `pi-background-tasks` | ^2.5.0 | `extensions/*.ts` (2) |
| `pi-cliproxyapi-provider` | ^0.15.30 | `extensions/index.ts` |
| `pi-goal-x` | ^0.31.2 | `extensions/goal.ts` |
| `pi-tool-display` | ^0.5.0 | `index.ts` |
| `pi-zentui` | ^0.23.0 | `extensions/zentui/index.ts` |

All packages here are bundled into the published tarball, so the target machine
needs no registry access to load them (see [How it works](#how-it-works)).

`extensions/preset.ts` is this package's **own** extension. It ships the
`/preset` command described below and registers no tools, so it never conflicts
with the plugins it bundles.

## Applying the config templates

`config/*.json` are files that *other* extensions read from the pi agent dir at
startup. They cannot travel in the package itself, so the bundled `/preset`
command copies them on request:

```
/preset                 show status, then ask which configs to apply
/preset status          show status only
/preset apply           write configs that are missing (never overwrites)
/preset apply --force   write all configs, backing up what exists
/preset help            this message
```

Bare `/preset` summarises each template (`missing` / `up to date` / `differs`)
and offers a choice; `apply` never touches a file you edited, and `--force`
keeps a `.bak` next to whatever it replaces. Until a template is applied, a
one-line `/preset` hint is shown at session start (silence it with
`SAMRITO_PRESET_QUIET=1`).

Scripted and CI use is still supported:

```bash
node ~/.pi/agent/npm/node_modules/samrito-pi-preset/scripts/setup.mjs \
  --skip-install --force-config
```

### Why not a `postinstall` script?

Because it does not work, and cannot ask:

1. **npm blocks it.** npm ≥ 11.19 skips dependency lifecycle scripts unless the
   package is listed in `allowScripts`. pi installs packages into
   `~/.pi/agent/npm`, which has its own `package.json`, so that policy applies
   and a `postinstall` hook is skipped with only a warning.
2. **pi's install is not a TTY.** Even when the hook runs, `npm install` is
   spawned non-interactively, so it cannot offer a "copy or not?" choice.
3. **Re-running is a feature.** `/preset` can be invoked any time — after an
   upgrade, on a fresh machine, or to diff before overwriting — while a hook
   fires once, at an unpredictable moment, on every `npm update`.

## Publish and install from npm

The package is a normal, publishable npm package (`private` is not set), and
`bundledDependencies` makes npm pack every plugin into the tarball. Publish
once, then install anywhere with `pi install npm:samrito-pi-preset`.

```bash
npm login                 # once per machine
node scripts/verify.mjs   # optional but recommended before publishing
npm publish               # runs prepack -> sync-manifest --check
```

On the target machine:

```bash
pi install npm:samrito-pi-preset
pi list
# restart pi
```

This installs to `~/.pi/agent/npm/node_modules/samrito-pi-preset`, where the
bundled `node_modules/` keeps every `pi.extensions` path resolvable.

> **Why `bundledDependencies` is required.** pi resolves each `pi.extensions`
> entry *relative to the package root*, and its manifest format has no support
> for hoisted (sibling) installs. When pi runs `npm install` for an `npm:`
> source, npm hoists plain `dependencies` next to the package, so paths like
> `node_modules/pi-zentui/...` would not exist under the package root. Bundling
> them inside the tarball is the layout pi's docs prescribe.

`prepack` runs `sync-manifest.mjs --check`, so a stale `pi.extensions` fails the
publish instead of shipping.

After the first restart, run `/preset` to apply the shipped config templates —
they are deliberately not written automatically.

## Recommended rollout (this machine)

This bundle and the existing per-plugin `npm:` entries both provide the same
extensions. Having both configured is fatal, so migrate in one step:

```bash
cd samrito-pi-preset
node scripts/setup.mjs --migrate-settings   # keeps settings.json.bak
node scripts/verify.mjs                    # must print OK
# restart pi
```

`--migrate-settings` removes only the bundled plugin entries; your theme,
provider defaults, and other settings are preserved.

## Install from a local copy

```bash
# 1. copy this directory over (rsync/scp/git/tarball), then:
cd samrito-pi-preset
node scripts/setup.mjs
node scripts/verify.mjs

# 2. register with pi and restart
pi install "$PWD"
pi list
```

`setup.mjs` installs dependencies, regenerates the manifest, copies config
templates it does not find, and **fails** if `settings.json` still lists any
bundled plugin (see below). Add `--migrate-settings` to have it clean those up.

### From a tarball

```bash
bash scripts/pack.sh                 # -> samrito-pi-preset-1.0.0.tar.gz
bash scripts/pack.sh --with-deps     # include node_modules (offline install)

# on the target machine
tar -xzf samrito-pi-preset-1.0.0.tar.gz
cd samrito-pi-preset && node scripts/setup.mjs
pi install "$PWD"
```

A tarball path is **not** a valid `pi install` source — pi treats a local path
that is a file as a single extension. Always extract first.

## How it works

`package.json` declares the plugins as regular npm `dependencies`, then lists
their entry files under `pi.extensions`:

```json
"pi": {
  "extensions": [
    "node_modules/pi-zentui/extensions/zentui/index.ts"
  ]
}
```

Two pi behaviours shape this design:

1. **Local-path packages are not installed.** pi runs `npm install` for `npm:`
   and `git:` sources, but a local directory is registered as-is
   (`package-manager.js` → `install()` returns early). Hence the explicit
   `setup.mjs` install step; `pi install` alone would leave `node_modules` empty.

2. **The loader imports each entry path directly.** A directory entry fails with
   `Cannot find module`. This matters because some plugins declare a *directory*
   in their own manifest — `pi-zentui` declares `["./extensions"]` — and pi
   passes that through verbatim. So entries must be concrete files.

That second point is why `pi.extensions` is generated rather than hand-written:
`scripts/sync-manifest.mjs` expands each plugin through pi's own resolution rules
and writes the resulting files. It also lists this package's own
`extensions/*.ts`: declaring `pi.extensions` disables pi's convention-directory
discovery, so the bundled `/preset` extension would otherwise never load.
`setup.mjs` runs the sync automatically, so run `setup.mjs` after any version
bump (`npm run sync` does it standalone). `verify.mjs` fails when the manifest
drifts from the installed tree.

`dependencies` and `bundledDependencies` list the same plugins. The former is
what `setup.mjs` installs into the checkout's `node_modules`; the latter makes
`npm pack`/`npm publish` embed that same tree into the tarball, so an
`npm:samrito-pi-preset` install carries every entry file inside the package root
and needs no registry access at load time. When the two lists drift,
`node scripts/setup.mjs`/`npm run sync` regenerates `pi.extensions` from the
installed tree.

## Updating

```bash
npm update                       # or: npm install <plugin>@latest
node scripts/setup.mjs           # regenerates pi.extensions, re-verifies
node scripts/verify.mjs
# restart pi
```

To move to a new pinned version, edit `dependencies` in `package.json` and
re-run `setup.mjs`.

### Adding or removing a plugin

1. Edit `dependencies` **and** `bundledDependencies` in `package.json` (keep
   both in sync so npm-installed copies still resolve).
2. If it should be skipped, add it to `EXCLUDED_PACKAGES` in
   `scripts/pi-package-lib.mjs` (currently empty).
3. Run `npm install && node scripts/setup.mjs` — `pi.extensions` is regenerated
   automatically.
4. `node scripts/verify.mjs` to confirm it loads,
   `npm pack --dry-run` to confirm the plugin lands in the tarball.

## Scripts

| Script | Purpose |
| --- | --- |
| `extensions/preset.ts` | the bundled `/preset` command (apply config templates) |
| `scripts/setup.mjs` | install deps, regenerate manifest, copy configs, report conflicts |
| `scripts/verify.mjs` | 4-stage check: manifest, pi resolution, real loading, startup conflicts |
| `scripts/sync-manifest.mjs` | regenerate `pi.extensions` (`--check` for drift) |
| `scripts/pack.sh` | build a tarball (`--with-deps` to include `node_modules`) |
| `scripts/pi-package-lib.mjs` | shared helpers mirroring pi's resolution rules |

### `verify.mjs`

| Stage | Checks |
| --- | --- |
| 1. Manifest | entries exist, are files not directories, no excluded plugin declared, no drift |
| 2. Resolution | pi's `DefaultPackageManager` resolves the bundle in a throwaway agent dir |
| 3. Loading | pi's `loadExtensions()` imports every entry — the exact startup code path |
| 4. Startup conflicts | bundled plugins still listed in `settings.json` (fatal — see below) |

Stage 3 deliberately uses `loadExtensions` rather than `discoverAndLoadExtensions`:
the latter silently expands directory paths and would hide the
`Cannot find module` failure described above.

### Why duplicate entries are fatal

A plugin configured **both** in `settings.json` and via this bundle resolves
twice, and pi then rejects every duplicate extension:

```
Error: Failed to load extension ".../samrito-pi-preset/node_modules/@gotgenes/pi-subagents/src/index.ts":
  Tool "subagent" conflicts with .../agent/npm/node_modules/@gotgenes/pi-subagents/src/index.ts
```

Startup aborts with a non-zero exit status. `setup.mjs` and `verify.mjs` both
report this as an error; pass `--migrate-settings` to have `setup.mjs` remove
the stale entries (keeping a `.bak`).

## Options

```
node scripts/setup.mjs [--skip-install] [--force-config]
                       [--migrate-settings] [--agent-dir <path>]
```

- `--skip-install` — use the existing `node_modules`
- `--force-config` — overwrite existing configs (keeps a `.bak`)
- `--migrate-settings` — drop bundled plugin entries from `settings.json` (keeps a `.bak`)
- `--agent-dir` — pi agent dir (default `$PI_CODING_AGENT_DIR` or `~/.pi/agent`)

## Caveats

- **Config templates need one command.** pi loads extensions from the tarball,
  but `zentui.json` and the `pi-tool-display` config live in the agent dir.
  Run `/preset` (or `setup.mjs --skip-install --force-config`) to apply them.
- **Only `zentui.json` and the tool-display config are versioned.** They are
  plain config files, so `/preset apply` refuses to overwrite local edits;
  `--force` backs them up first.
- **Model/provider settings are not migrated.** `auth.json`, `models-store.json`,
  and provider defaults in `settings.json` are machine- and credential-specific
  and are never copied. Set `defaultProvider`/`defaultModel` manually.
  (`/preset` deliberately does not edit `settings.json` — pi owns that file and
  may rewrite it while running.)
- **Peer dependencies.** Plugins declare peer deps on `@earendil-works/pi-*`,
  which pi bundles and aliases at load time. Installs therefore use
  `--legacy-peer-deps`; nothing needs to be installed for them.
- **Paths are relative to this package.** `pi.extensions` points into
  `node_modules/`, so the directory must stay where it was installed (or be
  re-installed). Moving it requires re-running `pi install`.
- **Do not commit `node_modules/`** unless you intend to distribute via tarball
  with `--with-deps`.
- **`/preset` assumes the bundled layout.** It resolves templates relative to
  its own file, so it works from a checkout or an npm install, but not if the
  package directory is moved after `pi install` (re-run `pi install`).
