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
 *
 * Themes take a different path: there is no index/autodiscovery convention, a
 * plugin only contributes themes through its own `pi.themes` entry. Since pi
 * stops convention-directory discovery for *every* resource type as soon as a
 * package declares a `pi` manifest, bundled themes must be re-declared here in
 * `pi.themes` or they are silently never loaded.
 *
 * The last layer in this file is the opposite direction: pi's `packages[]`
 * filter syntax (`-relative/path` to force-exclude, `+relative/path` to
 * force-include), which is how /preset disables a single bundled plugin without
 * unpublishing it. Both the scripts and the runtime extension import this module
 * so the filter writer and the filter reader cannot drift apart.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/** `pi.themes` entries declared by this bundle. */
export function manifestThemeEntries(root = PACKAGE_ROOT) {
	const entries = readPackageJson(root).pi?.themes;
	return Array.isArray(entries) ? entries : [];
}

function isExtensionFile(name) {
	return name.endsWith(".ts") || name.endsWith(".js");
}

function isThemeFile(name) {
	return name.endsWith(".json");
}

/** POSIX-separated path relative to `root` (pi's filter/manifest separators). */
export function posixRelative(root, path) {
	return relative(root, path).split(sep).join("/");
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
 * Expand a plugin root into the concrete theme files pi will load.
 *
 * Unlike extensions there is no index/autodiscovery convention: a plugin only
 * contributes themes through its own `pi.themes` entry, and a directory entry
 * is expanded to the `.json` files inside it.
 */
export function collectThemeFiles(entryPath) {
	if (!existsSync(entryPath)) return [];
	if (statSync(entryPath).isFile()) return isThemeFile(entryPath) ? [entryPath] : [];

	const declared = readJson(join(entryPath, "package.json"))?.pi?.themes;
	if (!Array.isArray(declared)) return [];

	const files = [];
	for (const entry of declared) {
		if (typeof entry !== "string") continue;
		const resolved = resolve(entryPath, entry);
		if (!existsSync(resolved)) continue;
		if (statSync(resolved).isDirectory()) files.push(...collectJsonFiles(resolved));
		else if (isThemeFile(resolved)) files.push(resolved);
	}
	return files;
}

function collectJsonFiles(dir) {
	const files = [];
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
		if (isFile && isThemeFile(entry.name)) files.push(fullPath);
		else if (isDir) files.push(...collectJsonFiles(fullPath));
	}
	return files;
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

/**
 * Locate pi's ESM entry point so its own package manager and loader can be
 * imported. Returns undefined when pi is not installed.
 *
 * Set PI_MODULE_PATH to point at pi explicitly; otherwise `pi` is looked up on
 * PATH and its package root walked up to.
 */
export function findPiModule() {
	const override = process.env.PI_MODULE_PATH;
	if (override && existsSync(override)) return override;

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

// ---------------------------------------------------------------------------
// Bundled plugin inventory
// ---------------------------------------------------------------------------

/** Resource types this bundle re-declares from its own node_modules tree. */
export const BUNDLED_RESOURCE_TYPES = ["extensions", "themes"];

/**
 * Every bundled plugin with the concrete files it contributes, as paths
 * relative to the package root in POSIX form — the same shape pi's manifest
 * entries and `packages[]` filters use.
 *
 * This one inventory feeds three consumers: `sync-manifest.mjs` (generate
 * `pi.extensions`/`pi.themes`), `/preset list|remove|add` (per-plugin
 * filters) and `verify.mjs` (prove the two agree).
 */
export function bundledPlugins(root = PACKAGE_ROOT) {
	return bundledPackageNames(root).map((name) => {
		const pluginRoot = join(root, "node_modules", name);
		return {
			name,
			root: pluginRoot,
			extensions: collectExtensionFiles(pluginRoot).map((file) => posixRelative(root, file)),
			themes: collectThemeFiles(pluginRoot).map((file) => posixRelative(root, file)),
		};
	});
}

/** This bundle's own extension files (the `/preset` command). */
export function ownExtensionFiles(root = PACKAGE_ROOT) {
	return collectExtensionFiles(join(root, "extensions")).map((file) => posixRelative(root, file));
}

/**
 * The full `pi` resource manifest for this bundle.
 *
 * A package that declares a `pi` manifest gets nothing from convention
 * directories, so `pi.extensions` must also list this package's own
 * `extensions/` files and `pi.themes` must list the bundled themes.
 */
export function buildPiManifest(root = PACKAGE_ROOT) {
	const manifest = { extensions: ownExtensionFiles(root), themes: [] };
	for (const plugin of bundledPlugins(root)) {
		manifest.extensions.push(...plugin.extensions);
		manifest.themes.push(...plugin.themes);
	}
	manifest.extensions.sort();
	manifest.themes.sort();
	return manifest;
}

/** Compare a generated manifest against the one in package.json. */
export function manifestDrift(root = PACKAGE_ROOT) {
	const expected = buildPiManifest(root);
	const current = {
		extensions: manifestExtensionEntries(root),
		themes: manifestThemeEntries(root),
	};
	const stale = [];
	for (const type of BUNDLED_RESOURCE_TYPES) {
		const same =
			current[type].length === expected[type].length &&
			current[type].every((entry, index) => entry === expected[type][index]);
		if (!same) stale.push(type);
	}
	return { expected, current, stale };
}

// ---------------------------------------------------------------------------
// Package filters: settings.json `packages[].extensions` / `.themes`
// ---------------------------------------------------------------------------

/**
 * Locate the `packages[]` entry that registers this package.
 *
 * Installs look different depending on how pi was asked to install the preset:
 * `npm:samrito-pi-preset` (registry), a bare name, or an absolute/relative path
 * pointing at this very directory.
 */
export function findOwnPackageEntry(packages, root = PACKAGE_ROOT) {
	const ownName = readPackageJson(root).name;
	const list = Array.isArray(packages) ? packages : [];
	const ownRealPath = realpathOrUndefined(root);

	for (let index = 0; index < list.length; index += 1) {
		const entry = list[index];
		const source = packageEntrySource(entry);
		if (typeof source !== "string") continue;

		if (ownName && packageEntryNpmName(entry) === ownName) {
			return { index, entry, source };
		}
		if (source.startsWith("npm:")) continue;

		const candidate = resolveLocalSource(source, resolve(root, ".."));
		if (candidate && ownRealPath && realpathOrUndefined(candidate) === ownRealPath) {
			return { index, entry, source };
		}
	}
	return undefined;
}

function realpathOrUndefined(path) {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function resolveLocalSource(source, base) {
	if (!source || /^[a-z+]+:/i.test(source)) return undefined;
	const expanded = expandTilde(source);
	return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/** The filter patterns configured for one resource type, or undefined. */
export function filterPaths(entry, resourceType) {
	const value = typeof entry === "object" && entry !== null ? entry[resourceType] : undefined;
	return Array.isArray(value) ? value : undefined;
}

function stripPrefix(pattern) {
	return pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-")
		? pattern.slice(1)
		: pattern;
}

function isExactPattern(pattern) {
	return !/[*?[\]{}]/.test(stripPrefix(pattern));
}

/**
 * Add and/or drop exact `-relative/path` exclusions, mirroring what pi's own
 * `pi config` writes (it replaces any previous pattern for the same path).
 */
export function withPathFilters(patterns, { add = [], drop = [] } = {}) {
	const dropSet = new Set(drop);
	const next = (patterns ?? []).filter((pattern) => !dropSet.has(stripPrefix(pattern)));
	for (const path of add) {
		next.push(`-${path}`);
	}
	return next;
}

/**
 * Per-resource-type load state for one plugin: does pi still load its files?
 *
 *   "loading"  — the filter does not exclude them
 *   "disabled" — every file is excluded
 *   "partial"  — a hand-edited filter excludes some files, or the answer cannot
 *                be decided here (a glob or bare positive pattern, which pi
 *                evaluates with minimatch against pi's own file list)
 *
 * Exact `-`/`+` patterns — everything `pi config` and `/preset` write — are
 * matched literally. pi applies force-excludes after force-includes, so `-path`
 * wins whenever both exist for the same path.
 */
export function pluginResourceState(entry, resourceType, paths) {
	if (paths.length === 0) return "loading";
	const patterns = filterPaths(entry, resourceType);
	if (patterns === undefined) return "loading";
	if (patterns.length === 0) return "disabled";

	const forceExcludes = new Set();
	const forceIncludes = new Set();
	let undecidable = false;

	for (const pattern of patterns) {
		if (!isExactPattern(pattern)) {
			undecidable = true;
			continue;
		}
		const value = stripPrefix(pattern);
		if (pattern.startsWith("-")) forceExcludes.add(value);
		else if (pattern.startsWith("+")) forceIncludes.add(value);
		else undecidable = true; // `!path` and bare entries narrow pi's file list
	}

	let enabled = 0;
	for (const path of paths) {
		if (forceExcludes.has(path)) continue;
		if (forceIncludes.has(path) || !undecidable) enabled += 1;
	}

	if (enabled === paths.length) return "loading";
	if (enabled === 0 && !undecidable) return "disabled";
	return undecidable ? "partial" : "disabled";
}

/** Overall state of a plugin across every resource type it contributes. */
export function pluginState(entry, plugin) {
	const states = BUNDLED_RESOURCE_TYPES.filter((type) => (plugin[type] ?? []).length > 0).map((type) =>
		pluginResourceState(entry, type, plugin[type]),
	);
	if (states.length === 0) return "loading";
	if (states.every((state) => state === "disabled")) return "disabled";
	if (states.some((state) => state !== "loading")) return "partial";
	return "loading";
}

/**
 * Rewrite the `packages` array so `names` are enabled or disabled.
 *
 * Pure on purpose: `/preset remove` and `/preset add` are thin wrappers around
 * it, and `verify.mjs` exercises the same function to prove that what gets
 * written is what pi's resolver reads back. Returns the new array plus what
 * changed; throws on an unknown plugin name or a missing entry.
 */
export function applyPluginFilter({ packages, names, enabled, root = PACKAGE_ROOT }) {
	const plugins = bundledPlugins(root);
	const byName = new Map();
	for (const plugin of plugins) {
		byName.set(plugin.name, plugin);
		const bare = plugin.name.split("/").pop();
		if (!byName.has(bare)) byName.set(bare, plugin);
	}

	const ownFiles = new Set(ownExtensionFiles(root));
	const targets = [];
	for (const raw of names) {
		const name = String(raw).trim();
		if (!name) continue;
		if (ownFiles.has(name) || name === "preset" || name.endsWith("extensions/preset.ts")) {
			throw new Error(`${name} is this package's own /preset command and cannot be removed`);
		}
		const plugin = byName.get(name) ?? byName.get(name.split("/").pop());
		if (!plugin) {
			throw new Error(
				`unknown plugin "${name}" — bundled plugins: ${plugins.map((p) => p.name).join(", ")}`,
			);
		}
		targets.push(plugin);
	}
	if (targets.length === 0) throw new Error("no plugin name given");

	// A filter for files that do not exist would silently look like success while
	// pi keeps loading the plugin (the paths never match), so refuse instead.
	const fileCount = targets.reduce(
		(sum, plugin) => sum + BUNDLED_RESOURCE_TYPES.reduce((n, type) => n + (plugin[type]?.length ?? 0), 0),
		0,
	);
	if (fileCount === 0) {
		throw new Error(
			`no resource files found for ${targets.map((plugin) => plugin.name).join(", ")} — ` +
				`node_modules looks incomplete; run: cd ${root} && npm install --omit=dev --legacy-peer-deps`,
		);
	}

	const found = findOwnPackageEntry(packages, root);
	if (!found) {
		throw new Error(
			`settings.json has no packages[] entry for ${readPackageJson(root).name}; ` +
				"install the preset first (pi install npm:" +
				readPackageJson(root).name +
				")",
		);
	}

	const nextEntry = typeof found.entry === "string" ? { source: found.entry } : { ...found.entry };
	const changes = [];
	for (const type of BUNDLED_RESOURCE_TYPES) {
		const files = targets.flatMap((plugin) => plugin[type] ?? []);
		if (files.length === 0) continue;
		const current = filterPaths(nextEntry, type);
		const updated = enabled
			? withPathFilters(current, { drop: files })
			: withPathFilters(current, { add: files });
		if (updated.length === 0) delete nextEntry[type];
		else nextEntry[type] = updated;
		changes.push({ type, files: files.length, enabled });
	}

	// Collapse back to the string form once nothing is filtered: an object entry
	// with no filter keys means exactly the same thing and is what pi writes.
	const hasFilter = BUNDLED_RESOURCE_TYPES.some((type) => nextEntry[type] !== undefined);
	const nextPackages = [...packages];
	nextPackages[found.index] = hasFilter ? nextEntry : found.source;

	return { packages: nextPackages, changes, changed: hasFilter, entry: nextPackages[found.index] };
}

/** Plugins this package's settings entry currently disables. */
export function disabledPlugins(packages, root = PACKAGE_ROOT) {
	const found = findOwnPackageEntry(packages, root);
	if (!found) return [];
	return bundledPlugins(root)
		.filter((plugin) => pluginState(found.entry, plugin) === "disabled")
		.map((plugin) => plugin.name);
}
