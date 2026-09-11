/**
 * /preset — apply this package's config templates to the pi agent dir.
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
 * the pi agent dir that pi-zentui and pi-tool-display read at startup. Nothing
 * is written unless the user asks for it.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Package root: this file lives in <root>/extensions/. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface PresetFile {
	/** Stable id used on the command line. */
	id: string;
	/** Where the template lives inside this package. */
	template: string;
	/** Destination, resolved against the pi agent dir at run time. */
	target: (agentDir: string) => string;
	/** Which extension consumes it. */
	owner: string;
}

const PRESET_FILES: PresetFile[] = [
	{
		id: "zentui",
		template: join(PACKAGE_ROOT, "config", "zentui.json"),
		target: (agentDir) => join(agentDir, "zentui.json"),
		owner: "pi-zentui",
	},
	{
		id: "tool-display",
		template: join(PACKAGE_ROOT, "config", "pi-tool-display.config.json"),
		target: (agentDir) => join(agentDir, "extensions", "pi-tool-display", "config.json"),
		owner: "pi-tool-display",
	},
];

type FileState = "missing" | "identical" | "differs" | "no-template";

function stateOf(file: PresetFile, agentDir: string): FileState {
	if (!existsSync(file.template)) return "no-template";
	const target = file.target(agentDir);
	if (!existsSync(target)) return "missing";
	try {
		return readFileSync(file.template, "utf-8") === readFileSync(target, "utf-8") ? "identical" : "differs";
	} catch {
		return "differs";
	}
}

function shortPath(path: string): string {
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function statusLine(file: PresetFile, agentDir: string): string {
	const state = stateOf(file, agentDir);
	const suffix =
		state === "missing"
			? "not present — will be created"
			: state === "identical"
				? "up to date"
				: state === "differs"
					? "differs from template — only replaced with --force"
					: "template missing from package";
	return `${state.padEnd(11)} ${file.id.padEnd(13)} ${relative(PACKAGE_ROOT, file.template)}`;
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
	if (state === "differs" && !force) return { id: file.id, action: "kept", target };

	try {
		mkdirSync(dirname(target), { recursive: true });
		let backup: string | undefined;
		if (existsSync(target)) {
			backup = `${target}.bak`;
			copyFileSync(target, backup);
		}
		copyFileSync(file.template, target);
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
			const detail = result.error ? ` — ${result.error}` : result.backup ? ` — backup ${shortPath(result.backup)}` : "";
			return `${ACTION_TEXT[result.action]} ${result.id}${detail}`;
		})
		.join("\n");
}

const USAGE = [
	"/preset                 show status, then ask which configs to apply",
	"/preset status          show status only",
	"/preset apply           write configs that are missing (never overwrites)",
	"/preset apply --force   write all configs, backing up what exists",
	"/preset help            this message",
].join("\n");

async function runStatus(ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
	const lines = PRESET_FILES.map((file) => statusLine(file, agentDir));
	const pending = PRESET_FILES.filter((file) => stateOf(file, agentDir) === "missing").length;
	ctx.ui.notify(`agent dir: ${shortPath(agentDir)}\n${lines.join("\n")}\n\n${USAGE}`, "info");
	if (pending === 0) ctx.ui.notify("preset: all configs already present", "info");
}

async function runInteractive(ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
	const missing = PRESET_FILES.filter((file) => stateOf(file, agentDir) === "missing");
	const differing = PRESET_FILES.filter((file) => stateOf(file, agentDir) === "differs");
	const identical = PRESET_FILES.length - missing.length - differing.length;

	const summary = [
		`${identical} up to date, ${missing.length} missing, ${differing.length} different`,
		...PRESET_FILES.map((file) => statusLine(file, agentDir)),
	].join("\n");

	if (missing.length === 0 && differing.length === 0) {
		ctx.ui.notify(`preset: nothing to do — all configs already applied\n${summary}`, "info");
		return;
	}

	const choices: string[] = [];
	const missingChoice = `Apply ${missing.length} missing config${missing.length === 1 ? "" : "s"}`;
	const forceChoice = `Apply all and overwrite ${differing.length} existing file${differing.length === 1 ? "" : "s"} (keeps .bak)`;
	if (missing.length > 0) choices.push(missingChoice);
	if (differing.length > 0) choices.push(forceChoice);
	choices.push("Cancel");

	const answer = await ctx.ui.select(`preset: ${summary}`, choices);
	if (!answer || answer === "Cancel") {
		ctx.ui.notify("preset: cancelled", "info");
		return;
	}

	const results: ApplyResult[] = [];
	const force = answer === forceChoice;
	for (const file of PRESET_FILES) {
		const state = stateOf(file, agentDir);
		if (state === "identical" || state === "no-template") continue;
		if (state === "differs" && !force) continue;
		results.push(applyFile(file, agentDir, force));
	}

	ctx.ui.notify(`preset:\n${summarize(results)}`, results.some((r) => r.action === "failed") ? "error" : "info");
	if (force) ctx.ui.notify("preset: restart pi to pick up the new configs", "info");
}

export default function (pi: ExtensionAPI): void {
	const parseArgs = (args: string) => args.trim().split(/\s+/).filter(Boolean);

	pi.registerCommand("preset", {
		description: "Apply this package's config templates (zentui, tool display) to the pi agent dir",
		getArgumentCompletions: (prefix) => {
			const options = ["status", "apply", "apply --force", "help"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const agentDir = getAgentDir();
			const [subcommand, ...rest] = parseArgs(args);
			const force = rest.includes("--force") || subcommand === "force";

			try {
				if (subcommand === "help") {
					ctx.ui.notify(USAGE, "info");
					return;
				}
				if (subcommand === "status") {
					await runStatus(ctx, agentDir);
					return;
				}
				if (subcommand === "apply" || subcommand === "force") {
					const results = PRESET_FILES.map((file) => applyFile(file, agentDir, force));
					ctx.ui.notify(
						`preset:\n${summarize(results)}`,
						results.some((result) => result.action === "failed") ? "error" : "info",
					);
					return;
				}
				if (subcommand !== undefined) {
					ctx.ui.notify(`preset: unknown argument "${subcommand}"\n${USAGE}`, "warning");
					return;
				}
				if (!ctx.hasUI) {
					await runStatus(ctx, agentDir);
					return;
				}
				await runInteractive(ctx, agentDir);
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
			const pending = PRESET_FILES.filter((file) => stateOf(file, agentDir) === "missing");
			if (pending.length === 0) return;
			ctx.ui.notify(
				`preset: ${pending.map((file) => file.id).join(", ")} not applied yet — run /preset`,
				"info",
			);
		});
	}
}
