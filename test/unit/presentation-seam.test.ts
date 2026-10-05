import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PRESENTATION_DIAGNOSTIC_EVENT,
	PRESENTATION_PROTOCOL_VERSION,
	PRESENTATION_READY_EVENT,
	PresentationSeamHost,
	probePresentationHost,
	requestPresentationRegistration,
	type PresentationDrawResult,
	type PresentationEventBus,
	type PresentationFleetFrame,
	type PresentationFrame,
	type PresentationReadyPayload,
	type PresentationRegistrationStatus,
} from "../../src/tui/presentation-seam.ts";

class FakeBus implements PresentationEventBus {
	readonly emitted: Array<{ channel: string; data: unknown }> = [];
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
		this.emitted.push({ channel, data });
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}
}

function frame(overrides: Partial<PresentationFleetFrame> = {}): PresentationFleetFrame {
	const row = (rowKind: string, rowKey: string) => ({ rowKind, rowKey });
	const rows = [
		row("main", "main"),
		{ ...row("agent", "agent:reviewer"), agentIdentity: "reviewer", state: "running", startedAt: 0, usage: { tokens: 8_100 } },
	] as PresentationFleetFrame["rows"];
	return {
		protocol: PRESENTATION_PROTOCOL_VERSION,
		surface: "fleet",
		revision: "r1",
		session: "session-1",
		runtimeGeneration: 0,
		width: 80,
		theme: { fg: (_name, text) => text },
		now: 1_000,
		rows,
		selection: { active: false, selectedKey: null },
		budget: { visibleRows: rows.length, hiddenAbove: 0, hiddenBelow: 0, maxRows: 6 },
		...overrides,
	};
}

function nativeDraw(lines: string[]): (frame: PresentationFrame) => PresentationDrawResult {
	return (current) => ({
		lines: [...lines, `native:${current.revision}`],
		layout: current.rows.map((row, index) => ({ rowKey: row.rowKey, fromLine: index, toLine: index, truncated: false })),
	});
}

function adapterDraw(tag: string): (frame: PresentationFrame) => PresentationDrawResult {
	return (current) => ({
		lines: current.rows.map((row) => `${tag}:${row.rowKey}`),
		layout: current.rows.map((row, index) => ({ rowKey: row.rowKey, fromLine: index, toLine: index, truncated: false })),
	});
}

function makeHost(bus: FakeBus, native = nativeDraw(["  ● main"])) {
	return new PresentationSeamHost({
		events: bus,
		session: () => "session-1",
		native: { fleet: native },
	});
}

describe("presentation seam host readiness", () => {
	it("broadcasts ready on activation with exact protocol, surfaces, and event map", () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		const ready = bus.emitted.find(({ channel }) => channel === PRESENTATION_READY_EVENT)?.data as PresentationReadyPayload;
		assert.equal(ready?.protocol, 1);
		assert.deepEqual(ready?.surfaces, ["fleet"]);
		assert.equal(ready?.session, "session-1");
		assert.equal(ready?.events.register, "pi-subagents:presentation:v1:register");
		host.dispose();
	});

	it("answers a late probe after the host loaded first (load order A: host before consumer)", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		const probe = await probePresentationHost({ events: bus, timeoutMs: 50 });
		assert.equal(probe?.protocol, 1);
		assert.equal(probe?.session, "session-1");
		host.dispose();
	});

	it("emits no ready and answers no probe before activation (non-TUI never activates)", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		const probe = await probePresentationHost({ events: bus, timeoutMs: 30 });
		assert.equal(probe, null);
		assert.equal(bus.emitted.filter(({ channel }) => channel === PRESENTATION_READY_EVENT).length, 0);
		host.dispose();
	});
});

describe("presentation seam registration", () => {
	it("activates an adapter and routes draws away from native", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		const registration = await requestPresentationRegistration({
			events: bus,
			identity: "cc-tui",
			surfaces: { fleet: adapterDraw("cc") },
			session: "session-1",
		});
		assert.equal(registration.status, "activated");
		const { result, native } = host.draw("fleet", frame());
		assert.equal(native, false);
		assert.deepEqual(result.lines, ["cc:main", "cc:agent:reviewer"]);
		assert.deepEqual(result.layout.map((entry) => entry.rowKey), ["main", "agent:reviewer"]);
		host.dispose();
	});

	it("rejects wrong protocol major versions as incompatible without registering", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		const reply = await new Promise<unknown>((resolve) => {
			bus.on("pi-subagents:presentation:v1:reply:bad", resolve);
			bus.emit("pi-subagents:presentation:v1:register", { protocol: 2, replyChannel: "pi-subagents:presentation:v1:reply:bad", request: { identity: "future", surfaces: { fleet: adapterDraw("x") } } });
		}) as PresentationRegistrationStatus;
		assert.equal(reply.status, "incompatible");
		const { native } = host.draw("fleet", frame());
		assert.equal(native, true);
		host.dispose();
	});

	it("rejects registrations for another session and stale runtime generations", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		const otherSession = await requestPresentationRegistration({ events: bus, identity: "a", surfaces: { fleet: adapterDraw("a") }, session: "session-2" });
		assert.equal(otherSession.status, "not-ready");
		const staleGeneration = await requestPresentationRegistration({ events: bus, identity: "a", surfaces: { fleet: adapterDraw("a") }, runtimeGeneration: 99 });
		assert.equal(staleGeneration.status, "not-ready");
		host.dispose();
	});

	it("refuses to silently override a different owner (ownership conflict)", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		const first = await requestPresentationRegistration({ events: bus, identity: "cc-tui", surfaces: { fleet: adapterDraw("cc") } });
		assert.equal(first.status, "activated");
		const second = await requestPresentationRegistration({ events: bus, identity: "other-tui", surfaces: { fleet: adapterDraw("other") } });
		assert.equal(second.status, "conflict");
		const { result, native } = host.draw("fleet", frame());
		assert.equal(native, false);
		assert.deepEqual(result.lines, ["cc:main", "cc:agent:reviewer"]);
		host.dispose();
	});

	it("same-identity re-registration replaces the earlier handle; the old token cannot withdraw the new one", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		const first = await requestPresentationRegistration({ events: bus, identity: "cc-tui", surfaces: { fleet: adapterDraw("v1") } });
		assert.equal(first.status, "activated");
		const firstHandle = first.status === "activated" ? first.handle : undefined;
		const second = await requestPresentationRegistration({ events: bus, identity: "cc-tui", surfaces: { fleet: adapterDraw("v2") } });
		assert.equal(second.status, "replaced");
		firstHandle?.dispose();
		const { result, native } = host.draw("fleet", frame());
		assert.equal(native, false);
		assert.deepEqual(result.lines, ["v2:main", "v2:agent:reviewer"]);
		host.dispose();
	});

	it("dispose is idempotent and restores native drawing", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		const registration = await requestPresentationRegistration({ events: bus, identity: "cc-tui", surfaces: { fleet: adapterDraw("cc") } });
		const handle = registration.status === "activated" ? registration.handle : undefined;
		handle?.dispose();
		handle?.dispose();
		const { result, native } = host.draw("fleet", frame());
		assert.equal(native, true);
		assert.deepEqual(result.lines, ["  ● main", "native:r1"]);
		host.dispose();
	});

	it("withdraw event reaches the same disposition as handle.dispose", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		const registration = await requestPresentationRegistration({ events: bus, identity: "cc-tui", surfaces: { fleet: adapterDraw("cc") } });
		const handle = registration.status === "activated" ? registration.handle : undefined;
		bus.emit("pi-subagents:presentation:v1:withdraw", { protocol: 1, token: handle?.token });
		const { native } = host.draw("fleet", frame());
		assert.equal(native, true);
		host.dispose();
	});

	it("deactivate withdraws every adapter and bumps the runtime generation", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		await requestPresentationRegistration({ events: bus, identity: "cc-tui", surfaces: { fleet: adapterDraw("cc") } });
		host.deactivate();
		const { native } = host.draw("fleet", frame({ session: null, runtimeGeneration: 1 }));
		assert.equal(native, true);
		const retry = await requestPresentationRegistration({ events: bus, identity: "cc-tui", surfaces: { fleet: adapterDraw("cc") } });
		assert.equal(retry.status, "not-ready");
		host.dispose();
	});
});

describe("presentation seam draw failure handling", () => {
	it("falls back to native for the frame when the adapter throws, with a deduped diagnostic", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		let failures = 0;
		await requestPresentationRegistration({
			events: bus,
			identity: "cc-tui",
			surfaces: {
				fleet: () => {
					failures += 1;
					throw new Error("boom");
				},
			},
		});
		const diagnostics: unknown[] = [];
		bus.on(PRESENTATION_DIAGNOSTIC_EVENT, (payload) => diagnostics.push(payload));
		for (let index = 0; index < 3; index++) {
			const { result, native } = host.draw("fleet", frame({ revision: `r${index}` }));
			assert.equal(native, true, "adapter failure must render native");
			assert.deepEqual(result.lines, ["  ● main", `native:r${index}`]);
		}
		assert.equal(failures, 3, "host retries the adapter rather than quarantining it silently");
		assert.equal(diagnostics.length, 1, "identical failure reasons are deduped per session");
		assert.deepEqual(Object.keys(diagnostics[0] as object).sort(), ["identity", "occurrence", "protocol", "reason", "surface"]);
		host.dispose();
	});

	it("treats an invalid layout as a failure and falls back to native", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		await requestPresentationRegistration({
			events: bus,
			identity: "cc-tui",
			surfaces: {
				fleet: (current) => ({
					lines: current.rows.map(() => "cc"),
					layout: [{ rowKey: "not-in-frame", fromLine: 0, toLine: 0, truncated: false }],
				}),
			},
		});
		const { result, native } = host.draw("fleet", frame());
		assert.equal(native, true);
		assert.deepEqual(result.lines, ["  ● main", "native:r1"]);
		host.dispose();
	});

	it("rejects layouts whose line ranges run out of bounds", async () => {
		const bus = new FakeBus();
		const host = makeHost(bus);
		host.activate("session-1");
		await requestPresentationRegistration({
			events: bus,
			identity: "cc-tui",
			surfaces: {
				fleet: (current) => ({
					lines: current.rows.map((row) => row.rowKey),
					layout: current.rows.map((row, index) => ({ rowKey: row.rowKey, fromLine: index, toLine: index + 5, truncated: false })),
				}),
			},
		});
		const { native } = host.draw("fleet", frame());
		assert.equal(native, true);
		host.dispose();
	});
});
