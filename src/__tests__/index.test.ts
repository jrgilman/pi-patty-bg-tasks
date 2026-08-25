/**
 * index.ts session lifecycle — Claude Code parity:
 *   - the registry is born empty on session_start (no persistence, no revival;
 *     a stale `background-tasks-state` entry is never consulted)
 *   - session_shutdown kills ALL running tasks on ANY reason, not just "quit",
 *     and appends no state snapshot
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.ts";
import { EVENT } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A process marker unique to this test run, so pgrep can't hit strangers. */
const MARKER = `pi-bg-shutdown-test-${process.pid}`;
const WATCH_CMD = `while true; do sleep 1; done # ${MARKER}`;

/** Count live processes whose command line carries our marker. The `[w]hile`
 *  trick keeps the pgrep shell's own cmdline from matching itself. */
function liveMarkedProcesses(): number {
    try {
        const out = execSync(
            `pgrep -f "[w]hile true; do sleep 1; done # ${MARKER}" | wc -l`,
            { encoding: "utf-8" }
        );
        return Number.parseInt(out.trim(), 10);
    } catch {
        return 0;
    }
}

interface CapturedTool {
    name: string;
    execute: (
        toolCallId: string,
        params: unknown,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<{ content: { type: "text"; text: string }[] }>;
}

interface CapturedComponent {
    render(width: number): string[];
    invalidate(): void;
}

type MessageRenderer = (
    message: { content: unknown; details?: unknown },
    options: unknown,
    theme: { fg(colour: string, text: string): string }
) => CapturedComponent;

type SessionHandler = (event: { reason?: string }, ctx: unknown) => Promise<void>;

function makePi() {
    const tools = new Map<string, CapturedTool>();
    const handlers = new Map<string, SessionHandler>();
    const renderers = new Map<string, MessageRenderer>();
    const messages: { customType: string }[] = [];
    const appendedEntries: unknown[] = [];
    const pi = {
        registerTool(def: CapturedTool) {
            tools.set(def.name, def);
        },
        registerShortcut() {},
        registerCommand() {},
        registerMessageRenderer(customType: string, renderer: MessageRenderer) {
            renderers.set(customType, renderer);
        },
        on(event: string, handler: SessionHandler) {
            handlers.set(event, handler);
        },
        sendMessage(msg: { customType: string }) {
            messages.push(msg);
        },
        appendEntry(_customType: string, data: unknown) {
            appendedEntries.push(data);
        },
    };
    return { pi, tools, handlers, renderers, messages, appendedEntries };
}

const uiCtx = {
    cwd: process.cwd(),
    ui: {
        notify() {},
        setWidget() {},
        setStatus() {},
        theme: { fg: (_c: string, t: string) => t },
    },
};

function startExtension() {
    const h = makePi();
    extension(h.pi as never);
    return h;
}

void describe("tool registration", () => {
    void it("omits redundant background tools", () => {
        const h = startExtension();

        assert.equal(h.tools.has("bash_bg"), false);
        assert.equal(h.tools.has("agent_bg"), false);
    });
});

void describe("task notification renderer", () => {
    void it("keeps a long summary within the terminal width", () => {
        const h = startExtension();
        const renderer = h.renderers.get(EVENT.taskNotification);
        assert.ok(renderer);

        const width = 40;
        const component = renderer(
            {
                content: "unused",
                details: {
                    status: "completed",
                    summary: "Monitor with a deliberately long description stream ended",
                },
            },
            {},
            { fg: (_colour, text) => `\x1b[32m${text}\x1b[39m` }
        );
        const [line] = component.render(width);
        const lineWidth = visibleWidth(line);

        assert.ok(lineWidth <= width, `rendered ${lineWidth} columns for width ${width}`);
    });
});

void describe("session_start — registry is born empty (no revival)", () => {
    void it("ignores a stale persisted state entry entirely", async () => {
        const h = startExtension();
        // If session_start still tried to restore state, it would consult the
        // session manager — make that throw to prove it's never touched.
        const ctx = {
            sessionManager: {
                getEntries(): never {
                    throw new Error("session entries must not be consulted");
                },
            },
        };
        await h.handlers.get("session_start")!({}, ctx);

        const jobs = h.tools.get("jobs")!;
        const res = await jobs.execute("t1", { action: "list" }, undefined, undefined, uiCtx);
        assert.equal(res.content[0].text, "No background jobs");
        assert.equal(h.appendedEntries.length, 0, "no state snapshot is written");
    });
});

void describe("session_shutdown — kills running tasks on ANY reason", () => {
    for (const reason of ["quit", "reload"]) {
        void it(`reason "${reason}" kills running tasks silently`, async () => {
            const h = startExtension();
            await h.handlers.get("session_start")!({}, {});

            // Start a real long-running background task.
            const bash = h.tools.get("bash")!;
            const started = await bash.execute(
                "t2",
                { command: WATCH_CMD, run_in_background: true },
                undefined,
                undefined,
                uiCtx
            );
            const id = /with ID: (\w+)\./.exec(started.content[0].text)?.[1];
            assert.ok(id && /^b[0-9a-z]{8}$/.test(id), `typed shell id, got: ${id}`);
            assert.ok(liveMarkedProcesses() > 0, "task process is running");

            await h.handlers.get("session_shutdown")!({ reason }, {});
            await sleep(200); // let the SIGTERM land

            const jobs = h.tools.get("jobs")!;
            const list = await jobs.execute("t3", { action: "list" }, undefined, undefined, uiCtx);
            assert.match(list.content[0].text, /✗ killed/, "task ended up killed");
            assert.equal(liveMarkedProcesses(), 0, "no orphaned process survives");
            assert.equal(
                h.messages.filter((m) => m.customType === EVENT.taskNotification).length,
                0,
                "silent kill — no <task-notification> on the way out"
            );
            assert.equal(h.appendedEntries.length, 0, "no state snapshot on shutdown");
        });
    }
});

after(() => {
    // Best-effort cleanup if a test failed mid-flight.
    try {
        execSync(`pkill -f "[w]hile true; do sleep 1; done # ${MARKER}" || true`);
    } catch {
        /* already gone */
    }
});
