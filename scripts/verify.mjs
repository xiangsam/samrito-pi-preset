#!/usr/bin/env node
/**
 * Verify this bundle is loadable by pi, without touching the real pi install.
 *
 * Five checks, in increasing order of fidelity:
 *   1. manifest          — pi.extensions/pi.themes match the installed plugin tree
 *   2. package manager   — pi's DefaultPackageManager resolves the bundle
 *   3. extension loading — pi's loadExtensions() imports every entry
 *   4. plugin filters    — the `packages[]` filter /preset writes actually
 *                          disables exactly the named plugins when pi reads it
 *   5. startup conflicts — bundled plugins also listed individually in settings
 *
 * Check 3 deliberately calls `loadExtensions`, the same function real startup
 * uses. (It is stricter than `discoverAndLoadExtensions`, which silently expands
 * directory paths and would hide the "Cannot find module" failure that occurs
 * when a manifest lists a plugin's resource directory instead of its entry file.)
 *
 * Check 4 is the one that cannot be done by reading code: it writes the exact
 * settings.json shape `/preset remove` writes and asserts pi's resolver turns
 * those plugins off — and only those.
 *
 * Usage:
 *   node scripts/verify.mjs [--verbose]
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
	BUNDLED_RESOURCE_TYPES,
	EXCLUDED_PACKAGES,
	PACKAGE_ROOT,
	applyPluginFilter,
	bundledPackageNames,
	bundledPlugins,
	collectExtensionFiles,
	collectThemeFiles,
	disabledPlugins,
	findOwnPackageEntry,
	findSettingsConflicts,
	manifestDrift,
	manifestExtensionEntries,
	manifestThemeEntries,
	pluginState,
	readJson,
	readPackageJson,
} from "./pi-package-lib.mjs";

const verbose = process.argv.includes("--verbose");
const problems = [];

const ok = (message) => console.log(`  \u001b[32m✓\u001b[0m ${message}`);
const fail = (message) => console.log(`  \u001b[31m✗\u001b[0m ${message}`);
const note = (message) => console.log(`  \u001b[33m!\u001b[0m ${message}`);
const heading = (title) => console.log(`\n\u001b[1m${title}\u001b[0m`);

function problem(message) {
	problems.push(message);
	fail(message);
}

// ------------------------------------------------------- 1. manifest integrity

heading("1. Manifest");

const extensions = manifestExtensionEntries();
const themes = manifestThemeEntries();

if (extensions.length === 0) {
	problem("package.json declares no pi.extensions entries");
} else {
	ok(`pi.extensions declares ${extensions.length} entries, pi.themes ${themes.length}`);
}

// Every declared path must exist and be a *file*: the loader imports paths
// directly and fails on directories.
for (const entry of [...extensions, ...themes]) {
	const absolute = join(PACKAGE_ROOT, entry);
	if (!existsSync(absolute)) {
		problem(`${entry} does not exist (run scripts/setup.mjs)`);
		continue;
	}
	if (statSync(absolute).isDirectory()) {
		problem(
			`${entry} is a directory — pi resolves manifest entries to files, so a directory here ` +
				"(run scripts/sync-manifest.mjs)",
		);
	}
}

// Every dependency must contribute at least one entry, and every entry must
// belong to a declared dependency.
for (const plugin of bundledPlugins()) {
	if (plugin.extensions.length === 0) {
		problem(`dependency ${plugin.name} resolves to no extension file`);
		continue;
	}
	if (verbose) {
		const parts = [`${plugin.extensions.length} extension(s)`];
		if (plugin.themes.length > 0) parts.push(`${plugin.themes.length} theme(s)`);
		ok(`${plugin.name} → ${parts.join(", ")}`);
	}
}

// Bundled themes are the resource type that silently disappears when the
// manifest forgets them, so assert the two agree in both directions.
for (const entry of themes) {
	const owner = bundledPlugins().find((plugin) => plugin.themes.includes(entry));
	if (!owner) problem(`theme ${entry} belongs to no declared dependency`);
}

for (const excluded of EXCLUDED_PACKAGES) {
	const declared = bundledPackageNames().includes(excluded);
	const referenced = [...extensions, ...themes].some((entry) => entry.includes(excluded));
	if (declared || referenced) {
		problem(`${excluded} is still declared or referenced`);
	} else {
		ok(`${excluded} excluded`);
	}
}

// Drift check against the installed tree.
const drift = manifestDrift();
if (drift.stale.length === 0) {
	ok("pi.extensions and pi.themes are in sync with the installed tree");
} else {
	problem(`pi manifest is stale: ${drift.stale.map((type) => `pi.${type}`).join(", ")} (run scripts/sync-manifest.mjs)`);
}

// The config templates are what /preset copies; a missing one is a broken
// command, not a cosmetic problem.
for (const template of ["pi-permission-system.config.json", "pi-cliproxyapi-provider.config.json", "no-readonly-tool-autoload.ts"]) {
	if (existsSync(join(PACKAGE_ROOT, "config", template))) continue;
	problem(`config/${template} is missing (the /preset command ships it)`);
}
ok("config templates present");

// ------------------------------------------------------- 2. locate the install

heading("2. pi package resolution");

function findPiModule() {
	if (process.env.PI_MODULE_PATH && existsSync(process.env.PI_MODULE_PATH)) {
		return process.env.PI_MODULE_PATH;
	}
	let binary;
	try {
		binary = execFileSync("which", ["pi"], { encoding: "utf-8" }).trim();
	} catch {
		return undefined;
	}
	let current;
	try {
		current = dirname(realpathSync(binary));
	} catch {
		return undefined;
	}
	while (current !== dirname(current)) {
		const manifestPath = join(current, "package.json");
		if (existsSync(manifestPath)) {
			const manifest = readJson(manifestPath);
			if (manifest?.name === "@earendil-works/pi-coding-agent") {
				const entry = join(current, manifest.exports?.["."]?.import ?? "dist/index.js");
				return existsSync(entry) ? entry : undefined;
			}
		}
		current = dirname(current);
	}
	return undefined;
}

const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-verify-"));
const piModule = findPiModule();

try {
	if (!piModule) {
		note("pi not found on PATH; skipped (set PI_MODULE_PATH to enable)");
	} else {
		console.log(`  using ${piModule}`);
		const { DefaultPackageManager, SettingsManager } = await import(pathToFileURL(piModule).href);

		mkdirSync(tempAgentDir, { recursive: true });
		writeFileSync(
			join(tempAgentDir, "settings.json"),
			`${JSON.stringify({ packages: [PACKAGE_ROOT] }, null, 2)}\n`,
			"utf-8",
		);

		const settingsManager = SettingsManager.create(PACKAGE_ROOT, tempAgentDir);
		const manager = new DefaultPackageManager({
			cwd: PACKAGE_ROOT,
			agentDir: tempAgentDir,
			settingsManager,
		});

		const resolved = await manager.resolve();
		const enabled = (resources) => resources.filter((resource) => resource.enabled);
		const resolvedExtensions = enabled(resolved.extensions);

		if (resolvedExtensions.length === 0) {
			problem("pi resolved zero extensions from this bundle");
		} else {
			ok(`resolved ${resolvedExtensions.length} extensions`);
		}

		for (const label of BUNDLED_RESOURCE_TYPES) {
			console.log(`  · ${label}: ${enabled(resolved[label]).length}`);
		}
		if (enabled(resolved.themes).length !== themes.length) {
			problem(
				`pi resolved ${enabled(resolved.themes).length} themes, expected ${themes.length} — ` +
					"bundled themes are declared in pi.themes, and a missing entry means they never load",
			);
		}

		for (const excluded of EXCLUDED_PACKAGES) {
			const leaked = enabled(resolved.extensions).some((resource) => resource.path.includes(excluded));
			if (leaked) problem(`${excluded} was loaded`);
		}

		// ------------------------------------------------ 3. real loading

		heading("3. Extension loading (pi's startup path: loadExtensions)");

		const loader = await import(pathToFileURL(join(dirname(piModule), "core/extensions/loader.js")).href);
		const result = await loader.loadExtensions(
			resolvedExtensions.map((resource) => resource.path),
			PACKAGE_ROOT,
		);

		for (const error of result.errors) {
			problem(`load error in ${relative(PACKAGE_ROOT, error.path)}: ${error.error.split("\n")[0]}`);
		}

		if (result.errors.length === 0) {
			const tools = result.extensions.reduce((total, extension) => total + extension.tools.size, 0);
			const commands = result.extensions.reduce((total, extension) => total + extension.commands.size, 0);
			ok(`all ${result.extensions.length} extensions loaded, 0 errors`);
			console.log(`  · registered: ${tools} tools, ${commands} commands`);
		}

		if (result.extensions.length !== resolvedExtensions.length) {
			problem(`only ${result.extensions.length} of ${resolvedExtensions.length} extensions produced a factory`);
		}

		// The plugin-control commands only exist if /preset is loaded.
		const preset = result.extensions.find((extension) => extension.commands.has("preset"));
		if (preset) ok("/preset command is registered");
		else problem("/preset command is missing, so plugin enable/disable is unreachable");

		if (verbose) {
			for (const extension of result.extensions) {
				console.log(`      ${relative(PACKAGE_ROOT, extension.resolvedPath ?? extension.path)}`);
			}
		}

		// ------------------------------------- 4. /preset plugin filters

		heading("4. Plugin filters (/preset remove semantics)");

		const plugins = bundledPlugins();
		// Pick a plugin with themes and a plain one, so both resource types are
		// exercised: a theme left enabled after removing the plugin that owns it
		// would be a silent half-removal.
		const withThemes = plugins.find((plugin) => plugin.themes.length > 0);
		const plain = plugins.find((plugin) => plugin.themes.length === 0 && plugin.name !== withThemes?.name);
		const targets = [withThemes, plain].filter(Boolean).map((plugin) => plugin.name);

		if (!withThemes || !plain) {
			note("no theme-bearing plugin in this bundle; theme filter path untested");
		} else {
			const filtered = applyPluginFilter({ packages: [PACKAGE_ROOT], names: targets, enabled: false });
			writeFileSync(
				join(tempAgentDir, "settings.json"),
				`${JSON.stringify({ packages: filtered.packages }, null, 2)}\n`,
				"utf-8",
			);

			await settingsManager.reload();
			const afterRemoval = await manager.resolve();

			const disabled = new Set(disabledPlugins(filtered.packages).map((name) => `node_modules/${name}/`));
			const stillEnabled = enabled(afterRemoval.extensions)
				.map((resource) => relative(PACKAGE_ROOT, resource.path))
				.filter((path) => targets.some((name) => path.startsWith(`node_modules/${name}/`)));

			if (stillEnabled.length > 0) {
				problem(`pi still loads ${stillEnabled.join(", ")} after /preset remove`);
			} else {
				ok(`pi resolves 0 extensions for ${targets.join(", ")} after removal`);
			}

			const unexpected = enabled(afterRemoval.themes)
				.map((resource) => relative(PACKAGE_ROOT, resource.path))
				.filter((path) => [...disabled].some((prefix) => path.startsWith(prefix)));
			if (unexpected.length > 0) {
				problem(`themes from a removed plugin are still enabled: ${unexpected.join(", ")}`);
			} else if (withThemes) {
				ok(`themes of ${withThemes.name} are excluded too`);
			}

			const removedCount = targets
				.map((name) => plugins.find((plugin) => plugin.name === name))
				.reduce((sum, plugin) => sum + (plugin?.extensions.length ?? 0), 0);
			if (enabled(afterRemoval.extensions).length !== resolvedExtensions.length - removedCount) {
				problem(
					`removal left ${enabled(afterRemoval.extensions).length} extensions enabled, expected ` +
						`${resolvedExtensions.length - removedCount}`,
				);
			} else {
				ok("every other extension stays enabled");
			}

			// Round trip: /preset add has to put the manifest back to string form.
			const restored = applyPluginFilter({ packages: filtered.packages, names: targets, enabled: true });
			if (restored.packages.length !== 1 || typeof restored.packages[0] !== "string") {
				problem(`/preset add did not collapse the filter back to a string entry: ${JSON.stringify(restored.packages)}`);
			} else {
				writeFileSync(
					join(tempAgentDir, "settings.json"),
					`${JSON.stringify({ packages: restored.packages }, null, 2)}\n`,
					"utf-8",
				);
				await settingsManager.reload();
				const afterRestore = await manager.resolve();
				if (enabled(afterRestore.extensions).length !== resolvedExtensions.length) {
					problem(`/preset add restored ${enabled(afterRestore.extensions).length} of ${resolvedExtensions.length} extensions`);
				} else {
					ok("/preset add restores every extension");
				}
			}

			// The command must refuse to remove itself.
			try {
				applyPluginFilter({ packages: [PACKAGE_ROOT], names: ["extensions/preset.ts"], enabled: false });
				problem("/preset remove accepted this package's own /preset command");
			} catch {
				ok("removing the /preset command itself is refused");
			}

			// An incomplete install must fail loudly: a filter for files that are not
			// there looks like success and silently does nothing.
			const brokenRoot = mkdtempSync(join(tmpdir(), "pi-preset-broken-"));
			try {
				const ownName = readPackageJson().name;
				writeFileSync(
					join(brokenRoot, "package.json"),
					`${JSON.stringify({ name: ownName, version: "0.0.0", dependencies: { "pi-goal-x": "*" } })}\n`,
					"utf-8",
				);
				try {
					applyPluginFilter({ packages: [`npm:${ownName}`], names: ["pi-goal-x"], enabled: false, root: brokenRoot });
					problem("applyPluginFilter accepted a plugin whose files are not installed");
				} catch (error) {
					if (/node_modules looks incomplete/.test(error.message)) {
						ok("an incomplete install is refused instead of silently no-op");
					} else {
						problem(`unexpected error for an incomplete install: ${error.message}`);
					}
				}
			} finally {
				rmSync(brokenRoot, { recursive: true, force: true });
			}
		}

		// ------------------------------- 5. /preset command, end to end

		heading("5. /preset command (config templates and plugin control)");

		const presetCommand = result.extensions.find((extension) => extension.commands.has("preset"))?.commands.get("preset");

		if (!presetCommand?.handler) {
			problem("/preset command handler is not callable");
		} else {
			// A scratch agent dir, so exercising the command can never touch the real
			// install: getAgentDir() honours PI_CODING_AGENT_DIR on every call.
			const commandAgentDir = mkdtempSync(join(tmpdir(), "pi-preset-cmd-"));
			const commandSettings = join(commandAgentDir, "settings.json");
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			const notices = [];
			const ctx = {
				cwd: PACKAGE_ROOT,
				hasUI: false,
				ui: {
					notify: (message, type) => notices.push({ message, type: type ?? "info" }),
					select: async () => undefined,
					confirm: async () => false,
					input: async () => undefined,
				},
			};
			const writeSettings = (settings) =>
				writeFileSync(commandSettings, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
			const run = async (args) => {
				notices.length = 0;
				await presetCommand.handler(args, ctx);
				return notices.map((notice) => notice.message).join("\n");
			};
			const packages = () => readJson(commandSettings)?.packages ?? [];
			const stateOf = (name) => {
				const plugin = bundledPlugins().find((candidate) => candidate.name === name);
				const found = findOwnPackageEntry(packages());
				return plugin && found ? pluginState(found.entry, plugin) : "loading";
			};

			process.env.PI_CODING_AGENT_DIR = commandAgentDir;
			try {
				// Plugin list before anything is configured.
				writeSettings({ packages: ["npm:samrito-pi-preset"], theme: "dark" });
				const listBefore = await run("list");
				if (/bundled plugins: \d+, disabled: 0/.test(listBefore)) ok("/preset list reports every plugin as loading");
				else problem(`/preset list output unexpected:\n${listBefore}`);

				const statusBefore = await run("status");
				if (statusBefore.includes("not applied yet")) ok("/preset status reports unapplied templates");
				else problem(`/preset status output unexpected:\n${statusBefore}`);

				// Apply the templates into the scratch agent dir.
				await run("apply");
				const templateTargets = [
					join(commandAgentDir, "extensions", "pi-permission-system", "config.json"),
					join(commandAgentDir, "pi-cliproxyapi-provider", "config.json"),
					join(commandAgentDir, "extensions", "no-readonly-tool-autoload.ts"),
				];
				const missingTargets = templateTargets.filter((target) => !existsSync(target));
				if (missingTargets.length === 0) ok("/preset apply writes all three config templates");
				else problem(`/preset apply did not write: ${missingTargets.join(", ")}`);

				// A changed target is left alone unless --force is given.
				const overwritten = templateTargets[0];
				writeFileSync(overwritten, "{}\n", "utf-8");
				const keepOutput = await run("apply");
				if (readFileSync(overwritten, "utf-8") === "{}\n") ok("/preset apply leaves a modified file alone");
				else problem(`/preset apply overwrote a modified file:\n${keepOutput}`);

				await run("apply --force");
				if (readFileSync(overwritten, "utf-8") !== "{}\n" && existsSync(`${overwritten}.bak`)) {
					ok("/preset apply --force overwrites and keeps a .bak");
				} else {
					problem("/preset apply --force did not overwrite or did not keep a backup");
				}

				// Remove two plugins: a scoped one that also owns themes, and a bare one.
				await run("remove @nguyenquangthai/pi-omp-theme pi-context-view");
				const removed = packages()[0];
				if (
					typeof removed === "object" &&
					removed.extensions?.length === 2 &&
					removed.themes?.length === 2 &&
					stateOf("@nguyenquangthai/pi-omp-theme") === "disabled" &&
					stateOf("pi-context-view") === "disabled"
				) {
					ok("/preset remove disables extensions and themes of the named plugins");
				} else {
					problem(`/preset remove wrote an unexpected entry: ${JSON.stringify(removed)}`);
				}

				const listAfter = await run("list");
				if (/bundled plugins: \d+, disabled: 2/.test(listAfter)) ok("/preset list counts the disabled plugins");
				else problem(`/preset list did not report 2 disabled plugins:\n${listAfter}`);

				// Bare names resolve, and a full re-add collapses back to the string form
				// so `pi update`/`pi install` see a clean entry.
				await run("add pi-omp-theme pi-context-view");
				if (packages().length === 1 && typeof packages()[0] === "string") {
					ok("/preset add re-enables plugins and collapses the filter");
				} else {
					problem(`/preset add left an unexpected entry: ${JSON.stringify(packages())}`);
				}

				const unknown = await run("remove not-a-plugin");
				if (unknown.includes("unknown plugin")) ok("/preset remove rejects an unknown plugin name");
				else problem(`/preset remove did not reject an unknown plugin:\n${unknown}`);

				const noName = await run("remove");
				if (noName.includes("name at least one plugin")) ok("/preset remove without a name warns");
				else problem(`/preset remove without a name did not warn:\n${noName}`);

				const unknownSubcommand = await run("frobnicate");
				if (unknownSubcommand.includes("unknown argument")) ok("/preset rejects an unknown subcommand");
				else problem(`/preset accepted an unknown subcommand:\n${unknownSubcommand}`);

				// Without a packages[] entry there is nothing to filter; the command has
				// to say so instead of writing a settings file nobody reads.
				writeSettings({ theme: "dark" });
				const notInstalled = await run("remove pi-goal-x");
				if (notInstalled.includes("no packages[] entry")) ok("/preset remove explains a missing packages[] entry");
				else problem(`/preset remove did not explain a missing entry:\n${notInstalled}`);
			} finally {
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				rmSync(commandAgentDir, { recursive: true, force: true });
			}
		}
	}
} catch (error) {
	problem(`verification failed: ${error.message}`);
} finally {
	rmSync(tempAgentDir, { recursive: true, force: true });
}

// ------------------------------------------------------- 6. startup conflicts

heading("6. startup conflicts");

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
const settingsPath = join(agentDir, "settings.json");
const configured = Array.isArray(readJson(settingsPath)?.packages) ? readJson(settingsPath).packages : [];
const conflicts = findSettingsConflicts({ packages: configured }, bundledPackageNames(), EXCLUDED_PACKAGES);
const presetInstalled = configured.some((entry) => {
	const source = typeof entry === "string" ? entry : entry?.source;
	return typeof source === "string" && source.includes(readPackageJson().name);
});

if (conflicts.length === 0) {
	ok(`no bundled plugin is also listed in ${settingsPath}`);
} else if (!presetInstalled) {
	// This machine manages the same plugins as individual npm: packages. That is
	// a supported arrangement — it just means installing the preset here needs a
	// migration first — so it is reported, not treated as a failure.
	note(
		`${settingsPath} lists ${conflicts.length} plugin(s) that this bundle also provides; ` +
			"installing the preset here requires the migration below",
	);
	for (const { name } of conflicts) console.log(`      · ${name}`);
	console.log("      then: node scripts/setup.mjs --migrate-settings");
} else {
	// A duplicate is fatal, not cosmetic: pi resolves both copies and then
	// rejects every duplicate with `Tool "x" conflicts with ...`, aborting startup.
	problem(
		`${conflicts.length} bundled plugin(s) are also listed in ${settingsPath} while the preset itself ` +
			"is installed; pi would abort startup with tool-conflict errors",
	);
	console.log("      fix: node scripts/setup.mjs --migrate-settings");
}

// ------------------------------------------------------------------- summary

console.log("");
if (problems.length > 0) {
	console.log(`\u001b[31m${problems.length} problem(s)\u001b[0m`);
	for (const item of problems) console.log(`  - ${item}`);
	process.exitCode = 1;
} else {
	console.log("\u001b[32mOK\u001b[0m — the bundle resolves and every extension loads cleanly.");
}
