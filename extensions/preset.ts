/**
 * /preset — apply this package's config templates, and enable/disable the
 * plugins it bundles.
 *
 * Why a command rather than an npm install hook:
 *
 *   1. npm >= 11.19 blocks dependency install scripts by default (the new
 *      `allowScripts` policy) — pi installs packages into ~/.pi/agent/npm,
 *      which has its own package.json, so a `postinstall` hook would be
 *      skipped with only a warning.
 *   2. Even when it does run, pi's `npm install` is not an interactive TTY, so
 *      an install hook cannot ask "copy or not?".
 *   3. A command is explicit, re-runnable, and can diff before it overwrites.
 *
 * The templates live in this package under `config/`; the targets are files in
 * the pi agent dir that the bundled plugins read at startup. Nothing is written
 * unless the user asks for it.
 *
 * Why plugins are disabled with a settings filter rather than deleted:
 *
 *   Bundled plugins are not pi packages in their own right — they live inside
 *   this package's node_modules and have no `packages[]` entry of their own, so
 *   `pi remove npm:<plugin>` cannot address them, and deleting their files only
 *   lasts until the next `npm install` restores them. The one mechanism that
 *   survives updates is pi's own package filter: a `-relative/path` entry in
 *   this package's `packages[]` entry, resolved relative to the package root.
 *   `/preset remove` writes those, `/preset add` drops them again, and both
 *   leave the files on disk so a re-add is instant. `pi config` edits the same
 *   array, so the two never disagree about the resulting state.
 *
 *   The filter is read from and written by `scripts/pi-package-lib.mjs`, the
 *   same module the verification scripts use, so the writer and the reader
 *   cannot drift apart.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	BUNDLED_RESOURCE_TYPES,
	PACKAGE_ROOT,
	applyPluginFilter,
	bundledPlugins,
	findOwnPackageEntry,
	missingToolAdditions,
	pluginState,
	planKeybindingPatch,
	readJson,
	readPackageJson,
	withToolAdditions,
} from "../scripts/pi-package-lib.mjs";

// --------------------------------------------------------------- templates

interface PresetFile {
	/** Stable id used on the command line. */
	id: string;
	/** Where the template lives inside this package. */
	template: string;
	/** Destination, resolved against the pi agent dir at run time. */
	target: (agentDir: string) => string;
	/** Which bundled plugin consumes it. */
	owner: string;
	/**
	 * `copy` (default) replaces the target with the template; `keybindings`
	 * merges the template's actions into the target instead, because that file
	 * also holds bindings this package knows nothing about; `settings` writes a
	 * key into a settings.json the user already owns, so only that key changes.
	 */
	mode?: "copy" | "keybindings" | "settings";
}

/**
 * Order matters only for the summary: permission rules first, then the provider
 * endpoint, then the keybinding patch, then the `defaultTools` merge.
 */
const PRESET_FILES: PresetFile[] = [
	{
		id: "permission-system",
		template: join(PACKAGE_ROOT, "config", "pi-permission-system.config.json"),
		target: (agentDir) => join(agentDir, "extensions", "pi-permission-system", "config.json"),
		owner: "@gotgenes/pi-permission-system",
	},
	{
		id: "cliproxyapi",
		template: join(PACKAGE_ROOT, "config", "pi-cliproxyapi-provider.config.json"),
		target: (agentDir) => join(agentDir, "pi-cliproxyapi-provider", "config.json"),
		owner: "@samrito/pi-cliproxyapi-provider",
	},
	{
		// Frees ctrl+b from tui.editor.cursorLeft so @sakiko233/pi-background-tasks
		// registers it without pi's "Extension shortcut conflict" warning.
		id: "keybindings",
		template: join(PACKAGE_ROOT, "config", "keybindings.json"),
		target: (agentDir) => join(agentDir, "keybindings.json"),
		owner: "@sakiko233/pi-background-tasks",
		mode: "keybindings",
	},
	{
		// Not a file template: `defaultTools` lives in a settings.json the user
		// already owns, so only `"+codemode"` is merged in. `template` is a
		// placeholder `stateOf` never reads for `settings` mode.
		id: "default-tools",
		template: join(PACKAGE_ROOT, "package.json"),
		target: (agentDir) => join(agentDir, "settings.json"),
		owner: "pi builtin:codemode",
		mode: "settings",
	},
];

type FileState = "missing" | "identical" | "differs" | "no-template";

function shortPath(path: string): string {
	const home = process.env.HOME;
	return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Compare by content, so a rewrite that changes nothing is not reported as one. */
function stateOf(file: PresetFile, agentDir: string): FileState {
	const target = file.target(agentDir);
	if (file.mode === "settings") {
		// "differs" means "defaultTools does not enable codemode yet", not "the
		// file disagrees with a template".
		return missingToolAdditions(readJson(target) ?? {}).length > 0 ? "differs" : "identical";
	}
	if (!existsSync(file.template)) return "no-template";
	if (file.mode === "keybindings") {
		// "differs" here means "the patch still has work to do", not "the file
		// disagrees with the template": other actions in it are expected to differ.
		try {
			return planKeybindingPatch(target).changed ? "differs" : "identical";
		} catch {
			return "differs";
		}
	}
	if (!existsSync(target)) return "missing";
	try {
		return readFileSync(file.template, "utf-8") === readFileSync(target, "utf-8") ? "identical" : "differs";
	} catch {
		return "differs";
	}
}

/**
 * Whether `/preset apply` may touch this file without --force.
 *
 * A keybindings patch and the `defaultTools` merge are additive by
 * construction (they only edit the actions in KEYBINDING_PATCHES, or append a
 * missing `+name`), so unlike the copy templates they are applied as soon as
 * there is something to do.
 */
function appliesWithoutForce(file: PresetFile, state: FileState): boolean {
	if (state === "missing") return true;
	return state === "differs" && (file.mode === "keybindings" || file.mode === "settings");
}

interface ApplyResult {
	id: string;
	action: "created" | "updated" | "kept" | "skipped" | "failed";
	target: string;
	backup?: string;
	error?: string;
}

function applyFile(file: PresetFile, agentDir: string, force: boolean): ApplyResult {
	const target = file.target(agentDir);
	const state = stateOf(file, agentDir);

	if (state === "no-template") return { id: file.id, action: "skipped", target };
	if (state === "identical") return { id: file.id, action: "kept", target };
	if (state === "differs" && !force && !appliesWithoutForce(file, state)) return { id: file.id, action: "kept", target };

	// The keybindings template is a patch, not a replacement: the target also
	// holds bindings this package knows nothing about. `content` is what
	// planKeybindingPatch() computed for the file on disk plus the patch, so an
	// existing file keeps every one of its own entries.
	let content: string | undefined;
	if (file.mode === "keybindings") {
		try {
			content = planKeybindingPatch(target).content;
		} catch (error) {
			return {
				id: file.id,
				action: "failed",
				target,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	} else if (file.mode === "settings") {
		content = `${JSON.stringify(withToolAdditions(readJson(target) ?? {}), null, 2)}\n`;
	}

	try {
		mkdirSync(dirname(target), { recursive: true });
		let backup: string | undefined;
		if (existsSync(target)) {
			backup = `${target}.bak`;
			copyFileSync(target, backup);
		}
		if (content === undefined) copyFileSync(file.template, target);
		else writeFileSync(target, content, "utf-8");
		return { id: file.id, action: state === "missing" ? "created" : "updated", target, backup };
	} catch (error) {
		return {
			id: file.id,
			action: "failed",
			target,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

const ACTION_TEXT: Record<ApplyResult["action"], string> = {
	created: "created",
	updated: "updated",
	kept: "kept",
	skipped: "no template in package",
	failed: "FAILED",
};

function summarize(results: ApplyResult[]): string {
	return results
		.map((result) => {
			const detail = result.error
				? ` — ${result.error}`
				: result.backup
					? ` — backup ${shortPath(result.backup)}`
					: "";
			return `${ACTION_TEXT[result.action]} ${result.id}${detail}`;
		})
		.join("\n");
}

function statusLine(file: PresetFile, agentDir: string): string {
	const label = `${file.id} (${file.owner})`;
	switch (stateOf(file, agentDir)) {
		case "identical":
			return `✓ ${label}`;
		case "differs":
			if (file.mode === "keybindings") {
				return `~ ${label} — ctrl+b still bound, /preset apply frees it (keeps .bak)`;
			}
			if (file.mode === "settings") {
				return `~ ${label} — /preset apply adds "+codemode" to settings.json (keeps .bak)`;
			}
			return `~ ${label} — differs, /preset apply --force overwrites (keeps .bak)`;
		case "missing":
			return `· ${label} — not applied yet`;
		default:
			return `! ${label} — template missing from the package`;
	}
}

// ------------------------------------------------------------- plugin state

/** `[x] name — 1 extension, 2 themes` for every bundled plugin. */
function pluginLines(agentDir: string, cwd: string): string[] {
	const scope = resolveSettingsScope(agentDir, cwd);
	const plugins = bundledPlugins();
	const entry = scope?.entry;

	return plugins.map((plugin) => {
		const state = entry ? pluginState(entry, plugin) : "loading";
		const counts = BUNDLED_RESOURCE_TYPES.map((type) => {
			const count = plugin[type]?.length ?? 0;
			return count === 0 ? undefined : `${count} ${count === 1 ? type.slice(0, -1) : type}`;
		}).filter(Boolean);
		const missing = plugin.extensions.every((path) => !existsSync(join(PACKAGE_ROOT, path)));

		const mark = missing ? "!" : state === "disabled" ? " " : state === "partial" ? "~" : "x";
		const notes = [];
		if (state === "disabled") notes.push("disabled by settings.json filter");
		if (state === "partial") notes.push("partially filtered, see settings.json");
		if (missing) notes.push("files missing, run npm install in the package root");
		const suffix = notes.length > 0 ? ` — ${notes.join("; ")}` : "";

		return `[${mark}] ${plugin.name} — ${counts.join(", ")}${suffix}`;
	});
}

interface SettingsScope {
	/** "project" or "global", for the message shown to the user. */
	label: string;
	path: string;
	entry: unknown;
	packages: unknown[];
}

/**
 * Find the settings.json that registers this package.
 *
 * Project settings win over global ones (pi's own precedence), so look there
 * first; `pi install -l` puts the entry in `.pi/settings.json`.
 */
function resolveSettingsScope(agentDir: string, cwd: string): SettingsScope | undefined {
	const candidates = [
		{ label: "project", path: join(cwd, CONFIG_DIR_NAME, "settings.json") },
		{ label: "global", path: join(agentDir, "settings.json") },
	];

	for (const candidate of candidates) {
		const settings = readJson(candidate.path);
		const packages = Array.isArray(settings?.packages) ? settings.packages : [];
		const found = findOwnPackageEntry(packages);
		if (found) {
			return { label: candidate.label, path: candidate.path, entry: found.entry, packages };
		}
	}
	return undefined;
}

function setPluginsEnabled(ctx: ExtensionCommandContext, names: string[], enabled: boolean): void {
	const verb = enabled ? "add" : "remove";
	const agentDir = getAgentDir();
	const scope = resolveSettingsScope(agentDir, ctx.cwd);

	if (!scope) {
		ctx.ui.notify(
			`preset: settings.json has no packages[] entry for ${readPackageJson().name}, so there is ` +
				`nothing to filter.\nInstall it first: pi install npm:${readPackageJson().name}`,
			"error",
		);
		return;
	}

	let result;
	try {
		result = applyPluginFilter({ packages: scope.packages, names, enabled });
	} catch (error) {
		ctx.ui.notify(`preset ${verb}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	const current = JSON.stringify(scope.packages);
	const next = JSON.stringify(result.packages);
	if (current === next) {
		ctx.ui.notify(
			`preset ${verb}: nothing to change — ${names.join(", ")} ${enabled ? "already load" : "already disabled"}`,
			"info",
		);
		return;
	}

	const settings = readJson(scope.path);
	const backup = `${scope.path}.bak-${timestamp()}`;
	try {
		copyFileSync(scope.path, backup);
		writeFileSync(scope.path, `${JSON.stringify({ ...settings, packages: result.packages }, null, 2)}\n`, "utf-8");
	} catch (error) {
		ctx.ui.notify(
			`preset ${verb}: could not write ${shortPath(scope.path)} — ` +
				`${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	const detail = result.changes
		.map((change) => `${change.files} ${change.type}`)
		.join(", ");
	ctx.ui.notify(
		`preset ${verb}: ${names.join(", ")}\n` +
			`${enabled ? "re-enabled" : "disabled"} ${detail} in ${scope.label} settings\n` +
			`${shortPath(scope.path)} (backup ${shortPath(backup)})\n\n` +
			"Files stay on disk; the filter is what stops pi loading them.\n" +
			"Run /reload to apply now, or restart pi.",
		"info",
	);
}

function timestamp(): string {
	return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

// ---------------------------------------------------------------- command

const USAGE = [
	"/preset                        status, then ask which config templates to apply",
	"/preset status                 config template + bundled plugin status",
	"/preset apply [--force]        write config templates (keybindings.json and defaultTools are merged)",
	"/preset list                   bundled plugins and whether they are disabled",
	"/preset remove <plugin> [...]  stop loading bundled plugin(s)",
	"/preset add <plugin> [...]     load them again",
	"/preset help                   this message",
].join("\n");

function parseArgs(args: string): string[] {
	return args
		.trim()
		.split(/[\s,]+/)
		.filter(Boolean);
}

function runStatus(ctx: ExtensionCommandContext, agentDir: string): void {
	const lines = PRESET_FILES.map((file) => statusLine(file, agentDir));
	const pending = PRESET_FILES.filter((file) => appliesWithoutForce(file, stateOf(file, agentDir))).length;
	ctx.ui.notify(
		`agent dir: ${shortPath(agentDir)}\n${lines.join("\n")}\n\n${pending === 0 ? "all configs applied" : `${pending} config(s) not applied`}\n\n${USAGE}`,
		"info",
	);
}

function runPluginList(ctx: ExtensionCommandContext, agentDir: string): void {
	const lines = pluginLines(agentDir, ctx.cwd);
	const disabled = lines.filter((line) => line.startsWith("[ ")).length;
	ctx.ui.notify(
		`bundled plugins: ${lines.length}, disabled: ${disabled}\n` +
			`[x] loading  [ ] disabled  [~] partially filtered  [!] files missing\n\n` +
			`${lines.join("\n")}\n\n/preset remove <plugin>   /preset add <plugin>`,
		"info",
	);
}

async function runInteractive(ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
	// "pending" is what /preset apply would write without --force: a missing copy
	// template, or a keybindings patch that still has work to do. "overwrites" is
	// what only --force touches, i.e. a copy template whose content differs.
	const states = PRESET_FILES.map((file) => ({ file, state: stateOf(file, agentDir) }));
	const pending = states.filter(({ file, state }) => appliesWithoutForce(file, state));
	const overwrites = states.filter(({ file, state }) => state === "differs" && !appliesWithoutForce(file, state));
	const identical = states.filter(({ state }) => state === "identical").length;

	const summary = [
		`${identical} up to date, ${pending.length} pending, ${overwrites.length} differing`,
		...PRESET_FILES.map((file) => statusLine(file, agentDir)),
	].join("\n");

	if (pending.length === 0 && overwrites.length === 0) {
		ctx.ui.notify(`preset: nothing to do — all configs already applied\n${summary}`, "info");
		return;
	}

	const choices: string[] = [];
	const pendingChoice = `Apply ${pending.length} pending config${pending.length === 1 ? "" : "s"}`;
	const forceChoice = `Apply all and overwrite ${overwrites.length} differing file${overwrites.length === 1 ? "" : "s"} (keeps .bak)`;
	if (pending.length > 0) choices.push(pendingChoice);
	if (overwrites.length > 0) choices.push(forceChoice);
	choices.push("Cancel");

	const answer = await ctx.ui.select(`preset: ${summary}`, choices);
	if (!answer || answer === "Cancel") {
		ctx.ui.notify("preset: cancelled", "info");
		return;
	}

	const results: ApplyResult[] = [];
	const force = answer === forceChoice;
	for (const { file, state } of states) {
		if (state === "identical" || state === "no-template") continue;
		if (state === "differs" && !force && !appliesWithoutForce(file, state)) continue;
		results.push(applyFile(file, agentDir, force));
	}

	ctx.ui.notify(`preset:\n${summarize(results)}`, results.some((r) => r.action === "failed") ? "error" : "info");
	if (force) ctx.ui.notify("preset: restart pi (or /reload) to pick up the new configs", "info");
}

function pluginCompletions(prefix: string): { value: string; label: string }[] | null {
	const matches = bundledPlugins()
		.flatMap((plugin) => [plugin.name, plugin.name.split("/").pop() ?? plugin.name])
		.filter((name) => name.startsWith(prefix));
	return matches.length > 0 ? [...new Set(matches)].map((value) => ({ value, label: value })) : null;
}

export default function (pi: ExtensionAPI): void {
	const subcommands = ["status", "list", "apply", "remove", "add", "help"];

	pi.registerCommand("preset", {
		description: "Apply this package's config templates and enable/disable its bundled plugins",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			const spaceIndex = trimmed.search(/\s/);
			if (spaceIndex === -1) {
				const matches = [...subcommands, "apply --force"].filter((option) => option.startsWith(trimmed));
				return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
			}
			const [subcommand, ...rest] = trimmed.split(/\s+/);
			if (subcommand !== "remove" && subcommand !== "add") return null;
			return pluginCompletions(rest[rest.length - 1] ?? "");
		},
		handler: async (args, ctx) => {
			const agentDir = getAgentDir();
			const [subcommand, ...rest] = parseArgs(args);
			const force = rest.includes("--force") || subcommand === "force";
			const names = rest.filter((value) => !value.startsWith("--"));

			try {
				switch (subcommand) {
					case undefined:
						if (!ctx.hasUI) {
							runStatus(ctx, agentDir);
							return;
						}
						await runInteractive(ctx, agentDir);
						return;
					case "help":
						ctx.ui.notify(USAGE, "info");
						return;
					case "status":
						runStatus(ctx, agentDir);
						return;
					case "list":
						runPluginList(ctx, agentDir);
						return;
					case "apply":
					case "force": {
						const results = PRESET_FILES.map((file) => applyFile(file, agentDir, force));
						ctx.ui.notify(
							`preset:\n${summarize(results)}`,
							results.some((result) => result.action === "failed") ? "error" : "info",
						);
						if (results.some((result) => result.action === "updated")) {
							ctx.ui.notify("preset: restart pi (or /reload) to pick up the new configs", "info");
						}
						return;
					}
					case "remove":
					case "disable":
						if (names.length === 0) {
							ctx.ui.notify(`preset remove: name at least one plugin\n\n${USAGE}`, "warning");
							return;
						}
						setPluginsEnabled(ctx, names, false);
						return;
					case "add":
					case "enable":
						if (names.length === 0) {
							ctx.ui.notify(`preset add: name at least one plugin\n\n${USAGE}`, "warning");
							return;
						}
						setPluginsEnabled(ctx, names, true);
						return;
					default:
						ctx.ui.notify(`preset: unknown argument "${subcommand}"\n\n${USAGE}`, "warning");
						return;
				}
			} catch (error) {
				ctx.ui.notify(`preset: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// Discoverability: a one-line hint when a template has not been applied yet.
	// Set SAMRITO_PRESET_QUIET=1 to silence it.
	if (process.env.SAMRITO_PRESET_QUIET !== "1") {
		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			const agentDir = getAgentDir();
			const pending = PRESET_FILES.filter((file) => appliesWithoutForce(file, stateOf(file, agentDir)));
			if (pending.length === 0) return;
			ctx.ui.notify(
				`preset: ${pending.map((file) => file.id).join(", ")} not applied yet — run /preset`,
				"info",
			);
		});
	}
}
