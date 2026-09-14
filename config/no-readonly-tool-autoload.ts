/**
 * no-readonly-tool-autoload
 *
 * Keeps `grep`, `find` and `ls` out of the active tool set unless *you* asked for them.
 *
 * Why: @nguyenquangthai/pi-omp-theme calls `pi.setActiveTools()` on `session_start` to force
 * the `grep`/`find`/`ls` read-only tools on, gated by its `pi-omp-theme-readonly-tools` flag
 * (default `true`). That flag cannot be turned off: pi's `applyExtensionFlagValues()` writes
 * `true` for every boolean extension flag, and pi has no `--no-<extension-flag>` form.
 *
 * Pi's own default tool surface is `read`, `bash`, `edit`, `write` (`dist/core/system-prompt.js`,
 * `dist/core/sdk.js`). The extra read-only tools are opt-in "through tool options"
 * (`docs/quickstart.md`). While they are active, pi also stops emitting its
 * "Use bash for file operations like ls, rg, find" guideline, because bash now competes with
 * dedicated tools for the same work.
 *
 * Behaviour:
 *  - The tool set present at `session_start` is treated as the user's explicit choice
 *    (`defaultTools` in settings.json, or `--tools` on the command line).
 *  - If it already contains grep/find/ls, this extension does nothing.
 *  - Otherwise the tools are removed from the active set in the first `before_agent_start` of the
 *    session, i.e. right after omp-theme injected them. Later, manual enabling (e.g. `/tools`) sticks.
 *
 * Note on the hook: `agent_start` is too late. pi-agent-core's `runAgentLoop()` snapshots the tool
 * list (`createContextSnapshot()` -> `_state.tools`) *before* emitting `agent_start`, so a change made
 * there never reaches the request. `before_agent_start` runs before `_runAgentPrompt()` takes that
 * snapshot, and `setActiveTools()` also rebuilds the base system prompt for the turn.
 *
 * Removing this file restores the package's original behaviour.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUTO_LOADED_TOOLS = ["grep", "find", "ls"] as const;

export default function (pi: ExtensionAPI) {
  const drop = new Set<string>(AUTO_LOADED_TOOLS);
  const debug = process.env.PI_OMP_READONLY_OPTOUT_DEBUG === "1";

  // Set on session_start, consumed by the first before_agent_start of that session.
  let armed = false;
  // True when the user explicitly opted into these tools.
  let optedIn = false;

  const log = (message: string) => {
    if (debug) console.error(`[no-readonly-tool-autoload] ${message}`);
  };

  pi.on("session_start", () => {
    // This handler runs before the theme package's session_start handler
    // (local auto-discovered extensions outrank package extensions), so the
    // active set here is still pi's own initial selection.
    const initial = pi.getActiveTools();
    optedIn = initial.some((name) => drop.has(name));
    armed = true;
    log(`session_start: initial=[${initial.join(",")}] optedIn=${optedIn}`);
  });

  pi.on("before_agent_start", () => {
    if (!armed) return;
    armed = false;

    const current = pi.getActiveTools();
    const injected = current.filter((name) => drop.has(name));

    if (optedIn) {
      log(`before_agent_start: opted in, leaving [${injected.join(",")}] active`);
      return;
    }
    if (injected.length === 0) {
      log("before_agent_start: nothing to remove");
      return;
    }

    const next = current.filter((name) => !drop.has(name));
    pi.setActiveTools(next);
    log(`before_agent_start: removed [${injected.join(",")}] -> [${next.join(",")}]`);
  });
}
