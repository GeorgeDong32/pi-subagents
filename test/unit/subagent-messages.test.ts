import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { renderSubagentEntry, renderSubagentMessage } from "../../src/tui/subagent-messages.ts";

// Markdown bodies read Pi's markdown theme, which Pi initializes at startup.
initTheme("dark");

const plainTheme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

const tokenTheme = {
	fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => `<b>${text}</b>`,
};

type TestTheme = typeof plainTheme;

function renderMessage(customType: string, details: unknown, options: { content?: string; expanded?: boolean; width?: number; theme?: TestTheme } = {}): string[] {
	const message = { customType, content: options.content ?? "", details };
	// SAFETY: the renderer reads only fg from Pi's theme.
	const component = renderSubagentMessage(message, { expanded: options.expanded ?? false }, (options.theme ?? plainTheme) as never);
	assert.ok(component, `no renderer for ${customType}`);
	return component.render(options.width ?? 100).map((line) => line.trimEnd());
}

function renderEntry(customType: string, data: unknown, options: { expanded?: boolean; width?: number; theme?: TestTheme } = {}): string[] {
	// SAFETY: the renderer reads only fg from Pi's theme.
	const component = renderSubagentEntry({ customType, data }, { expanded: options.expanded ?? false }, (options.theme ?? plainTheme) as never);
	assert.ok(component, `no renderer for ${customType}`);
	return component.render(options.width ?? 100).map((line) => line.trimEnd());
}

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripAnsi(line).trimEnd()).filter((line) => line.trim().length > 0);
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The collapsed row's headline between the dim ⎿ gutter and the hint, with theme tokens marked. */
function tokenLine(line: string | undefined): { headline: string } | undefined {
	const match = /^<dim>  ⎿  <\/dim>(.*) <dim>\((?:click|ctrl\+o|ctrl\+r) to expand\)<\/dim>$/.exec(line ?? "");
	return match ? { headline: match[1]! } : undefined;
}

function tonedHeadline(customType: string, details: unknown, content = ""): string | undefined {
	return tokenLine(renderMessage(customType, details, { content, theme: tokenTheme, width: 400 })[0])?.headline;
}

// keyText resolves Pi's expand key through the pi-tui copy that pi-coding-agent loads.
async function bindExpandKey(t: TestContext, keys: string): Promise<void> {
	const agentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	// SAFETY: this path is pi-tui's package entry, resolved from where pi-coding-agent loads it.
	const tui = await import(pathToFileURL(createRequire(agentEntry).resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
	const previous = tui.getKeybindings();
	tui.setKeybindings(new tui.KeybindingsManager({ ...tui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: keys, description: "Toggle tool output" } }));
	t.after(() => tui.setKeybindings(previous));
}

const request = { id: "request-1", requestId: "request-1", runId: "run-1", agent: "worker", childIndex: 0, expectsReply: true };
const reply = { requestId: "request-1", reason: "need_decision", runId: "run-1", agent: "worker", childIndex: 1, childTarget: "child-worker", message: "Approved; continue.", createdAt: 123 };
const watchdogWarning = { severity: "blocker", importance: "high", category: "other", source: "main", agent: "worker", summary: "Edits a migration without a backfill", evidence: "diff touches db/migrations/0042.sql", recommendedAction: "Add a reversible backfill" };

describe("subagent messages in the main chat", () => {
	it("shows a supervisor request as one CC ⎿ row", () => {
		const headline = (details: unknown) => visibleLines(renderMessage("subagent_supervisor_request", details));
		assert.deepEqual(headline({ ...request, reason: "need_decision" }), ["  ⎿  worker needs a decision (ctrl+o to expand)"]);
		assert.deepEqual(headline({ ...request, reason: "interview_request" }), ["  ⎿  worker asks for structured answers (ctrl+o to expand)"]);
		assert.deepEqual(headline({ ...request, reason: "progress_update" }), ["  ⎿  worker sent a progress update (ctrl+o to expand)"]);
		assert.deepEqual(headline(request), ["  ⎿  worker needs a decision (ctrl+o to expand)"]);
		assert.deepEqual(headline({ ...request, agent: 42 }), ["  ⎿  supervisor request (ctrl+o to expand)"]);
		assert.deepEqual(headline(undefined), ["  ⎿  supervisor request (ctrl+o to expand)"]);
	});

	it("shows attention and steering notices as one CC ⎿ row with toned status words", () => {
		const rows: Array<[string, unknown, string, string]> = [
			["subagent_control_notice", { event: { type: "needs_attention", agent: "worker", runId: "run-1", message: "stuck", ts: 1 } }, "worker needs attention", "<dim>worker </dim><warning>needs attention</warning>"],
			["subagent_control_notice", { event: { type: "active_long_running", agent: "worker", runId: "run-1", message: "slow", ts: 1 } }, "worker active long running", "<dim>worker active long running</dim>"],
			["subagent_control_notice", {}, "subagent notice", "<dim>subagent notice</dim>"],
			["subagent_steering_notice", { type: "subagent.steering.notice", ts: 1, runId: "run-1", requestId: "steer-1", state: "failed", message: "child exited" }, "steering for run run-1 failed", "<dim>steering for run run-1 </dim><error>failed</error>"],
			["subagent_steering_notice", { type: "subagent.steering.notice", ts: 1, runId: "run-1", requestId: "steer-1", state: "partial", message: "one child missed it" }, "steering for run run-1 partial", "<dim>steering for run run-1 </dim><error>partial</error>"],
			["subagent_steering_notice", { type: "subagent.steering.notice", ts: 1, runId: "run-1", requestId: "steer-1", state: "recovered", message: "delivered on retry" }, "steering for run run-1 recovered", "<dim>steering for run run-1 </dim><warning>recovered</warning>"],
			["subagent_steering_notice", { runId: "run-1", state: "lost" }, "steering notice", "<dim>steering notice</dim>"],
		];
		for (const [customType, details, text, toned] of rows) {
			assert.deepEqual(visibleLines(renderMessage(customType, details)), [`  ⎿  ${text} (ctrl+o to expand)`], customType);
			assert.equal(tonedHeadline(customType, details), toned, customType);
		}
	});

	it("shows completion notices as one CC ⎿ row, including notices saved without details", () => {
		const rows: Array<[unknown, string, string, string]> = [
			[{ runs: [{ agent: "scout", status: "completed" }] }, "", "scout completed", "<dim>scout </dim><success>completed</success>"],
			[{ runs: [{ agent: "worker", status: "failed" }] }, "", "worker failed", "<dim>worker </dim><error>failed</error>"],
			[{ runs: [{ agent: "scout", status: "completed" }, { agent: "worker", status: "failed" }, { agent: "reviewer", status: "stopped" }] }, "", "3 background runs finished · 1 failed · 1 stopped", "<dim>3 background runs finished · 1 </dim><error>failed</error><dim> · 1 </dim><warning>stopped</warning>"],
			[{ runs: [{ agent: "scout", status: "completed" }, { agent: "worker", status: "completed" }] }, "", "2 background runs completed", "<dim>2 background runs </dim><success>completed</success>"],
			[undefined, "Background task paused: **worker** (Migrate the index)\n\nNeeds a decision.", "worker paused", "<dim>worker </dim><warning>paused</warning>"],
			[undefined, "Detached foreground task completed: **reviewer**\n\nRecovered final review", "reviewer completed", "<dim>reviewer </dim><success>completed</success>"],
			[undefined, "Background tasks completed (2): **scout**, **worker**\n\n1. scout\nDone", "2 background runs finished", "<dim>2 background runs finished</dim>"],
			[undefined, "Something else", "background run finished", "<dim>background run finished</dim>"],
		];
		for (const [details, content, text, toned] of rows) {
			assert.deepEqual(visibleLines(renderMessage("subagent-notify", details, { content })), [`  ⎿  ${text} (ctrl+o to expand)`], text);
			assert.equal(tonedHeadline("subagent-notify", details, content), toned, text);
		}
	});

	it("shows reminders, bg_wait wakes, and workflow notices as one CC ⎿ row", () => {
		const rows: Array<[string, unknown, string, string, string]> = [
			["subagent-supervisor-unanswered", { requestIds: ["request-1"] }, "", "1 supervisor request unanswered", "<dim>1 supervisor request </dim><warning>unanswered</warning>"],
			["subagent-supervisor-unanswered", { requestIds: ["request-1", "request-2"] }, "", "2 supervisor requests unanswered", "<dim>2 supervisor requests </dim><warning>unanswered</warning>"],
			["subagent-supervisor-unanswered", undefined, "", "supervisor requests unanswered", "<dim>supervisor requests </dim><warning>unanswered</warning>"],
			["subagent-supervisor-blocked", { blocked: true, requestIds: ["request-1"] }, "", "1 supervisor request blocked", "<dim>1 supervisor request </dim><error>blocked</error>"],
			["subagent-completion-unanswered", undefined, "", "completion results unanswered", "<dim>completion results </dim><warning>unanswered</warning>"],
			["subagent-completion-unhandled", undefined, "", "completion results unhandled", "<dim>completion results </dim><error>unhandled</error>"],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "completed" }, "", "bg_wait: run run-1 completed", "<dim>bg_wait: run run-1 </dim><success>completed</success>"],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "timed out" }, "", "bg_wait: run run-1 timed out", "<dim>bg_wait: run run-1 </dim><warning>timed out</warning>"],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "reconciliation failed" }, "", "bg_wait: run run-1 reconciliation failed", "<dim>bg_wait: run run-1 </dim><error>reconciliation failed</error>"],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "detached" }, "", "bg_wait: run run-1 detached", "<dim>bg_wait: run run-1 detached</dim>"],
			["subagent-wait-subscription", undefined, "", "bg_wait fired", "<dim>bg_wait fired</dim>"],
			["subagent-incremental-child-notify", { childKey: "review", outcome: "failed" }, "", "workflow child review failed", "<dim>workflow child review </dim><error>failed</error>"],
			["subagent-incremental-child-notify", undefined, "Workflow child paused (needs attention): **review**\nWorkflow run: wf-1", "workflow child review paused", "<dim>workflow child review </dim><warning>paused</warning>"],
			["subagent-incremental-child-notify", undefined, "Something else", "workflow child update", "<dim>workflow child update</dim>"],
			["subagent-workflow-result-write-failed", undefined, "", "workflow result save failed", "<dim>workflow result </dim><error>save failed</error>"],
		];
		for (const [customType, details, content, text, toned] of rows) {
			assert.deepEqual(visibleLines(renderMessage(customType, details, { content })), [`  ⎿  ${text} (ctrl+o to expand)`], text);
			assert.equal(tonedHeadline(customType, details, content), toned, text);
		}
	});

	it("shows watchdog warnings and clarifications as one CC ⎿ row", () => {
		const rows: Array<[string, unknown, string, string, string]> = [
			["subagent_watchdog_warning", watchdogWarning, "<subagent_watchdog>", "watchdog blocker", "<dim>watchdog </dim><error>blocker</error>"],
			["subagent_watchdog_warning", { ...watchdogWarning, severity: "concern" }, "<subagent_watchdog>", "watchdog concern", "<dim>watchdog </dim><warning>concern</warning>"],
			["subagent_watchdog_warning", { severity: "blocker" }, "<subagent_watchdog>", "watchdog warning", "<dim>watchdog warning</dim>"],
			["subagent_watchdog_clarification", undefined, "Which migration is current?", "watchdog needs clarification", "<dim>watchdog </dim><warning>needs clarification</warning>"],
		];
		for (const [customType, details, content, text, toned] of rows) {
			assert.deepEqual(visibleLines(renderMessage(customType, details, { content })), [`  ⎿  ${text} (ctrl+o to expand)`], text);
			assert.equal(tonedHeadline(customType, details, content), toned, text);
		}
		assert.deepEqual(visibleLines(renderEntry("subagent_watchdog_warning", watchdogWarning)), ["  ⎿  watchdog blocker (ctrl+o to expand)"]);
		assert.deepEqual(visibleLines(renderEntry("subagent_watchdog_warning", { summary: "No evidence" })), ["  ⎿  watchdog warning (ctrl+o to expand)"]);
	});

	it("keeps a watchdog warning's lifecycle state on the collapsed row", () => {
		const rows: Array<[unknown, string]> = [
			[{ ...watchdogWarning, state: "displayed" }, "watchdog blocker"],
			[{ ...watchdogWarning, state: "stalemate", stalemateRepeats: 3 }, "watchdog blocker · stalemate"],
			[{ ...watchdogWarning, severity: "concern", stale: true, state: "stale" }, "watchdog concern · stale"],
			[{ ...watchdogWarning, state: "failed", error: "review timed out" }, "watchdog blocker · failed review"],
		];
		for (const [details, text] of rows) {
			assert.deepEqual(visibleLines(renderMessage("subagent_watchdog_warning", details, { content: "<subagent_watchdog>" })), [`  ⎿  ${text} (ctrl+o to expand)`], text);
			assert.deepEqual(visibleLines(renderEntry("subagent_watchdog_warning", details)), [`  ⎿  ${text} (ctrl+o to expand)`], text);
		}
	});

	it("expands watchdog warnings to the readable warning instead of the model's XML", () => {
		const readable = [
			"  ⎿  watchdog blocker",
			"     Subagent watchdog Blocker: Edits a migration without a backfill",
			"     Evidence: diff touches db/migrations/0042.sql",
			"     Recommended action: Add a reversible backfill",
			"     Importance: High · Category: Other · Source: main · Agent: worker",
		];
		assert.deepEqual(visibleLines(renderMessage("subagent_watchdog_warning", watchdogWarning, { content: "<subagent_watchdog severity=\"blocker\">", expanded: true, width: 200 })), readable);
		assert.deepEqual(visibleLines(renderEntry("subagent_watchdog_warning", watchdogWarning, { expanded: true, width: 200 })), readable);
	});

	it("shows the supervisor reply entry as one CC ⎿ row", () => {
		assert.deepEqual(visibleLines(renderEntry("subagent_supervisor_reply", reply)), ["  ⎿  reply sent to worker (ctrl+o to expand)"]);
		assert.deepEqual(visibleLines(renderEntry("subagent_supervisor_reply", { ...reply, message: ["bad"] })), ["  ⎿  supervisor reply (ctrl+o to expand)"]);
	});

	it("expands a message to the wrapped text the main agent read", () => {
		const content = [
			"Subagent needs a supervisor decision.",
			"Run: run-1",
			"Agent: worker",
			"Child index: 0",
			"",
			"Should I drop the old `users.email` index first?",
			"",
			"Reply with: subagent_supervisor({ action: \"reply\", replyTo: \"request-1\", message: \"...\" })",
		].join("\n");
		assert.deepEqual(visibleLines(renderMessage("subagent_supervisor_request", { ...request, reason: "need_decision" }, { content, expanded: true, width: 200 })), [
			"  ⎿  worker needs a decision",
			"     Subagent needs a supervisor decision.",
			"     Run: run-1",
			"     Agent: worker",
			"     Child index: 0",
			"     Should I drop the old `users.email` index first?",
			"     Reply with: subagent_supervisor({ action: \"reply\", replyTo: \"request-1\", message: \"...\" })",
		]);
	});

	it("expands the supervisor reply entry to the reply and the request it answers", () => {
		assert.deepEqual(visibleLines(renderEntry("subagent_supervisor_reply", reply, { expanded: true })), [
			"  ⎿  reply sent to worker",
			"     Request: request-1",
			"     Run: run-1",
			"     Child index: 1",
			"     Child target: child-worker",
			"     Approved; continue.",
		]);
	});

	it("names Pi's expand key in the hint, falling back to ctrl+o when no key is bound", async (t) => {
		const collapsed = () => visibleLines(renderMessage("subagent_supervisor_request", { ...request, reason: "need_decision" }));
		assert.deepEqual(collapsed(), ["  ⎿  worker needs a decision (ctrl+o to expand)"]);
		await bindExpandKey(t, "ctrl+r");
		assert.deepEqual(collapsed(), ["  ⎿  worker needs a decision (ctrl+r to expand)"]);
	});

	it("renders every message kind as one CC ⎿ row", () => {
		const firstRow = (lines: string[]) => visibleLines(lines)[0];
		const messages: Array<[string, unknown, string]> = [
			["subagent_supervisor_request", { ...request, reason: "need_decision" }, ""],
			["subagent-supervisor-unanswered", { requestIds: ["request-1"] }, ""],
			["subagent-supervisor-blocked", { blocked: true, requestIds: ["request-1"] }, ""],
			["subagent-notify", { runs: [{ agent: "scout", status: "completed" }] }, ""],
			["subagent-completion-unanswered", undefined, ""],
			["subagent-completion-unhandled", undefined, ""],
			["subagent-incremental-child-notify", { childKey: "review", outcome: "failed" }, ""],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "completed" }, ""],
			["subagent-workflow-result-write-failed", undefined, ""],
			["subagent_control_notice", { event: { type: "needs_attention", agent: "worker", runId: "run-1", message: "stuck", ts: 1 } }, ""],
			["subagent_steering_notice", { runId: "run-1", state: "failed" }, ""],
			["subagent_watchdog_warning", watchdogWarning, "<subagent_watchdog>"],
			["subagent_watchdog_clarification", undefined, "Which migration is current?"],
		];
		for (const [customType, details, content] of messages) {
			const row = firstRow(renderMessage(customType, details, { content, width: 200 }));
			assert.ok(row?.startsWith("  ⎿  "), customType);
			assert.match(row ?? "", /\(ctrl\+o to expand\)$/, customType);
		}
		assert.match(firstRow(renderEntry("subagent_supervisor_reply", reply, { width: 200 })) ?? "", /^  ⎿  reply sent to worker \(ctrl\+o to expand\)$/);
		assert.match(firstRow(renderEntry("subagent_watchdog_warning", watchdogWarning, { width: 200 })) ?? "", /^  ⎿  watchdog blocker \(ctrl\+o to expand\)$/);
	});

	it("keeps the collapsed row to one line at narrow widths", () => {
		const lines = visibleLines(renderMessage("subagent_supervisor_request", { ...request, reason: "interview_request" }, { width: 24 }));
		assert.deepEqual(lines, ["  ⎿  worker asks for st…"]);
		assert.ok(visibleWidth(lines[0]!) <= 24);
	});

	it("draws the CC ⎿ row, wraps the body under the gutter, and tones only the status word", () => {
		const lines = renderMessage("subagent_supervisor_request", { ...request, reason: "need_decision" }, { theme: tokenTheme, width: 300 });
		assert.deepEqual(lines, [
			"<dim>  ⎿  </dim><dim>worker </dim><warning>needs a decision</warning> <dim>(ctrl+o to expand)</dim>",
		]);
		const expanded = renderMessage("subagent_supervisor_request", { ...request, reason: "need_decision" }, { theme: tokenTheme, width: 300, expanded: true, content: "First line\n\n- second line" });
		assert.deepEqual(expanded, [
			"<dim>  ⎿  </dim><dim>worker </dim><warning>needs a decision</warning>",
			"     <dim>First line</dim>",
			"",
			"     <dim>- second line</dim>",
		]);
	});

	it("renders escape sequences from message text inert", () => {
		const details = { ...request, agent: "wor\x1b[31mker", reason: "need_decision" };
		const content = "Run \x1b]0;pwned\x07this";
		for (const expanded of [false, true]) {
			const text = renderMessage("subagent_supervisor_request", details, { content, expanded, width: 200 }).join("\n");
			assert.match(text, /wor\[U\+001B\]\[31mker/);
			assert.equal(text.includes("\x1b[31m"), false);
			assert.equal(text.includes("\x1b]0;"), false);
		}
		const expandedText = renderMessage("subagent_supervisor_request", details, { content, expanded: true, width: 200 }).join("\n");
		assert.match(expandedText, /Run \[U\+001B\]\]0;pwned\[U\+0007\]this/);
	});

	it("toggles one block on a click, and Pi's expand key discards earlier clicks", () => {
		const message = { customType: "subagent_supervisor_request", content: "Should I continue?", details: { ...request, reason: "need_decision" } };
		const otherMessage = { ...message };
		const render = (target: typeof message, expandedByPi: boolean) => {
			// SAFETY: the renderer reads only fg from Pi's theme.
			const component = renderSubagentMessage(target, { expanded: expandedByPi }, plainTheme as never);
			assert.ok(component);
			return component;
		};
		const click = (component: ReturnType<typeof render>, button: "left" | "right" = "left") => {
			const height = component.render(100).length;
			return component.handleMouse?.({ type: "click", button, x: 2, y: 0, screenX: 2, screenY: 0, width: 100, height, shift: false, alt: false, ctrl: false });
		};
		const collapsed = ["  ⎿  worker needs a decision (ctrl+o to expand)"];
		const expanded = ["  ⎿  worker needs a decision", "     Should I continue?"];

		const block = render(message, false);
		assert.equal(click(block, "right"), undefined);
		assert.deepEqual(visibleLines(block.render(100)), collapsed);
		assert.equal(click(block)?.handled, true);
		assert.deepEqual(visibleLines(block.render(100)), expanded);
		assert.deepEqual(visibleLines(render(message, false).render(100)), expanded);
		assert.deepEqual(visibleLines(render(otherMessage, false).render(100)), collapsed);
		assert.deepEqual(visibleLines(render(message, true).render(100)), expanded);
		assert.deepEqual(visibleLines(render(message, false).render(100)), collapsed);
	});

	it("opens and closes inside Pi's own message component, by Pi's expand toggle or a click", () => {
		const message = { role: "custom" as const, customType: "subagent_supervisor_request", content: "Should I continue?", display: true, details: { ...request, reason: "need_decision" }, timestamp: 1 };
		const host = new CustomMessageComponent(message, renderSubagentMessage);
		const shown = () => visibleLines(host.render(100));
		const collapsed = ["  ⎿  worker needs a decision (ctrl+o to expand)"];
		const expanded = ["  ⎿  worker needs a decision", "     Should I continue?"];

		assert.deepEqual(shown(), collapsed);
		host.setExpanded(true);
		assert.deepEqual(shown(), expanded);
		host.setExpanded(false);
		assert.deepEqual(shown(), collapsed);
		const height = host.render(100).length;
		assert.equal(host.handleMouse({ type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 100, height, shift: false, alt: false, ctrl: false })?.handled, true);
		assert.deepEqual(shown(), expanded);
	});
});
