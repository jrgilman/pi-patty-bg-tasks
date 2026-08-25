import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob } from "../registry.ts";
import { startMonitorSession } from "../monitor-session.ts";
import type { MonitorSource } from "../monitor-source.ts";
import type { SpawnExit } from "../spawn.ts";
import { EVENT, DELIVER_FOLLOWUP, DELIVER_STEER, type UiContext } from "../types.ts";

const dir = join(tmpdir(), `pi-bg-session-${process.pid}`);
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg {
    customType: string;
    content: string;
    details?: { terminal?: boolean };
}

interface Delivery {
    deliverAs: string;
    triggerTurn: boolean;
}

function harness(logPath: string) {
    const messages: Msg[] = [];
    const streamDeliveries: Delivery[] = [];
    const pi = {
        sendMessage: (m: Msg, d?: Delivery) => {
            messages.push(m);
            if (m.customType === EVENT.monitorEvent && d) streamDeliveries.push(d);
        },
    };
    const ctx = {
        ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_c: string, t: string) => t } },
    } as unknown as UiContext;
    const reg = new BackgroundRegistry();

    let resolveExit!: (result: SpawnExit) => void;
    const exit = new Promise<SpawnExit>((res) => {
        resolveExit = res;
    });
    let stopped = false;
    const source: MonitorSource = {
        logPath,
        pid: 0,
        label: "fake",
        exit,
        stop: () => {
            stopped = true;
        },
    };

    const job = createRunningJob({
        id: `job-${process.pid}-1`,
        name: "watch", // production sets name: description (see tools/monitor.ts)
        command: source.label,
        pid: source.pid,
        logPath,
        toolCallId: "t",
        kind: "monitor",
    });
    add(reg, job);

    const start = (over?: { persistent?: boolean; timeoutMs?: number; steer?: boolean }) =>
        startMonitorSession({
            pi: pi as never,
            reg,
            ctx,
            job,
            source,
            description: "watch",
            persistent: over?.persistent ?? false,
            steer: over?.steer ?? false,
            timeoutMs: over?.timeoutMs ?? 60_000,
        });

    // The terminal notice is its own <task-notification>, sent the moment the
    // source ends — no coalescing window, no flush to force.
    const terminals = () => messages.filter((m) => m.customType === EVENT.taskNotification);
    const allText = () => messages.map((m) => m.content).join("\n");

    return { messages, streamDeliveries, reg, job, start, resolveExit, isStopped: () => stopped, terminals, allText };
}

void describe("monitor-session — lifecycle via a fake source", () => {
    void it("streams lines and emits exactly one 'stream ended' terminal on clean exit", async () => {
        const logPath = join(dir, "ok.log");
        writeFileSync(logPath, "");
        const h = harness(logPath);
        h.start();
        appendFileSync(logPath, "line-A\nline-B\n");
        await sleep(40);
        h.resolveExit({ code: 0, signal: null });
        await sleep(60);

        assert.match(h.allText(), /line-A/);
        assert.match(h.allText(), /line-B/);
        assert.equal(h.terminals().length, 1);
        const xml = h.terminals()[0].content;
        assert.ok(xml.includes("<status>completed</status>"));
        assert.ok(xml.includes(`<summary>Monitor "watch" stream ended</summary>`));
        // Evicted by completeJob once the notification has fired.
        assert.equal(h.reg.jobs.has(h.job.id), false);
    });

    void it("maps a non-zero exit to a failure terminal", async () => {
        const logPath = join(dir, "fail.log");
        writeFileSync(logPath, "");
        const h = harness(logPath);
        h.start();
        h.resolveExit({ code: 1, signal: null });
        await sleep(60);
        assert.equal(h.terminals().length, 1);
        assert.ok(h.terminals()[0].content.includes("<status>failed</status>"));
        assert.ok(h.terminals()[0].content.includes(`Monitor "watch" script failed (exit 1)`));
    });

    void it("maps a signal death to a 'stopped' terminal", async () => {
        const logPath = join(dir, "signal.log");
        writeFileSync(logPath, "");
        const h = harness(logPath);
        h.start();
        h.resolveExit({ code: null, signal: "SIGKILL" });
        await sleep(60);
        assert.equal(h.terminals().length, 1);
        assert.ok(h.terminals()[0].content.includes("<status>killed</status>"));
        assert.ok(h.terminals()[0].content.includes(`Monitor "watch" stopped`));
    });

    void it("trips the firehose guard, tears down the source, and kills the job", async () => {
        const logPath = join(dir, "flood.log");
        writeFileSync(logPath, "");
        const h = harness(logPath);
        h.start();
        appendFileSync(logPath, Array.from({ length: 600 }, (_, i) => `e${i}`).join("\n") + "\n");
        await sleep(300); // let a follower tick read the burst

        assert.equal(h.terminals().length, 1, "exactly one terminal");
        assert.match(h.terminals()[0].content, /too many events/);
        assert.ok(h.isStopped(), "source.stop was called via the kill path");
        assert.equal(h.job.status, "killed");
    });

    void it("does not emit a second terminal after the source exits", async () => {
        const logPath = join(dir, "once.log");
        writeFileSync(logPath, "");
        const h = harness(logPath);
        h.start();
        h.resolveExit({ code: 0, signal: null });
        await sleep(60);
        h.resolveExit({ code: 1, signal: null }); // ignored — promise already settled
        await sleep(40);
        assert.equal(h.terminals().length, 1);
    });

    void it("delivers stream events as passive follow-ups by default", async () => {
        const logPath = join(dir, "followup.log");
        writeFileSync(logPath, "");
        const h = harness(logPath);
        h.start();
        appendFileSync(logPath, "line-A\n");
        await sleep(300);

        assert.ok(h.streamDeliveries.length > 0);
        for (const d of h.streamDeliveries) {
            assert.deepEqual(d, DELIVER_FOLLOWUP);
        }
    });

    void it("delivers stream events as steering turns when steer is set", async () => {
        const logPath = join(dir, "steer.log");
        writeFileSync(logPath, "");
        const h = harness(logPath);
        h.start({ steer: true });
        appendFileSync(logPath, "line-A\n");
        await sleep(300);

        assert.ok(h.streamDeliveries.length > 0);
        for (const d of h.streamDeliveries) {
            assert.deepEqual(d, DELIVER_STEER);
        }
    });
});

process.on("exit", () => {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});
