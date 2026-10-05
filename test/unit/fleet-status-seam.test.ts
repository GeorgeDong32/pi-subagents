import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Editor } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../src/shared/types.ts";
import {
	PRESENTATION_PROTOCOL_VERSION,
	PresentationSeamHost,
	requestPresentationRegistration,
	type PresentationDrawResult,
	type PresentationEventBus,
	type PresentationFleetFrame,
} from "../../src/tui/presentation-seam.ts";
import { SubagentFleetStatus, drawNativeFleetFrame } from "../../src/tui/fleet-status.ts";

class FakeBus implements PresentationEventBus {
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(channel) ?? [];
		list.push(handler);
		this.handlers.set(channel, list);
		return () => {
			const current = this.handlers.get(channel) ?? [];
			this.handlers.set(channel, current.filter((candidate) => candidate !== handler));
		};
	}

	emit(channel: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}
}

function stateForTest(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	getThinkingBorderColor: (_level: string) => (text: string) => text,
};

function mount(state: SubagentState, seamDraw?: (frame: PresentationFleetFrame) => PresentationDrawResult) {
	let widgetFactory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
	const ctx = {
		hasUI: true,
		ui: {
			setWidget(_key: string, content: typeof widgetFactory | undefined) { if (content) widgetFactory = content; },
			onTerminalInput() { return () => {}; },
			getEditorText() { return ""; },
			requestRender() {},
			notify() {},
			theme,
		},
	} as unknown as ExtensionContext;
	const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000, ...(seamDraw ? { seamDraw } : {}) });
	fleet.setContext(ctx);
	const component = widgetFactory!({ requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor }, theme);
	return { fleet, component };
}

function populate(state: SubagentState): void {
	state.asyncJobs.set("reviewer", {
		asyncId: "reviewer", asyncDir: "/tmp/reviewer", status: "running", startedAt: 1_000, mode: "single",
		steps: [{ index: 0, agent: "reviewer", status: "running", tokens: { input: 7_900, output: 200, total: 8_100, window: 7_400 } }],
	});
}

describe("SubagentFleetStatus through the presentation seam", () => {
	it("renders the native adapter output when no external adapter is registered", () => {
		const state = stateForTest();
		populate(state);
		const host = new PresentationSeamHost({ events: new FakeBus(), session: () => "session-current", native: { fleet: drawNativeFleetFrame } });
		host.activate("session-current");
		const { fleet, component } = mount(state, (frame) => host.draw("fleet", frame).result);
		try {
			const rendered = component.render(80).join("\n");
			// Native roster (spec P5): collapsed summary while selection is off.
			assert.match(rendered, /1 active agent · .+ · ↓\/← to inspect/);
		} finally { fleet.dispose(); host.dispose(); }
	});

	it("swaps to a registered external adapter and restores native after withdraw", async () => {
		const state = stateForTest();
		populate(state);
		const bus = new FakeBus();
		const host = new PresentationSeamHost({ events: bus, session: () => "session-current", native: { fleet: drawNativeFleetFrame } });
		host.activate("session-current");
		const { fleet, component } = mount(state, (frame) => host.draw("fleet", frame).result);
		try {
			const registration = await requestPresentationRegistration({
				events: bus,
				identity: "cc-tui",
				surfaces: {
					fleet: (current) => ({
						lines: [`CC:${current.revision.slice(0, 0)}main`, ...current.rows.filter((row) => row.rowKind === "agent").map((row) => `CC:${(row as { agentIdentity?: string }).agentIdentity ?? row.rowKey}`)],
						layout: current.rows.map((row, index) => ({ rowKey: row.rowKey, fromLine: index === 0 ? 0 : index, toLine: index, truncated: false })),
					}),
				},
			});
			assert.equal(registration.status, "activated");
			const rendered = component.render(80).join("\n");
			assert.match(rendered, /CC:main/);
			assert.match(rendered, /CC:reviewer/);
			assert.doesNotMatch(rendered, /active agent/);
			registration.status === "activated" && registration.handle.dispose();
			const afterWithdraw = component.render(80).join("\n");
			assert.match(afterWithdraw, /1 active agent/);
			assert.doesNotMatch(afterWithdraw, /CC:reviewer/);
		} finally { fleet.dispose(); host.dispose(); }
	});

	it("native draw stamps no session or generation opinion; host validation falls back on a lying layout", async () => {
		const state = stateForTest();
		populate(state);
		const bus = new FakeBus();
		const host = new PresentationSeamHost({ events: bus, session: () => "session-current", native: { fleet: drawNativeFleetFrame } });
		host.activate("session-current");
		const { fleet, component } = mount(state, (frame) => host.draw("fleet", frame).result);
		try {
			await requestPresentationRegistration({
				events: bus,
				identity: "broken",
				surfaces: {
					fleet: (current) => ({
						lines: current.rows.map(() => "broken"),
						layout: [],
					}),
				},
			});
			const rendered = component.render(80).join("\n");
			assert.match(rendered, /1 active agent/, "invalid adapter layout must fall back to the native roster");
		} finally { fleet.dispose(); host.dispose(); }
	});

	it("frames carry stable row keys and redaction-safe materials only", () => {
		const state = stateForTest();
		populate(state);
		const frames: PresentationFleetFrame[] = [];
		const { fleet, component } = mount(state, (frame) => {
			frames.push(frame);
			return { lines: frame.rows.map(() => ""), layout: frame.rows.map((row, index) => ({ rowKey: row.rowKey, fromLine: index, toLine: index, truncated: false })) };
		});
		try {
			component.render(80);
			component.render(60);
			const [first, second] = frames;
			assert.ok(first && second);
			assert.deepEqual(first.rows.map((row) => row.rowKey), second.rows.map((row) => row.rowKey), "row keys must be stable across widths");
			assert.equal(first.protocol, PRESENTATION_PROTOCOL_VERSION);
			assert.equal(first.surface, "fleet");
			assert.equal(first.session, "session-current");
			const serialized = JSON.stringify(first);
			assert.ok(!serialized.includes("asyncDir"), "frames must not leak internal state paths");
			assert.ok(!serialized.includes("/tmp/reviewer"), "frames must not leak disk paths");
		} finally { fleet.dispose(); }
	});
});
