#!/usr/bin/env node
/**
 * Verify the *published artifact*, not the source tree.
 *
 * `verify.mjs` checks the checkout: its `node_modules/` is a normal npm tree
 * where hoisting is allowed. What users actually receive is the packed tarball,
 * where `bundledDependencies` must have embedded every plugin *inside* the
 * package root, because pi resolves each `pi.extensions` entry relative to that
 * root. A drift between `dependencies` and `bundledDependencies`, or a plugin
 * that npm decides not to bundle, breaks only the tarball — the source tree
 * still looks perfect.
 *
 * So this script reproduces the real delivery path:
 *   1. `npm pack`            (runs prepack -> sync-manifest --check)
 *   2. `npm install <tgz>`   into a throwaway prefix, like pi does
 *   3. resolve + load through pi's own DefaultPackageManager / loadExtensions
 *
 * Usage:
 *   node scripts/verify-tarball.mjs [--verbose] [--keep]
 *
 * Exits 1 on any failure. Skips (exit 0, with a note) when pi cannot be found,
 * matching verify.mjs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
	PACKAGE_ROOT,
	findPiModule,
	manifestExtensionEntries,
	manifestThemeEntries,
	readPackageJson,
} from "./pi-package-lib.mjs";

const verbose = process.argv.includes("--verbose");
const keep = process.argv.includes("--keep");
const problems = [];

const ok = (message) => console.log(`  \u001b[32m✓\u001b[0m ${message}`);
const note = (message) => console.log(`  \u001b[33m!\u001b[0m ${message}`);
const heading = (title) => console.log(`\n\u001b[1m${title}\u001b[0m`);

function problem(message) {
	problems.push(message);
	console.log(`  \u001b[31m✗\u001b[0m ${message}`);
}

const npm = process.env.PI_NPM_COMMAND ?? "npm";
const manifest = readPackageJson();
const declared = manifestExtensionEntries();
const declaredThemes = manifestThemeEntries();
const workDir = mkdtempSync(join(tmpdir(), "pi-tarball-"));

/** Thrown after a problem() call so the report is not duplicated in the catch. */
class AlreadyReported extends Error {}

/** npm pack/install can fail for reasons the output already explains. */
function run(command, args, options = {}) {
	try {
		return execFileSync(command, args, { encoding: "utf-8", ...options });
	} catch (error) {
		problem(`${command} ${args[0]} failed: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
		throw new AlreadyReported("command failed");
	}
}

try {
	// ------------------------------------------------------------- 1. pack

	heading("1. npm pack");

	const packOutput = run(npm, ["pack", "--silent", "--pack-destination", workDir], { cwd: PACKAGE_ROOT }).trim();
	const archiveName = packOutput.split("\n").filter(Boolean).pop() ?? "";
	const tarball = join(workDir, archiveName);
	if (!archiveName || !existsSync(tarball)) {
		problem(`npm pack did not produce a tarball (output: ${packOutput || "empty"})`);
		throw new AlreadyReported("pack failed");
	}
	ok(`${archiveName} (${(statSync(tarball).size / 1024 / 1024).toFixed(1)} MB)`);

	// ------------------------------------------- 2. install like pi does

	heading("2. install into a throwaway prefix");

	const installRoot = join(workDir, "agent", "npm");
	run(
		npm,
		["install", tarball, "--prefix", installRoot, "--legacy-peer-deps", "--no-audit", "--no-fund"],
		{ stdio: verbose ? "inherit" : "pipe" },
	);

	const installedRoot = join(installRoot, "node_modules", manifest.name);
	if (!existsSync(installedRoot)) {
		problem(`${manifest.name} is not present in the install prefix`);
		throw new AlreadyReported("install failed");
	}
	ok(`installed to node_modules/${manifest.name}`);

	// Every bundled plugin must exist *inside* the package root: that is what
	// makes the relative pi.extensions paths resolve for an npm-installed user.
	const missing = declared.filter((entry) => !existsSync(join(installedRoot, entry)));
	if (missing.length > 0) {
		problem(`${missing.length} pi.extensions entry/entries missing from the tarball`);
		for (const entry of missing.slice(0, 10)) console.log(`      ${entry}`);
		console.log("      fix: keep `dependencies` and `bundledDependencies` in sync");
	} else {
		ok(`all ${declared.length} pi.extensions entries are contained in the tarball`);
	}

	// Bundled themes are easy to lose in a tarball: they live under a plugin's
	// assets directory, and the manifest has to list them explicitly.
	const missingThemes = declaredThemes.filter((entry) => !existsSync(join(installedRoot, entry)));
	if (missingThemes.length > 0) {
		problem(`${missingThemes.length} pi.themes entry/entries missing from the tarball`);
		for (const entry of missingThemes.slice(0, 10)) console.log(`      ${entry}`);
	} else {
		ok(`all ${declaredThemes.length} pi.themes entries are contained in the tarball`);
	}

	// ------------------------------------------------- 3. pi resolve + load

	heading("3. resolve and load through pi");

	const piModule = findPiModule();
	if (!piModule) {
		note("pi not found on PATH; skipped (set PI_MODULE_PATH to enable)");
	} else {
		const agentDir = join(workDir, "agent");
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ packages: [`npm:${manifest.name}`] }, null, 2)}\n`,
			"utf-8",
		);

		const { DefaultPackageManager, SettingsManager } = await import(pathToFileURL(piModule).href);
		const settingsManager = SettingsManager.create(installedRoot, agentDir);
		const manager = new DefaultPackageManager({
			cwd: installedRoot,
			agentDir,
			settingsManager,
		});

		const resolved = await manager.resolve();
		const extensions = resolved.extensions.filter((resource) => resource.enabled);

		if (extensions.length !== declared.length) {
			problem(`pi resolved ${extensions.length} extensions, expected ${declared.length}`);
		} else {
			ok(`pi resolved ${extensions.length} extensions from the installed tarball`);
		}

		const resolvedThemes = resolved.themes.filter((resource) => resource.enabled);
		if (resolvedThemes.length !== declaredThemes.length) {
			problem(`pi resolved ${resolvedThemes.length} themes, expected ${declaredThemes.length}`);
		} else {
			ok(`pi resolved ${resolvedThemes.length} themes from the installed tarball`);
		}

		// A path outside the package root means npm hoisted a plugin instead of
		// bundling it, which is exactly the failure this script exists to catch.
		const outside = extensions.filter((resource) => !resource.path.startsWith(installedRoot));
		if (outside.length > 0) {
			problem(`${outside.length} extension(s) resolved outside the installed package`);
			for (const resource of outside) console.log(`      ${resource.path}`);
		}

		const loader = await import(pathToFileURL(join(dirname(piModule), "core/extensions/loader.js")).href);
		const result = await loader.loadExtensions(
			extensions.map((resource) => resource.path),
			installedRoot,
		);

		for (const error of result.errors) {
			problem(`load error in ${relative(installedRoot, error.path)}: ${error.error.split("\n")[0]}`);
		}
		if (result.errors.length === 0) {
			const tools = result.extensions.reduce((total, extension) => total + extension.tools.size, 0);
			const commands = result.extensions.reduce((total, extension) => total + extension.commands.size, 0);
			ok(`all ${result.extensions.length} extensions loaded, 0 errors`);
			console.log(`  · registered: ${tools} tools, ${commands} commands`);
		}

		// The bundled /preset command has to survive packaging too; without it the
		// config templates shipped in config/ would be unreachable, and so would
		// per-plugin enable/disable.
		if (result.extensions.some((extension) => extension.commands.has("preset"))) {
			ok("/preset command is registered");
		} else {
			problem("/preset command is missing from the packaged extensions");
		}

		if (verbose) {
			for (const extension of result.extensions) {
				console.log(`      ${relative(installedRoot, extension.resolvedPath ?? extension.path)}`);
			}
		}

		// ------------------------------------------------ 4. plugin filters

		heading("4. /preset remove against an npm-installed copy");

		// The filter is written relative to the package root, so it has to keep
		// working when pi installed the package from the registry instead of
		// pointing at a checkout — that is the arrangement every user has.
		// Never `extensions/preset.ts`: /preset refuses to disable itself, so the test
		// uses a bundled plugin the command would really accept.
		const victim = declared.find((entry) => entry.startsWith("node_modules/")) ?? declared[0];
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify(
				{ packages: [{ source: `npm:${manifest.name}`, extensions: [`-${victim}`] }] },
				null,
				2,
			)}\n`,
			"utf-8",
		);

		await settingsManager.reload();
		const filtered = await manager.resolve();
		const survives = filtered.extensions.some(
			(resource) => resource.enabled && relative(installedRoot, resource.path) === victim,
		);
		if (survives) {
			problem(`pi still loads ${victim} after a -path filter, when installed from the registry`);
		} else if (filtered.extensions.filter((resource) => resource.enabled).length !== extensions.length - 1) {
			problem("a single -path filter changed the enabled extension count by more than one");
		} else {
			ok(`pi drops ${victim} and keeps the rest (npm: source, filter relative to the package root)`);
		}
	}
} catch (error) {
	if (!(error instanceof AlreadyReported)) {
		problem(`verification failed: ${error instanceof Error ? error.message : String(error)}`);
	}
} finally {
	if (keep) {
		console.log(`\n  kept: ${workDir}`);
	} else {
		rmSync(workDir, { recursive: true, force: true });
	}
}

console.log("");
if (problems.length > 0) {
	console.log(`\u001b[31m${problems.length} problem(s)\u001b[0m`);
	for (const item of problems) console.log(`  - ${item}`);
	process.exitCode = 1;
} else {
	console.log("\u001b[32mOK\u001b[0m — the packed tarball installs, resolves, and loads.");
}
