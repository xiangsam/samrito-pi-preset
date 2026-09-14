#!/usr/bin/env node
/**
 * Regenerate the `pi` manifest in package.json from the installed plugin tree.
 *
 * Why this exists:
 *
 *   1. pi's loader imports each `pi.extensions` path directly and cannot import
 *      a directory, so every plugin must be expanded to its concrete entry
 *      files. Several plugins declare a directory in their OWN manifest
 *      (pi-zentui did, pi-omp-theme declares "./themes"), and pi passes such
 *      entries through verbatim.
 *   2. Declaring a `pi` manifest disables convention-directory discovery for
 *      every resource type, so bundled themes must be re-declared in
 *      `pi.themes` — a plugin's themes are otherwise silently never loaded.
 *   3. This package's own `extensions/` directory holds `/preset`, which is why
 *      it is scanned too: an unlisted own extension would silently never load.
 *
 * Run after upgrading plugin versions:
 *   node scripts/sync-manifest.mjs          # rewrite package.json
 *   node scripts/sync-manifest.mjs --check  # exit 1 if drift (used by verify)
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_RESOURCE_TYPES, PACKAGE_ROOT, buildPiManifest, manifestDrift, readPackageJson } from "./pi-package-lib.mjs";

const checkOnly = process.argv.includes("--check");
const { expected, stale } = manifestDrift();
const total = BUNDLED_RESOURCE_TYPES.reduce((sum, type) => sum + expected[type].length, 0);

const report = () => {
	for (const type of BUNDLED_RESOURCE_TYPES) {
		console.log(`  pi.${type} (${expected[type].length})`);
	}
	for (const type of BUNDLED_RESOURCE_TYPES) {
		for (const entry of expected[type]) console.log(`    ${entry}`);
	}
};

if (stale.length === 0) {
	console.log(`pi manifest is up to date (${total} entries).`);
	process.exit(0);
}

if (checkOnly) {
	console.error(`pi manifest is stale: ${stale.map((type) => `pi.${type}`).join(", ")}`);
	report();
	console.error("Run: node scripts/sync-manifest.mjs");
	process.exit(1);
}

const manifest = readPackageJson();
manifest.pi = { ...manifest.pi, extensions: expected.extensions, themes: expected.themes };
writeFileSync(join(PACKAGE_ROOT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

console.log(`Wrote ${total} pi manifest entries:`);
report();
