# samrito-pi-preset

A portable [pi](https://pi.dev) package that bundles this machine's extension
collection (including the `@samrito/pi-cliproxyapi-provider` provider) under a single
`pi install`-able package.

Install it from npm in one command:

```bash
pi install npm:samrito-pi-preset
```

The plugins are packed into the tarball (`bundledDependencies`), so nothing is
fetched from the registry at load time and no setup step is required. See
[Publish and install from npm](#publish-and-install-from-npm).

Config templates (permission rules, provider endpoint, codemode) and
per-plugin enable/disable are shipped but never applied behind your back — one
slash command after the first restart:

```
/preset
```

See [Applying the config templates](#applying-the-config-templates) and
[Disabling a bundled plugin](#disabling-a-bundled-plugin).

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
| Extensions | 11 npm plugins + `/preset`, 12 entry files | see [Bundled plugins](#bundled-plugins) |
| Themes | `@nguyenquangthai/pi-omp-theme`, 2 files | re-declared in `pi.themes`; a `pi` manifest disables theme discovery |
| `config/pi-permission-system.config.json` | `~/.pi/agent/extensions/pi-permission-system/config.json` | permission rules |
| `config/pi-cliproxyapi-provider.config.json` | `~/.pi/agent/pi-cliproxyapi-provider/config.json` | provider endpoint and auth |
| `config/keybindings.json` | `~/.pi/agent/keybindings.json` | frees `ctrl+b` for the background-tasks shortcut; **merged**, never overwritten |
| `defaultTools` | `~/.pi/agent/settings.json` | adds `+codemode`; **merged** into the key, never replaces it |

`config/keybindings.json` and the `defaultTools` entry are merges rather than
copies: both files also hold settings this package knows nothing about.

`@nguyenquangthai/pi-omp-theme` no longer forces `grep`/`find`/`ls` into the
active tool set — read-only tool activation is opt-in there
(`piOmpTheme.readonlyTools`, default `false`) — so this bundle no longer ships
the `no-readonly-tool-autoload.ts` workaround older versions needed. If you were
running that file from the agent dir's `extensions/`, delete it; it is a no-op
now.

Personal skills under `~/.agents/skills/` are **not** bundled — keep those
managed separately, or copy the directory to the target machine.

### Bundled plugins

| Plugin | Version | Files |
| --- | --- | --- |
| `@gotgenes/pi-permission-system` | ^40.1.1 | `src/index.ts` |
| `@gotgenes/pi-subagents` | ^23.2.0 | `src/index.ts` |
| `@juicesharp/rpiv-ask-user-question` | ^2.12.0 | `index.ts` |
| `@juicesharp/rpiv-todo` | ^2.12.0 | `index.ts` |
| `@juicesharp/rpiv-web-tools` | ^2.12.0 | `index.ts` |
| `@narumitw/pi-btw` | ^0.61.1 | `dist/index.ts` |
| `@nguyenquangthai/pi-omp-theme` | ^1.0.15 | `dist/extensions/pi-omp-theme.ts`, 2 themes |
| `@sakiko233/pi-background-tasks` | ^3.1.0 | `extensions/background-tasks.ts` |
| `@samrito/pi-cliproxyapi-provider` | ^0.16.0 | `extensions/index.ts` |
| `pi-context-view` | ^0.6.0 | `src/index.ts` |
| `pi-goal-x` | ^0.32.3 | `extensions/goal.ts` |

All packages here are bundled into the published tarball, so the target machine
needs no registry access to load them (see [How it works](#how-it-works)).

`extensions/preset.ts` is this package's **own** extension. It ships the
`/preset` command described below and registers no tools, so it never conflicts
with the plugins it bundles.

`@juicesharp/rpiv-web-tools` adds `web_search` and `web_fetch` plus the
`/web-tools` command, and needs a search credential before `web_search` works.
That credential is deliberately **not** a config template here: `/web-tools`
writes `~/.config/rpiv-web-tools/config.json` (mode `0600`, or
`$XDG_CONFIG_HOME/rpiv-web-tools/config.json`) holding per-provider API keys, so
it is machine- and credential-specific like `auth.json`. Run `/web-tools` on the
target machine to pick a backend and paste a key, or export the provider's own
variable (for example `BRAVE_SEARCH_API_KEY`) — the environment wins over the
file. `web_fetch` works with no key at all, and the self-hosted `searxng` and
`ollama` backends need only a base URL. See the package's
[Providers](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/providers.md)
doc for the per-backend variable names.

## Applying the config templates

`config/` holds files that *other* extensions read from the pi agent dir at
startup. They cannot travel in the package itself, so the bundled `/preset`
command copies them on request:

```
/preset                 status, then ask which config templates to apply
/preset status          config template + bundled plugin status
/preset apply           write configs that are missing (never overwrites)
/preset apply --force   write all configs, backing up what exists
/preset list            bundled plugins and whether they are disabled
/preset remove <plugin> stop loading bundled plugin(s)
/preset add <plugin>    load them again
/preset help            this message
```

Bare `/preset` summarises each template (`missing` / `up to date` / `differs`)
and offers a choice; `apply` never touches a file you edited, and `--force`
keeps a `.bak` next to whatever it replaces. Two entries are merged rather than
copied (see below), so even without `--force` they resolve their conflict and
keep the rest of your file:

- `keybindings.json` — drops the `ctrl+b` claim that collides with the
  background-tasks shortcut.
- `defaultTools` in `settings.json` — appends `+codemode`, which turns pi's
  [codemode](https://pi.dev/docs/codemode) tool on for every session without
  replacing the default `read`/`bash`/`edit`/`write` surface.

Until a template is applied, a one-line `/preset` hint is shown at session
start (silence it with `SAMRITO_PRESET_QUIET=1`).

Scripted and CI use is still supported:

```bash
node ~/.pi/agent/npm/node_modules/samrito-pi-preset/scripts/setup.mjs \
  --skip-install --force-config
```

`--force-config` does not apply to `keybindings.json`: that file is always
merged, never replaced wholesale, because it also holds bindings this package
knows nothing about. The same is true of the `defaultTools` entry, which is
merged into `settings.json` alongside whatever else that file holds.

### Why `defaultTools` is merged, not replaced

`codemode` is registered inactive by pi's built-in `builtin:codemode`
extension, so the only way to switch it on is a `defaultTools` entry. A plain
name list *replaces* pi's default `read`/`bash`/`edit`/`write` surface, so this
bundle uses the additive form instead:

```json
{
  "defaultTools": ["+codemode"]
}
```

`/preset apply` and `setup.mjs` append `+codemode` only when the key does not
already enable codemode (a plain `codemode` entry counts), preserving every
other entry in the list. On a project that replaces `defaultTools` outright,
add `+codemode` to that project list; the global entry cannot override a
project's plain-name replacement.

### Why `keybindings.json` is merged, not copied

`@sakiko233/pi-background-tasks` registers `ctrl+b` for "move the most recent
foreground bash command to the background". Pi's built-in
`tui.editor.cursorLeft` ships with `["left", "ctrl+b"]`, so every start prints:

```
Extension shortcut conflict: 'ctrl+b' is built-in shortcut for tui.editor.cursorLeft
and .../@sakiko233/pi-background-tasks/extensions/background-tasks.ts.
Using .../background-tasks.ts.
```

`tui.editor.cursorLeft` is not one of pi's reserved keybindings, which means pi
expects the *user* to resolve it: the conflict check runs against the resolved
keybindings, so dropping `ctrl+b` from that action removes the built-in claim
and the warning disappears. `config/keybindings.json` does exactly that:

```json
{
  "tui.editor.cursorLeft": [
    "left"
  ]
}
```

It is applied as a patch, per action: the released key is removed from
`tui.editor.cursorLeft`, every other binding in your file is carried over
untouched, and if you already moved `ctrl+b` somewhere else the file is left
alone. The table driving it is `KEYBINDING_PATCHES` in
`scripts/pi-package-lib.mjs`, and `verify.mjs` proves with pi's own
`KeybindingsManager` + `ExtensionRunner` that the warnings are gone. After
applying, `/reload` is enough — pi reloads `keybindings.json` on reload.

## Disabling a bundled plugin

```
/preset list                            # what is bundled, what is disabled
/preset remove pi-goal-x pi-context-view # stop loading them
/preset add  pi-goal-x                   # load them again
# then /reload, or restart pi
```

**Why a filter instead of a real uninstall.** Bundled plugins are not pi
packages in their own right: they live inside this package's `node_modules` and
have no `packages[]` entry of their own, so `pi remove npm:<plugin>` cannot
address them, and deleting their files lasts only until the next `npm install`
restores them. The one mechanism that survives `pi update --extensions` is pi's
own package filter — a `-relative/path` entry in this package's `packages[]`
entry:

```json
{
  "packages": [
    {
      "source": "npm:samrito-pi-preset",
      "extensions": ["-node_modules/pi-goal-x/extensions/goal.ts"]
    }
  ]
}
```

`/preset remove` appends those paths (including a plugin's themes), `/preset add`
drops them again and collapses the entry back to `"npm:samrito-pi-preset"` when
nothing is filtered. `pi list` shows the entry as `(filtered)` while a filter is
in place, and `pi config` edits the same array — a space-toggle there and
`/preset remove` here cannot disagree about the result.

What this does and does not do:

- **It stops pi loading the plugin.** Extensions and themes are dropped from
  resolution; the tool set goes back to what the remaining plugins provide.
- **It keeps the files on disk**, so `/preset add` is instant and offline. Disk
  usage is unchanged (the whole bundle is ~8 MB packed).
- **It survives updates.** `pi update --extensions` may restore the files, but
  the filter still keeps them out of the load list.
- **It does not remove the config templates** those plugins read. A disabled
  plugin's config in the agent dir is inert; delete it if you want it gone.
- **It needs a `packages[]` entry.** If this package is not registered in
  `settings.json`, `/preset remove` says so instead of writing a file nobody
  reads.
- **It refuses to disable `/preset` itself.**

If you would rather have each plugin as a first-class, individually removable
pi package, do not use this bundle: install the plugins directly
(`pi install npm:<plugin>`, one entry each in `settings.json`) and use
`pi remove` per plugin. That trades one-command setup and a locked version set
for full independence.

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
`bundledDependencies` makes npm pack every plugin into the tarball. Install it
anywhere with `pi install npm:samrito-pi-preset`.

Releases are driven by tags: pushing `vX.Y.Z` makes GitHub Actions publish that
exact version. See [Releasing](#releasing) for the one-time npm setup.

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
> `node_modules/pi-goal-x/...` would not exist under the package root. Bundling
> them inside the tarball is the layout pi's docs prescribe.

`prepack` runs `sync-manifest.mjs --check`, so a stale `pi` manifest fails the
publish instead of shipping.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to
`main` and every pull request. It never touches the registry.

| Job | Checks |
| --- | --- |
| `verify` (Node 22 + 24) | manifest integrity, pi resolution, real extension loading, plugin filters, and the `/preset` command itself — `verify.mjs` stages 1–6 |
| `tarball` | packs, installs, resolves and loads the **published artifact**, and re-tests a `/preset remove` filter against that npm-installed copy |

The `tarball` job exists because the checkout and the published package differ in
a way that matters: in the checkout npm hoists the plugins into a sibling
`node_modules/`, but in the tarball `bundledDependencies` must embed them
*inside* the package root, since `pi.extensions` paths are relative to it. A
drift between `dependencies` and `bundledDependencies` therefore breaks only the
published artifact, and `verify.mjs` cannot see it. Run it locally with:

```bash
npm run verify           # checks the checkout
npm run verify:tarball   # packs, installs, and loads the real artifact
```

Both jobs also guard a repo requirement: a vendor-scoped provider package that
was deliberately excluded from this bundle must never be referenced in tracked
files. The search term is assembled at runtime inside the workflow so the guard
cannot match its own source, and it deliberately does **not** scan the packed
tarball — the bundled upstream `models.dev` dataset contains vendor model ids
that are none of our business.

## Releasing

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) publishes on a
`vX.Y.Z` tag using npm **trusted publishing** (OIDC): no long-lived `NPM_TOKEN`
secret exists, and npm attaches a provenance attestation linking the tarball to
the repository and commit.

```bash
npm version patch        # or minor / major — bumps package.json and tags vX.Y.Z
git push --follow-tags    # workflow runs, verifies, publishes
```

The workflow refuses a tag that disagrees with `package.json`, runs
`scripts/verify.mjs` (loading every extension through pi's real startup path),
and treats re-tagging an already published version as a no-op rather than a
failure.

### One-time setup

A trusted publisher can only be configured for a package that already exists, so
the first version was published manually. `samrito-pi-preset@1.0.0` exists, so
configure once at
[npmjs.com](https://www.npmjs.com/package/samrito-pi-preset/access):

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization | `xiangsam` |
| Repository | `samrito-pi-preset` |
| Workflow name | `publish.yml` |
| Environment | *(leave empty)* |
| Allow direct publish | **enabled** |

`publish.yml` must match the workflow **filename** exactly — renaming the file
means updating this setting too. All fields are case-sensitive.

Trusted publishing requires **npm CLI ≥ 11.5.1 and Node ≥ 22.14.0**; the workflow
pins Node 24 and asserts the npm version before publishing. Provenance is
generated automatically for GitHub Actions, so `--provenance` is explicit rather
than required.

> **Trusted publisher connections cannot be edited.** npm fixes the provider and
> its fields once a connection is created, so changing *Allow direct publish*
> later means deleting the connection and adding a new one.

This package deliberately enables *direct publish* so a tag ships unattended. npm
recommends the opposite (stage only, then approve with 2FA); npm's own staged
publishing docs say to enable only `npm stage publish` and disable `npm publish`.
The trade-off, stated plainly: with direct publish enabled, anyone who can push a
tag or edit this workflow can publish to npm, and every consumer of the preset
pulls that version. To tighten it later:

1. Delete the trusted publisher above and recreate it with **stage-only**
   permissions (`npm trust github … --allow-stage-publish`, no `--allow-publish`).
2. Change the workflow's last step to `npm stage publish --provenance --access public`.
3. After each tag, finish the release locally:

```bash
npm stage list samrito-pi-preset
npm stage approve <stage-id>    # prompts for 2FA
npm stage reject <stage-id>     # to back out instead
```

### Publishing by hand

Still possible if OIDC is unavailable; `prepack` keeps the manifest honest.

```bash
npm login                 # once per machine
node scripts/verify.mjs   # optional but recommended
npm publish               # runs prepack -> sync-manifest --check
```

After the first restart, run `/preset` to apply the shipped config templates —
they are deliberately not written automatically.

## Two supported arrangements

This bundle and per-plugin `npm:` entries provide the same extensions, and pi
refuses to load both copies: a duplicate extension aborts startup with
`Tool "x" conflicts with ...`. So each machine picks one arrangement.

**A. The bundle** — one `packages[]` entry, per-plugin control through `/preset`:

```bash
pi install npm:samrito-pi-preset
/preset remove pi-goal-x        # stop loading the ones you do not want here
```

**B. Individual packages** — one `packages[]` entry per plugin, `pi remove` per
plugin:

```bash
pi install npm:@gotgenes/pi-subagents
pi install npm:pi-goal-x
# ...
pi remove npm:pi-goal-x         # a real uninstall, files and all
```

`/preset` is only available in arrangement A, because the command ships inside
this package.

To move a machine from B to A:

```bash
npm install                       # so this checkout has node_modules
node scripts/setup.mjs --migrate-settings   # drops the per-plugin entries, keeps settings.json.bak
node scripts/verify.mjs                     # must print OK
pi install "$PWD"                 # or pi install npm:samrito-pi-preset
# restart pi
```

`--migrate-settings` removes only the bundled plugin entries; your theme,
provider defaults, and other settings are preserved. Moving from A to B is the
reverse: `/preset list` names the bundled plugins, `pi remove
npm:samrito-pi-preset` drops the bundle, then install the plugins you want
individually.

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
templates it does not find, merges `+codemode` into `defaultTools`, and
**fails** if `settings.json` still lists any bundled plugin (see below). Add
`--migrate-settings` to have it clean those up.

### From a tarball

```bash
bash scripts/pack.sh                 # -> samrito-pi-preset-1.1.0.tar.gz
bash scripts/pack.sh --with-deps     # include node_modules (offline install)

# on the target machine
tar -xzf samrito-pi-preset-1.1.0.tar.gz
cd samrito-pi-preset && node scripts/setup.mjs
pi install "$PWD"
```

A tarball path is **not** a valid `pi install` source — pi treats a local path
that is a file as a single extension. Always extract first.

## How it works

`package.json` declares the plugins as regular npm `dependencies`, then lists
their entry files under `pi.extensions` and their themes under `pi.themes`:

```json
"pi": {
  "extensions": [
    "node_modules/pi-goal-x/extensions/goal.ts"
  ],
  "themes": [
    "node_modules/@nguyenquangthai/pi-omp-theme/themes/titanium.json"
  ]
}
```

Three pi behaviours shape this design:

1. **Local-path packages are not installed.** pi runs `npm install` for `npm:`
   and `git:` sources, but a local directory is registered as-is
   (`package-manager.js` → `install()` returns early). Hence the explicit
   `setup.mjs` install step; `pi install` alone would leave `node_modules` empty.

2. **The loader imports each entry path directly.** A directory entry fails with
   `Cannot find module`. This matters because some plugins declare a *directory*
   in their own manifest — `@nguyenquangthai/pi-omp-theme` declares
   `["./themes"]` — and pi passes that through verbatim for extensions, so
   entries must be concrete files.

3. **A `pi` manifest disables convention-directory discovery for every resource
   type.** The moment `pi.extensions` exists, pi stops looking in `themes/`,
   `skills/`, and `prompts/`. Bundled themes therefore have to be re-declared in
   `pi.themes` or they are silently never loaded — there is no error, the theme
   just does not exist. `verify.mjs` asserts the resolved theme count for this
   reason.

That second and third point are why the `pi` manifest is generated rather than
hand-written: `scripts/sync-manifest.mjs` expands each plugin through pi's own
resolution rules and writes the resulting files into `pi.extensions` and
`pi.themes`. It also lists this package's own `extensions/*.ts`: an unlisted own
entry would equally never load. `setup.mjs` runs the sync automatically, so run
`setup.mjs` after any version bump (`npm run sync` does it standalone).
`verify.mjs` fails when the manifest drifts from the installed tree.

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
3. Run `npm install && node scripts/setup.mjs` — `pi.extensions` and
   `pi.themes` are regenerated automatically.
4. `node scripts/verify.mjs` to confirm it loads,
   `npm pack --dry-run` to confirm the plugin lands in the tarball.

Converting the bundle into individually installable packages is the same edit
in the other direction: drop the plugin from all three lists, add a
`config/plugins.json`-style inventory if you want `/preset` to install them by
name, and let each machine `pi install npm:<plugin>` on its own. Bundled
plugins are invisible to `pi remove`, which is the trade-off documented in
[Disabling a bundled plugin](#disabling-a-bundled-plugin).

To stop bundling a plugin on **one machine only**, use `/preset remove` rather
than editing this repository: the filter in `settings.json` is what pi reads,
and it keeps working after the next update reinstates the files.

## Scripts

| Script | Purpose |
| --- | --- |
| `extensions/preset.ts` | the bundled `/preset` command (config templates + per-plugin enable/disable) |
| `scripts/setup.mjs` | install deps, regenerate manifest, copy configs, merge `+codemode`, report conflicts |
| `scripts/verify.mjs` | 6-stage check of the checkout: manifest, pi resolution, real loading, plugin filters, the `/preset` command, startup conflicts |
| `scripts/verify-tarball.mjs` | packs the tarball, installs it, and loads it through pi — catches `bundledDependencies` drift |
| `scripts/sync-manifest.mjs` | regenerate `pi.extensions` + `pi.themes` (`--check` for drift) |
| `scripts/pack.sh` | build a tarball (`--with-deps` to include `node_modules`) |
| `scripts/pi-package-lib.mjs` | shared helpers mirroring pi's resolution rules; also the filter reader/writer `/preset` uses |
| `.github/workflows/ci.yml` | verify + artifact checks on push/PR |
| `.github/workflows/publish.yml` | publish to npm on `vX.Y.Z` tags (trusted publishing) |

### `verify.mjs`

| Stage | Checks |
| --- | --- |
| 1. Manifest | entries exist, are files not directories, themes belong to a declared dependency, no excluded plugin declared, no drift, config templates present, `config/keybindings.json` in sync with `KEYBINDING_PATCHES`, and the `defaultTools` merge appends `+codemode` exactly once |
| 2. Resolution | pi's `DefaultPackageManager` resolves the bundle — extensions *and* themes — in a throwaway agent dir |
| 3. Loading | pi's `loadExtensions()` imports every entry — the exact startup code path — and `/preset` is registered; the loaded shortcuts are then run through pi's own `ExtensionRunner.getShortcuts()` twice, with and without the keybindings patch, to prove the `ctrl+b` warning is gone |
| 4. Plugin filters | the `packages[]` filter `/preset remove` writes really does disable exactly those plugins (extensions and themes), `/preset add` restores them, and removing `/preset` itself is refused |
| 5. `/preset` command | drives the real command handler against a scratch agent dir: list/status/apply/apply --force/remove/add, plus the error paths (unknown plugin, missing name, unknown subcommand, no `packages[]` entry); the keybindings patch and the `defaultTools` merge are applied over pre-existing files and have to keep the user's other entries |
| 6. Startup conflicts | bundled plugins still listed in `settings.json` while the bundle itself is installed (fatal — see below); a machine that installs the plugins individually instead gets a migration note, not a failure |

Stage 3 deliberately uses `loadExtensions` rather than `discoverAndLoadExtensions`:
the latter silently expands directory paths and would hide the
`Cannot find module` failure described above. Stage 4 and 5 exist because the
filter and the command are the parts most likely to rot silently: a filter that
is written but not honoured, or a command that writes the wrong shape, would
otherwise only show up on a user's machine.

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
  but the permission rules, the provider endpoint, the keybinding patch and the
  `defaultTools` entry live in the agent dir. Run `/preset` (or `setup.mjs
  --skip-install --force-config`) to apply them.
- **Config templates are plain files, so `/preset apply` refuses to overwrite
  local edits**; `--force` backs them up first. `keybindings.json` and the
  `defaultTools` entry are the exception — they are merged, so they never need
  `--force` and never lose entries they do not know about.
- **Model/provider settings are not migrated.** `auth.json`, `models-store.json`,
  and provider defaults in `settings.json` are machine- and credential-specific
  and are never copied. Set `defaultProvider`/`defaultModel` manually. (The
  `pi-cliproxyapi-provider` config template does carry `providerName` and
  `baseUrl`, because the provider needs those to register at all.) The same
  applies to `~/.config/rpiv-web-tools/config.json`: it holds search API keys, so
  run `/web-tools` on the target machine instead of copying it.
- **`/preset remove` and `/preset add` do write `settings.json`** — only the
  `packages[]` entry of this package, only its resource filters, and always with
  a timestamped `.bak` first. Pi owns the rest of that file and may rewrite it
  while running, so the backup matters. Nothing else in it is touched, and
  `/reload` (or a restart) applies the change.
- **Disabling a plugin is not uninstalling it.** Files stay in `node_modules` so
  the operation is instant and reversible; see
  [Disabling a bundled plugin](#disabling-a-bundled-plugin) for when to install
  plugins individually instead.
- **Read-only tools are opt-in in the theme.** `@nguyenquangthai/pi-omp-theme`
  leaves pi's active tool set alone by default (`piOmpTheme.readonlyTools: false`),
  so `grep`/`find`/`ls` stay off unless you ask for them. Older versions forced
  them on, which is why this bundle used to ship a
  `no-readonly-tool-autoload.ts` workaround; that file is obsolete and can be
  deleted from the agent dir's `extensions/`.
- **Peer dependencies.** Plugins declare peer deps on `@earendil-works/pi-*`,
  which pi bundles and aliases at load time. Installs therefore use
  `--legacy-peer-deps`; nothing needs to be installed for them.
- **Paths are relative to this package.** `pi.extensions` points into
  `node_modules/`, so the directory must stay where it was installed (or be
  re-installed). Moving it requires re-running `pi install`.
- **The provider is a fork.** `@samrito/pi-cliproxyapi-provider` is a fork of
  the upstream `pi-cliproxyapi-provider`, adding thinking levels derived from
  models.dev `reasoning_options`. It keeps the upstream settings namespace,
  config paths, cache directory, and `/cliproxyapi` command, so it is a drop-in
  replacement — but the two must not be installed together, since both register
  the same provider and command and pi rejects the duplicate.
- **No vendor-locked provider is bundled.** The vendor-scoped provider package
  that was previously excluded from this bundle must not be re-introduced. CI
  enforces this with a grep over tracked files (the term is assembled at runtime
  in the workflow so the guard cannot match its own source), and
  `scripts/pi-package-lib.mjs`'s `EXCLUDED_PACKAGES` lists what is deliberately
  skipped — currently empty.
- **Traditional token publishing should stay disabled.** npm's *Require
  two-factor authentication and disallow tokens* setting affects only traditional
  token auth: "Your trusted publishers will continue to work normally, as they
  use OIDC tokens." So it is safe — and recommended — to enable it while relying
  on the trusted publisher.
- **Do not commit `node_modules/`** unless you intend to distribute via tarball
  with `--with-deps`.
- **`/preset` assumes the bundled layout.** It resolves templates relative to
  its own file, so it works from a checkout or an npm install, but not if the
  package directory is moved after `pi install` (re-run `pi install`).
