import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import { renderWidget, resetWidgetLayoutSession } from "../../src/tui/render.ts";

/**
 * Characterization tests for the async status widget (spec P-async, step 1):
 * these pin TODAY's native composition byte-for-byte BEFORE the presentation
 * seam refactor, so the frame-ized native adapter must reproduce them
 * exactly. Written first deliberately — this composition had no test net.
 */

const NOW = 1_000_000_000_000;
const FRAME = Math.floor(NOW / 400);

const theme = {
	fg(_name: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
	bg(_name: string, text: string): string {
		return text;
	},
	getThinkingBorderColor(_level: string): (text: string) => text {
		return (text) => text;
	},
};

interface WidgetHarness {
	render(width: number): string[];
}

const originalRows = process.stdout.rows;
const originalColumns = process.stdout.columns;

function mount(jobs: AsyncJobState[], options: { collapsed?: boolean; expanded?: boolean; rows?: number; columns?: number } = {}): WidgetHarness {
	// Headless runs have no TTY: pin the terminal geometry so the adaptive
	// fit picks a deterministic tier, and reset the module-level layout
	// session so cases don't inherit each other's tier.
	(process.stdout as { rows?: number }).rows = options.rows ?? 40;
	(process.stdout as { columns?: number }).columns = options.columns ?? 120;
	resetWidgetLayoutSession();
	let widgetFactory: unknown;
	const ctx = {
		hasUI: true,
		ui: {
			setWidget(_key: string, factory: unknown) {
				widgetFactory = factory;
			},
			getToolsExpanded: () => options.expanded === true,
		},
	} as unknown as ExtensionContext;
	renderWidget(ctx, jobs, options.collapsed === true);
	const factory = widgetFactory as (tui: unknown, theme: unknown) => WidgetHarness;
	const component = factory({ requestRender() {} }, theme as never);
	return {
		render(width: number): string[] {
			return component.render(width);
		},
	};
}

function restoreTerminal(): void {
	(process.stdout as { rows?: number }).rows = originalRows;
	(process.stdout as { columns?: number }).columns = originalColumns;
}

function job(overrides: Partial<AsyncJobState> & { asyncId: string }): AsyncJobState {
	return {
		asyncDir: `/tmp/${overrides.asyncId}`,
		status: "running",
		mode: "single",
		startedAt: NOW - 16_000,
		updatedAt: NOW - 1_000,
		...overrides,
	} as AsyncJobState;
}

describe("async widget characterization", () => {
	it("collapsed widget renders the single-line counts summary", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "a", status: "running" }),
				job({ asyncId: "b", status: "queued" }),
				job({ asyncId: "c", status: "failed" }),
			], { collapsed: true });
			const lines = component.render(80);
			assert.equal(lines.length, 1);
			assert.match(lines[0]!, /subagents \(1\/3 running, 1 queued, 1 failed\)/, `actual: ${lines[0]}`);
			assert.equal(lines[0]!.length, 80, "single line padded to the render width");
			assert.equal(lines[0]!.length <= 80, true);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("collapsed widget with no active jobs reports done counts", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "a", status: "complete" }),
				job({ asyncId: "b", status: "complete" }),
			], { collapsed: true });
			const lines = component.render(80);
			assert.equal(lines.length, 1);
			assert.match(lines[0]!, /○ subagents \(2\/2 done\)/, `actual: ${lines[0]}`);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("single running job renders the background header, summary, and detail rows", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "solo", description: "检查展示接口", currentTool: "Read" }),
			]);
			const lines = component.render(80).map((line) => line.trimEnd());
			assert.deepEqual(lines, [
				" async subagent single · background",
				" ⠋ single · 15.0s",
				"   ⎿  Read",
			], `actual: ${JSON.stringify(lines)}`);
			assert.ok(!lines.join("\n").includes("Async agents"), "single job must not render the multi-job header");
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("multi-job widget renders the Async agents header and per-job items", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "r1", description: "alpha" }),
				job({ asyncId: "q1", status: "queued", description: "beta" }),
				job({ asyncId: "f1", status: "complete", description: "done work" }),
			]);
			const lines = component.render(100).map((line) => line.trim());
			assert.match(lines[0]!, /Async agents · background$/, `actual: ${lines[0]}`);
			assert.match(lines.join("\n"), /├─ ⠋ single · 15\.0s/);
			assert.match(lines.join("\n"), /└─ ✓ single · 15\.0s/);
			assert.match(lines.join("\n"), /◦ 1 queued/);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("workflow job renders the compact workflow body while collapsed", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({
					asyncId: "wf",
					mode: "workflow",
					steps: [
						{ index: 0, agent: "reviewer", status: "running" },
						{ index: 1, agent: "scout", status: "complete" },
					],
				}),
			]);
			const lines = component.render(100);
			const joined = lines.join("\n");
			assert.match(joined, /workflow/i, `workflow mode shows: ${JSON.stringify(lines)}`);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("materialized workflow children render as tree rows under their parent", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const parent = job({
				asyncId: "wf",
				mode: "workflow",
				steps: [{ index: 0, agent: "reviewer", workflowKey: "review", status: "running" }],
			});
			const child = job({
				asyncId: "child-1",
				mode: "single",
				parentWorkflowRunId: "wf",
				workflowKey: "review",
				description: "child work",
			});
			const component = mount([parent, child]);
			const joined = component.render(100).join("\n");
			assert.match(joined, /├─|└─/, "children render with tree connectors");
			assert.match(joined, /child work|review/);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("renderWidget clears the widget when jobs is empty", () => {
		const cleared: Array<[string, unknown]> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(key: string, content: unknown) {
					cleared.push([key, content]);
				},
			},
		} as unknown as ExtensionContext;
		renderWidget(ctx, []);
		assert.deepEqual(cleared, [["subagent-async", undefined]]);
	});

	it("renderWidget mounts via setWidget on first render and updates in place after", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		const widgets = new Map<string, unknown>();
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(key: string, factory: unknown) {
					widgets.set(key, factory);
				},
				getToolsExpanded: () => false,
			},
		} as unknown as ExtensionContext;
		try {
			renderWidget(ctx, [job({ asyncId: "a" })], false);
			assert.ok(widgets.has("subagent-async"), "widget factory mounted");
			const factory = widgets.get("subagent-async") as (tui: unknown, theme: unknown) => { render(width: number): string[] };
			const component = factory({ requestRender() {} }, theme as never);
			const first = component.render(80);
			assert.ok(first.length >= 1);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});
});

void (undefined as unknown as SubagentState);
void FRAME;
