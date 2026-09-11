#!/usr/bin/env node
/**
 * Regenerate `pi.extensions` in package.json from this package's own
 * `extensions/` directory plus the installed plugin tree.
 *
 * Why this exists: pi's loader imports each `pi.extensions` path directly and
 * cannot import a directory. Several plugins declare a directory in their OWN
 * manifest (pi-zentui declares "./extensions"), and pi passes such entries
 * through verbatim. Listing plugin roots here is therefore not safe, so this
 * script expands every plugin to the concrete entry files pi must import.
 *
 * This package's own `extensions/` directory holds `/preset`, which is why it
 * is scanned too: declaring pi.extensions disables convention-directory
 * discovery, so an unlisted own extension would silently never load.
 *
 * Run after upgrading plugin versions:
 *   node scripts/sync-manifest.mjs          # rewrite package.json
 *   node scripts/sync-manifest.mjs --check  # exit 1 if drift (used by verify)
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PACKAGE_ROOT,
	bundledPackageNames,
	collectExtensionFiles,
	manifestExtensionEntries,
	readPackageJson,
	relativeToPackage,
} from "./pi-package-lib.mjs";

const checkOnly = process.argv.includes("--check");

const manifest = readPackageJson();
const current = manifestExtensionEntries();
const next = [];

// This package's own extensions first (e.g. the /preset command).
for (const file of collectExtensionFiles(join(PACKAGE_ROOT, "extensions"))) {
	next.push(relativeToPackage(file));
}

for (const name of bundledPackageNames()) {
	const root = join(PACKAGE_ROOT, "node_modules", name);
	const files = collectExtensionFiles(root).map((file) => relativeToPackage(file));
	if (files.length === 0) {
		console.error(`! ${name}: no extension files found (is it installed?)`);
		process.exitCode = 1;
		continue;
	}
	next.push(...files);
}

next.sort();

if (checkOnly) {
	const same = current.length === next.length && current.every((entry, index) => entry === next[index]);
	if (same) {
		console.log(`pi.extensions is up to date (${next.length} entries).`);
	} else {
		console.error("pi.extensions is stale. Expected:");
		for (const entry of next) console.error(`  ${entry}`);
		console.error("Run: node scripts/sync-manifest.mjs");
		process.exitCode = 1;
	}
} else {
	manifest.pi = { ...manifest.pi, extensions: next };
	writeFileSync(join(PACKAGE_ROOT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
	console.log(`Wrote ${next.length} pi.extensions entries:`);
	for (const entry of next) console.log(`  ${entry}`);
}
