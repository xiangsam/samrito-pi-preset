#!/usr/bin/env node
/**
 * samrito-pi-preset installer.
 *
 * Brings a machine to the state described by this bundle:
 *   1. install the plugin dependencies (npm install --omit=dev --legacy-peer-deps)
 *   2. regenerate pi.extensions from the installed plugin tree
 *   3. confirm every plugin resolves to concrete, loadable extension files
 *   4. copy user config templates into the pi agent dir when they are absent
 *   5. optionally drop conflicting plugin entries from settings.json
 *
 * Usage:
 *   node scripts/setup.mjs [options]
 *
 * Options:
 *   --skip-install        do not run npm install
 *   --force-config        overwrite existing config files (a .bak copy is kept)
 *   --migrate-settings    remove bundled plugin entries from settings.json
 *   --agent-dir <path>    pi agent dir (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
 *   --help                show this help
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
	EXCLUDED_PACKAGES,
	PACKAGE_ROOT,
	bundledPackageNames,
	collectExtensionFiles,
	collectThemeFiles,
	findSettingsConflicts,
	manifestExtensionEntries,
	manifestThemeEntries,
	readJson,
	relativeToPackage,
	resolveAgentDir,
	withoutSettingsConflicts,
} from "./pi-package-lib.mjs";

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};

if (has("--help") || has("-h")) {
	const source = await import("node:fs").then((fs) => fs.readFileSync(new URL(import.meta.url), "utf-8"));
	const block = source.slice(source.indexOf("/**") + 3, source.indexOf("*/"));
	console.log(block.replace(/^ \* ?/gm, "").trim());
	process.exit(0);
}

const skipInstall = has("--skip-install");
const forceConfig = has("--force-config");
const migrateSettings = has("--migrate-settings");
const agentDir = resolveAgentDir(valueOf("--agent-dir"));

const failures = [];
const warnings = [];

const step = (title) => console.log(`\n\u001b[1m${title}\u001b[0m`);
const ok = (message) => console.log(`  \u001b[32m✓\u001b[0m ${message}`);
const warn = (message) => {
	warnings.push(message);
	console.log(`  \u001b[33m!\u001b[0m ${message}`);
};
const fail = (message) => {
	failures.push(message);
	console.log(`  \u001b[31m✗\u001b[0m ${message}`);
};

// ---------------------------------------------------------------- 1. install

step("1. Plugin dependencies");

const npmCommand = process.env.PI_NPM_COMMAND ?? "npm";
const dependencyNames = bundledPackageNames();

if (skipInstall) {
	ok("skipped (--skip-install)");
} else {
	const installArgs = ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"];
	console.log(`  $ ${npmCommand} ${installArgs.join(" ")}`);
	const result = spawnSync(npmCommand, installArgs, {
		cwd: PACKAGE_ROOT,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status === 0) {
		ok(`installed ${dependencyNames.length} plugin dependencies`);
	} else {
		fail(`npm install exited with code ${result.status ?? "unknown"}`);
	}
}

// ------------------------------------------------------- 2. generate manifest

step("2. Manifest");

// Plugin manifests change between versions, and pi's loader imports
// pi.extensions entries verbatim (a directory entry fails to load), so the
// entry list is regenerated from the installed tree instead of hand-maintained.
// pi.themes is regenerated for a different reason: declaring any `pi` manifest
// disables convention-directory discovery for every resource type, so bundled
// themes must be listed explicitly or they are silently never loaded.
try {
	const output = execFileSync(process.execPath, [join(PACKAGE_ROOT, "scripts", "sync-manifest.mjs")], {
		cwd: PACKAGE_ROOT,
		encoding: "utf-8",
	});
	const extensionCount = manifestExtensionEntries().length;
	const themeCount = manifestThemeEntries().length;
	ok(`pi manifest regenerated (${extensionCount} extensions, ${themeCount} themes)`);
	if (extensionCount === 0) fail("pi.extensions is empty after regeneration");
	for (const line of output.split("\n").filter((line) => line.trim().startsWith("node_modules/"))) {
		console.log(`      ${line.trim()}`);
	}
} catch (error) {
	fail(`could not regenerate the pi manifest: ${String(error.stderr ?? error.message).trim()}`);
}

// ------------------------------------------------------------- 3. resolution

step("3. Resource resolution");

const extensions = manifestExtensionEntries();
const themes = manifestThemeEntries();
const resolvedPlugins = new Map();

for (const name of dependencyNames) {
	const root = join(PACKAGE_ROOT, "node_modules", name);
	const files = collectExtensionFiles(root);
	if (files.length === 0) {
		fail(`${name} resolves to no extension file (is it installed?)`);
		continue;
	}
	resolvedPlugins.set(name, files);
	const themeFiles = collectThemeFiles(root);
	const themeNote = themeFiles.length > 0 ? `, ${themeFiles.length} theme file(s)` : "";
	ok(`${name} → ${files.length} extension file${files.length === 1 ? "" : "s"}${themeNote}`);
}

for (const entry of extensions) {
	const absolute = join(PACKAGE_ROOT, entry);
	if (!existsSync(absolute)) {
		fail(`${entry} is missing`);
	} else if (statSync(absolute).isDirectory()) {
		fail(`${entry} is a directory; pi's loader imports extension paths directly and cannot handle it`);
	}
}

for (const entry of themes) {
	if (!existsSync(join(PACKAGE_ROOT, entry))) fail(`theme ${entry} is missing`);
}

for (const excluded of EXCLUDED_PACKAGES) {
	if (dependencyNames.includes(excluded) || extensions.some((entry) => entry.includes(excluded))) {
		fail(`excluded package ${excluded} is still declared`);
	} else {
		ok(`excluded as intended: ${excluded}`);
	}
}

// ---------------------------------------------------------------- 4. configs

step("4. User configuration");

const configCopies = [
	{
		from: join(PACKAGE_ROOT, "config", "pi-permission-system.config.json"),
		to: join(agentDir, "extensions", "pi-permission-system", "config.json"),
		label: "extensions/pi-permission-system/config.json",
	},
	{
		from: join(PACKAGE_ROOT, "config", "pi-cliproxyapi-provider.config.json"),
		to: join(agentDir, "pi-cliproxyapi-provider", "config.json"),
		label: "pi-cliproxyapi-provider/config.json",
	},
	{
		from: join(PACKAGE_ROOT, "config", "no-readonly-tool-autoload.ts"),
		to: join(agentDir, "extensions", "no-readonly-tool-autoload.ts"),
		label: "extensions/no-readonly-tool-autoload.ts",
	},
];

for (const { from, to, label } of configCopies) {
	if (!existsSync(from)) {
		warn(`template missing, skipped: ${relative(PACKAGE_ROOT, from)}`);
		continue;
	}
	if (existsSync(to) && !forceConfig) {
		ok(`${label} already present, kept as-is`);
		continue;
	}
	try {
		mkdirSync(dirname(to), { recursive: true });
		if (existsSync(to)) {
			copyFileSync(to, `${to}.bak`);
			warn(`${label} overwritten (backup: ${to}.bak)`);
		}
		copyFileSync(from, to);
		ok(`${label} written to ${to}`);
	} catch (error) {
		fail(`could not write ${label}: ${error.message}`);
	}
}

// -------------------------------------------------------------- 5. settings

step("5. settings.json");

const settingsPath = join(agentDir, "settings.json");
const settings = readJson(settingsPath);

if (!settings) {
	warn(`no settings.json at ${settingsPath}; pi creates one on first run`);
} else {
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const conflicts = findSettingsConflicts(settings, resolvedPlugins.keys(), EXCLUDED_PACKAGES);

	if (conflicts.length === 0) {
		ok("no conflicting plugin entries");
	} else {
		// Not cosmetic: both copies resolve, then every duplicate extension is
		// rejected with `Tool "x" conflicts with ...` and pi aborts startup.
		for (const { name } of conflicts) {
			console.log(`  · ${name}${EXCLUDED_PACKAGES.includes(name) ? " (excluded plugin)" : ""}`);
		}

		if (!migrateSettings) {
			fail(
				`${conflicts.length} plugin(s) in settings.json are also provided by this bundle; ` +
					"pi would abort startup with tool-conflict errors",
			);
			console.log("      fix: node scripts/setup.mjs --migrate-settings");
		} else {
			try {
				const next = withoutSettingsConflicts(packages, resolvedPlugins.keys(), EXCLUDED_PACKAGES);
				copyFileSync(settingsPath, `${settingsPath}.bak`);
				writeFileSync(settingsPath, `${JSON.stringify({ ...settings, packages: next }, null, 2)}\n`, "utf-8");
				ok(`removed ${conflicts.length} entry/entries (backup: ${settingsPath}.bak)`);
			} catch (error) {
				fail(`could not rewrite settings.json: ${error.message}`);
			}
		}
	}
}

// ------------------------------------------------------------------ summary

step("Summary");

console.log(`  plugins:   ${resolvedPlugins.size} resolved, ${extensions.length} extensions, ${themes.length} themes`);
console.log(`  agent dir: ${agentDir}`);
console.log(`  package:   ${PACKAGE_ROOT}`);

if (failures.length > 0) {
	console.log(`\n\u001b[31m${failures.length} problem(s):\u001b[0m`);
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log("\nNext steps:");
	console.log(`  1. node scripts/verify.mjs`);
	console.log(`  2. pi install ${PACKAGE_ROOT}   (if not already registered)`);
	console.log("  3. restart pi; all bundled extensions load from this package");
	if (warnings.length > 0) {
		console.log(`\n\u001b[33m${warnings.length} warning(s)\u001b[0m — review the output above.`);
	}
}
