#!/usr/bin/env node
/**
 * Verify this bundle is loadable by pi, without touching the real pi install.
 *
 * Four checks, in increasing order of fidelity:
 *   1. manifest          — pi.extensions matches the installed plugin tree
 *   2. package manager   — pi's DefaultPackageManager resolves the bundle
 *   3. extension loading — pi's loadExtensions() imports every entry
 *   4. startup conflicts — no bundled plugin is also listed in settings.json
 *
 * Check 3 deliberately calls `loadExtensions`, the same function real startup
 * uses. (It is stricter than `discoverAndLoadExtensions`, which silently expands
 * directory paths and would hide the "Cannot find module" failure that occurs
 * when a manifest lists a plugin's resource directory instead of its entry file.)
 *
 * Check 4 treats a duplicate config as fatal because pi resolves both copies and
 * then rejects every duplicate extension with `Tool "x" conflicts with ...`,
 * aborting startup.
 *
 * Usage:
 *   node scripts/verify.mjs [--verbose]
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
	EXCLUDED_PACKAGES,
	PACKAGE_ROOT,
	bundledPackageNames,
	collectExtensionFiles,
	findSettingsConflicts,
	manifestExtensionEntries,
	readJson,
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

const entries = manifestExtensionEntries();

if (entries.length === 0) {
	problem("package.json declares no pi.extensions entries");
} else {
	ok(`pi.extensions declares ${entries.length} entries`);
}

// Every declared path must exist and be a *file*: the loader imports paths
// directly and fails on directories.
for (const entry of entries) {
	const absolute = join(PACKAGE_ROOT, entry);
	if (!existsSync(absolute)) {
		problem(`${entry} does not exist (run scripts/setup.mjs)`);
		continue;
	}
	if (statSync(absolute).isDirectory()) {
		problem(
			`${entry} is a directory — pi's loader cannot import it, use the entry file instead ` +
				`(run scripts/sync-manifest.mjs)`,
		);
	}
}

// Every dependency must contribute at least one entry, and every entry must
// belong to a declared dependency.
for (const name of bundledPackageNames()) {
	const root = join(PACKAGE_ROOT, "node_modules", name);
	const files = collectExtensionFiles(root);
	if (files.length === 0) {
		problem(`dependency ${name} resolves to no extension file`);
		continue;
	}
	if (verbose) ok(`${name} → ${files.map((file) => relative(PACKAGE_ROOT, file)).join(", ")}`);
}

for (const excluded of EXCLUDED_PACKAGES) {
	const declared = bundledPackageNames().includes(excluded);
	const referenced = entries.some((entry) => entry.includes(excluded));
	if (declared || referenced) {
		problem(`${excluded} is still declared or referenced`);
	} else {
		ok(`${excluded} excluded`);
	}
}

// Drift check against the installed tree.
try {
	execFileSync(process.execPath, [join(PACKAGE_ROOT, "scripts", "sync-manifest.mjs"), "--check"], {
		cwd: PACKAGE_ROOT,
		stdio: verbose ? "inherit" : "pipe",
	});
	ok("pi.extensions is in sync with the installed tree");
} catch {
	problem("pi.extensions is stale (run scripts/sync-manifest.mjs)");
}

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
		const extensions = enabled(resolved.extensions);

		if (extensions.length === 0) {
			problem("pi resolved zero extensions from this bundle");
		} else {
			ok(`resolved ${extensions.length} extensions`);
		}

		for (const label of ["skills", "prompts", "themes"]) {
			console.log(`  · ${label}: ${enabled(resolved[label]).length}`);
		}

		for (const excluded of EXCLUDED_PACKAGES) {
			const leaked = [...extensions, ...enabled(resolved.skills)].some((resource) =>
				resource.path.includes(excluded),
			);
			if (leaked) problem(`${excluded} was loaded`);
		}

		// ------------------------------------------------ 3. real loading

		heading("3. Extension loading (pi's startup path: loadExtensions)");

		const loader = await import(pathToFileURL(join(dirname(piModule), "core/extensions/loader.js")).href);
		const result = await loader.loadExtensions(
			extensions.map((resource) => resource.path),
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

		if (result.extensions.length !== extensions.length) {
			problem(`only ${result.extensions.length} of ${extensions.length} extensions produced a factory`);
		}

		if (verbose) {
			for (const extension of result.extensions) {
				console.log(`      ${relative(PACKAGE_ROOT, extension.resolvedPath ?? extension.path)}`);
			}
		}
	}
} catch (error) {
	problem(`verification failed: ${error.message}`);
} finally {
	rmSync(tempAgentDir, { recursive: true, force: true });
}

// ------------------------------------------------------- 4. startup conflicts

heading("4. startup conflicts");

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
const settingsPath = join(agentDir, "settings.json");
const configured = Array.isArray(readJson(settingsPath)?.packages) ? readJson(settingsPath).packages : [];
const conflicts = findSettingsConflicts(
	{ packages: configured },
	bundledPackageNames(),
	EXCLUDED_PACKAGES,
);

if (conflicts.length === 0) {
	ok(`no bundled plugin is also listed in ${settingsPath}`);
} else {
	// A duplicate is fatal, not cosmetic: pi resolves both copies and then
	// rejects every duplicate with `Tool "x" conflicts with ...`, aborting startup.
	problem(
		`${conflicts.length} bundled plugin(s) are also listed in ${settingsPath}; ` +
			"pi would abort startup with tool-conflict errors",
	);
	for (const { name } of conflicts) {
		console.log(`      · ${name}${EXCLUDED_PACKAGES.includes(name) ? " (excluded plugin)" : ""}`);
	}
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
