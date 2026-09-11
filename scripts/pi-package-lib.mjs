/**
 * Shared helpers for the samrito-pi-preset scripts.
 *
 * These mirror pi's own package resolution (dist/core/package-manager.js and
 * dist/core/extensions/loader.js) so the scripts report exactly what pi loads.
 *
 * Two resolution layers matter, and they are NOT the same:
 *
 *   resolveExtensionEntries(dir)   [package manager, per plugin root]
 *     1. dir/package.json -> pi.extensions[] -> each entry resolved, if it exists
 *     2. dir/index.ts, dir/index.js
 *     3. nothing
 *
 *   ...and the loader then imports each returned path directly. A *directory*
 *   returned here is passed to jiti and fails ("Cannot find module"). This is
 *   why `pi.extensions` entries must be expanded to concrete files using
 *   collectExtensionFiles() before being written to a bundle manifest.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Directory containing this file. */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** Package root (parent of scripts/). */
export const PACKAGE_ROOT = resolve(LIB_DIR, "..");

/** Plugin packages deliberately left out of this bundle. Currently none. */
export const EXCLUDED_PACKAGES = [];

export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Resolve the pi agent dir, honouring PI_CODING_AGENT_DIR exactly like pi does. */
export function resolveAgentDir(override) {
	if (override) return expandTilde(override);
	const fromEnv = process.env[PI_AGENT_DIR_ENV];
	if (fromEnv) return expandTilde(fromEnv);
	return join(homedir(), ".pi", "agent");
}

export function expandTilde(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
	} catch (error) {
		if (error && error.code === "ENOENT") return undefined;
		throw new Error(`Failed to parse ${path}: ${error.message}`);
	}
}

export function readPackageJson(root = PACKAGE_ROOT) {
	const manifest = readJson(join(root, "package.json"));
	if (!manifest) throw new Error(`No package.json found in ${root}`);
	return manifest;
}

/** npm dependency names declared by this bundle, in declaration order. */
export function bundledPackageNames(root = PACKAGE_ROOT) {
	return Object.keys(readPackageJson(root).dependencies ?? {});
}

/** `pi.extensions` entries declared by this bundle. */
export function manifestExtensionEntries(root = PACKAGE_ROOT) {
	const entries = readPackageJson(root).pi?.extensions;
	return Array.isArray(entries) ? entries : [];
}

function isExtensionFile(name) {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/** Mirror of pi's resolveExtensionEntries(). Returns null when nothing resolves. */
export function resolveExtensionEntries(dir) {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const declared = readJson(packageJsonPath)?.pi?.extensions;
		if (Array.isArray(declared) && declared.length > 0) {
			const resolved = declared
				.filter((entry) => typeof entry === "string")
				.map((entry) => resolve(dir, entry))
				.filter((entry) => existsSync(entry));
			if (resolved.length > 0) return resolved;
		}
	}
	for (const candidate of ["index.ts", "index.js"]) {
		const candidatePath = join(dir, candidate);
		if (existsSync(candidatePath)) return [candidatePath];
	}
	return null;
}

/** Mirror of pi's collectAutoExtensionEntries(). */
export function collectAutoExtensionEntries(dir) {
	const entries = [];
	if (!existsSync(dir)) return entries;

	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) return rootEntries;

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = join(dir, entry.name);
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(fullPath);
				isDir = stats.isDirectory();
				isFile = stats.isFile();
			} catch {
				continue;
			}
		}
		if (isFile && isExtensionFile(entry.name)) {
			entries.push(fullPath);
		} else if (isDir) {
			const resolved = resolveExtensionEntries(fullPath);
			if (resolved) entries.push(...resolved);
		}
	}
	return entries;
}

/**
 * Expand a plugin root (or any entry path) into the concrete extension files pi
 * will import.
 *
 * The loader cannot import a directory, so a plugin root that declares a
 * directory in its own manifest (pi-zentui declares "./extensions") must be
 * expanded one level further. Everything returned here is a file.
 */
export function collectExtensionFiles(entryPath) {
	if (!existsSync(entryPath)) return [];
	if (statSync(entryPath).isFile()) return [entryPath];

	// Plugin root or resource dir: honour its own manifest first.
	const resolved = resolveExtensionEntries(entryPath);
	if (resolved) {
		return resolved.flatMap((candidate) =>
			statSync(candidate).isDirectory() ? collectExtensionFiles(candidate) : [candidate],
		);
	}
	return collectAutoExtensionEntries(entryPath);
}

/**
 * Bundled plugin names that are also present in a settings.json `packages`
 * array. Returns [{ name, entry }].
 *
 * This must be treated as an error, not a cosmetic overlap: pi resolves both
 * copies, then rejects every duplicate extension at load time with
 * `Tool "x" conflicts with ...` and aborts startup (exit 1).
 */
export function findSettingsConflicts(settings, bundledNames, excludedNames) {
	const packages = Array.isArray(settings?.packages) ? settings.packages : [];
	const interesting = new Set([...bundledNames, ...excludedNames]);
	const conflicts = [];
	for (const entry of packages) {
		const name = packageEntryNpmName(entry);
		if (name && interesting.has(name)) {
			conflicts.push({ name, entry });
		}
	}
	return conflicts;
}

/** Remove bundled plugin entries from a `packages` array. */
export function withoutSettingsConflicts(packages, bundledNames, excludedNames) {
	const interesting = new Set([...bundledNames, ...excludedNames]);
	return packages.filter((entry) => {
		const name = packageEntryNpmName(entry);
		return !(name && interesting.has(name));
	});
}

/** Parse an npm spec the way pi does. */
export function parseNpmSpec(spec) {
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	if (!match) return { name: spec };
	return { name: match[1] ?? spec, version: match[2] };
}

/** Normalise a settings `packages` entry to its npm name, or undefined. */
export function packageEntryNpmName(entry) {
	const source = typeof entry === "string" ? entry : entry?.source;
	if (typeof source !== "string") return undefined;
	const trimmed = source.trim();
	if (!trimmed || trimmed.startsWith("git:") || trimmed.startsWith("http")) return undefined;
	if (trimmed.startsWith("npm:")) return parseNpmSpec(trimmed.slice(4).trim()).name;
	if (/^(@?[^@/\s]+\/)?[^@/\s]+$/.test(trimmed)) return trimmed;
	return undefined;
}

export function packageEntrySource(entry) {
	return typeof entry === "string" ? entry : entry?.source;
}

export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function directorySize(dir) {
	if (!existsSync(dir)) return 0;
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			total += directorySize(fullPath);
		} else if (entry.isFile()) {
			try {
				total += statSync(fullPath).size;
			} catch {
				// ignore unreadable files
			}
		}
	}
	return total;
}

export function relativeToPackage(path) {
	return relative(PACKAGE_ROOT, path);
}
