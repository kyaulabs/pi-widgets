import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tpsStatus from "../extensions/tps-status.js";
import { createHarness } from "./harness.js";

function callable(value: unknown): (...args: any[]) => any {
  if (typeof value !== "function") throw new Error("Expected a function");
  return value as (...args: any[]) => any;
}

function writeSettings(agentDir: string, value: unknown): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(value));
}

async function runCommand(
  harness: ReturnType<typeof createHarness>,
  args: string,
): Promise<void> {
  await callable(harness.command("tps").handler)(args, harness.ctx);
}

async function stream(
  harness: ReturnType<typeof createHarness>,
  delta: string,
  type = "text_delta",
  output?: number,
): Promise<void> {
  await harness.fire("message_update", {
    message: {
      role: "assistant",
      usage: output === undefined ? {} : { output },
    },
    assistantMessageEvent: { type, delta },
  });
}

describe("TPS status", () => {
  let agentDir: string;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    agentDir = mkdtempSync(join(tmpdir(), "pi-widgets-tps-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(agentDir, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("measures streamed output and excludes overlapping shell work", async () => {
    const harness = createHarness();
    tpsStatus(harness.pi);
    await harness.fire("session_start");
    await harness.fire("before_agent_start");
    await harness.fire("before_agent_start");
    await harness.fire("agent_start");
    await harness.fire("turn_start");

    vi.advanceTimersByTime(100);
    await stream(harness, "test");
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "tps",
      "\u001b[38;2;255;0;0m10.0 tok/s\u001b[39m",
    );
    expect(harness.setWorkingMessage).toHaveBeenLastCalledWith(
      "<muted> · 10.0 tok/s · TTFT 100ms</muted>",
    );

    await stream(harness, "", "text_delta");
    await stream(harness, "ignored", "audio_delta");
    await harness.fire("message_update", { message: { role: "user" } });

    vi.advanceTimersByTime(100);
    await harness.fire("tool_execution_start", { toolName: "bash", toolCallId: "one" });
    await harness.fire("tool_execution_start", { toolName: "bash", toolCallId: "one" });
    await harness.fire("tool_execution_start", {
      toolName: "powershell",
      toolCallId: "two",
    });
    await harness.fire("tool_execution_start", { toolName: "read", toolCallId: "read" });
    vi.advanceTimersByTime(1_000);
    await harness.fire("tool_execution_end", { toolName: "bash", toolCallId: "missing" });
    await harness.fire("tool_execution_end", { toolName: "bash", toolCallId: "one" });
    await harness.fire("tool_execution_end", { toolName: "powershell", toolCallId: "two" });
    await harness.fire("tool_execution_end", { toolName: "read", toolCallId: "read" });

    await harness.fire("message_end", {
      message: { role: "assistant", usage: { output: 8 } },
    });
    expect(harness.setStatus.mock.calls.at(-1)?.[1]).toContain("40.0 tok/s");
    expect(harness.eventEmit).toHaveBeenCalledWith("zentui:extension-status-color", {
      key: "tps",
      color: "#1aaa13",
    });

    await harness.fire("turn_start");
    vi.advanceTimersByTime(100);
    await stream(harness, "😀😀😀😀", "thinking_delta");
    await stream(harness, "abcd", "toolcall_delta", 4);
    await harness.fire("message_end", {
      message: { role: "assistant", usage: { output: Number.NaN } },
    });
    await harness.fire("message_end", { message: { role: "user" } });
    await harness.fire("agent_end");
    await harness.fire("agent_settled");
    await harness.fire("agent_settled");

    expect(harness.setWorkingMessage).toHaveBeenCalledWith("");
    await harness.fire("session_shutdown");
    expect(harness.setStatus).toHaveBeenCalledWith("tps", undefined);
  });

  it("handles every command and completion path", async () => {
    const harness = createHarness();
    tpsStatus(harness.pi);
    const command = harness.command("tps");
    const complete = callable(command.getArgumentCompletions);

    expect(complete("bar o")).toEqual([
      { value: "bar on", label: "bar on" },
      { value: "bar off", label: "bar off" },
    ]);
    expect(complete("missing")).toBeNull();

    await runCommand(harness, "help");
    expect(harness.notify.mock.calls.at(-1)?.[0]).toContain("TPS/TTFT commands:");
    await runCommand(harness, "");
    expect(harness.notify).toHaveBeenLastCalledWith(
      "No TPS/TTFT measurement yet · bar on · line on",
      "info",
    );
    await runCommand(harness, "status");
    await runCommand(harness, "on");

    await harness.fire("before_agent_start");
    for (const value of ["off", "on", "toggle", "on"] as const) {
      await runCommand(harness, value);
    }
    expect(harness.notify).toHaveBeenCalledWith("TPS metrics disabled.", "info");
    expect(harness.notify).toHaveBeenCalledWith("TPS metrics enabled.", "info");

    await runCommand(harness, "bar off");
    await runCommand(harness, "line off");
    await runCommand(harness, "status");
    expect(harness.notify.mock.calls.at(-1)?.[0]).toContain("bar off · line off");

    for (const target of ["bar", "line", "ttft"] as const) {
      for (const value of ["off", "on", "toggle"] as const) {
        await runCommand(harness, `${target} ${value}`);
      }
    }
    expect(harness.notify).toHaveBeenCalledWith("bar disabled.", "info");
    expect(harness.notify).toHaveBeenCalledWith("line enabled.", "info");
    expect(harness.notify).toHaveBeenCalledWith("ttft disabled.", "info");

    for (const invalid of ["invalid", "bar", "bar invalid", "on extra"] as const) {
      await runCommand(harness, invalid);
      expect(harness.notify).toHaveBeenLastCalledWith(
        "Unknown TPS command. Run /tps help for usage.",
        "warning",
      );
    }
    await harness.fire("session_shutdown");
  });

  it("uses exact usage updates and Zentui working-line segments", async () => {
    writeSettings(agentDir, {
      "pi-tps-status": {
        enabled: true,
        statusBar: false,
        workingLine: true,
        showTTFT: false,
        refreshMs: 100,
      },
    });
    const harness = createHarness({ zentuiSegments: true });
    tpsStatus(harness.pi);
    await harness.fire("session_start");
    await harness.fire("agent_start");
    await harness.fire("turn_start");
    vi.advanceTimersByTime(100);
    await harness.fire("message_update", {
      message: { role: "assistant", usage: { output: 100 } },
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    });

    expect(harness.setStatus).not.toHaveBeenCalledWith("tps", expect.any(String));
    expect(harness.eventEmit).toHaveBeenCalledWith("zentui:working-line-segment", {
      key: "tps",
      text: "1000 tok/s",
    });

    await harness.fire("agent_settled");
    expect(harness.eventEmit).toHaveBeenCalledWith("zentui:working-line-segment", {
      key: "tps",
      text: undefined,
    });
    expect(harness.setWorkingMessage).not.toHaveBeenCalled();
    await harness.fire("session_shutdown");
  });

  it("restores the normal working line when shutdown occurs mid-response", async () => {
    const harness = createHarness();
    tpsStatus(harness.pi);
    await harness.fire("turn_start");
    vi.advanceTimersByTime(2_000);
    await stream(harness, "abcdefgh");
    expect(harness.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("TTFT 2.00s");

    await harness.fire("session_shutdown");
    expect(harness.setWorkingMessage).toHaveBeenLastCalledWith(undefined);
  });

  it("formats long TTFT values and high throughput", async () => {
    const harness = createHarness();
    tpsStatus(harness.pi);
    await harness.fire("before_agent_start");
    await harness.fire("turn_start");
    vi.advanceTimersByTime(10_001);
    await stream(harness, "x".repeat(8_000));

    expect(harness.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("TTFT 10.0s");
    expect(harness.setStatus.mock.calls.at(-1)?.[1]).toContain("200 tok/s");
    await harness.fire("agent_settled");
  });

  it("moves from green through cyan to purple at high throughput", async () => {
    const cases = [
      { durationMs: 200, output: 15, color: "#4dc5dc" },
      { durationMs: 400, output: 35, color: "#6087b4" },
      { durationMs: 200, output: 20, color: "#73488b" },
      { durationMs: 200, output: 30, color: "#73488b" },
    ];

    for (const { durationMs, output, color } of cases) {
      vi.setSystemTime(0);
      const harness = createHarness();
      tpsStatus(harness.pi);
      await harness.fire("before_agent_start");
      await harness.fire("turn_start");
      vi.advanceTimersByTime(durationMs);
      await stream(harness, "x", "text_delta", output);
      expect(harness.eventEmit).toHaveBeenCalledWith("zentui:extension-status-color", {
        key: "tps",
        color,
      });
      await harness.fire("session_shutdown");
    }
  });

  it("waits for a measurable interval and output before showing TPS", async () => {
    const harness = createHarness();
    tpsStatus(harness.pi);
    await harness.fire("before_agent_start");
    await harness.fire("turn_start");
    vi.advanceTimersByTime(10);
    await stream(harness, "abcd");
    expect(harness.setStatus).not.toHaveBeenCalledWith("tps", expect.any(String));

    await harness.fire("message_end", {
      message: { role: "assistant", usage: { output: 0 } },
    });
    await harness.fire("turn_start");
    await harness.fire("message_end", { message: { role: "assistant", usage: {} } });
    await harness.fire("agent_settled");
  });

  it("clamps refresh settings and honors disabled defaults", async () => {
    writeSettings(agentDir, {
      "pi-tps-status": {
        enabled: false,
        statusBar: "invalid",
        workingLine: "invalid",
        showTTFT: "invalid",
        refreshMs: 1,
      },
    });
    const harness = createHarness();
    tpsStatus(harness.pi);
    await harness.fire("session_start");
    await harness.fire("before_agent_start");
    await harness.fire("turn_start");
    vi.advanceTimersByTime(1_000);
    expect(harness.setWorkingMessage).not.toHaveBeenCalled();

    await runCommand(harness, "on");
    await runCommand(harness, "on");
    vi.advanceTimersByTime(99);
    const callsBeforeRefresh = harness.setWorkingMessage.mock.calls.length;
    vi.advanceTimersByTime(1);
    expect(harness.setWorkingMessage.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
    await harness.fire("session_shutdown");
  });

  it("rounds valid refresh settings and clamps their upper bound", async () => {
    writeSettings(agentDir, {
      "pi-tps-status": { refreshMs: 9_999, showTTFT: true },
    });
    const harness = createHarness();
    tpsStatus(harness.pi);
    await harness.fire("session_start");
    await harness.fire("before_agent_start");
    vi.advanceTimersByTime(1_999);
    const before = harness.setWorkingMessage.mock.calls.length;
    vi.advanceTimersByTime(1);
    expect(harness.setWorkingMessage.mock.calls.length).toBeGreaterThan(before);
    await harness.fire("session_shutdown");

    writeSettings(agentDir, { "pi-tps-status": { refreshMs: 250.6 } });
    const rounded = createHarness();
    tpsStatus(rounded.pi);
    await rounded.fire("before_agent_start");
    vi.advanceTimersByTime(251);
    expect(rounded.setWorkingMessage.mock.calls.length).toBeGreaterThan(1);
    await rounded.fire("session_shutdown");
  });

  it("handles out-of-order events and commits a response without updates", async () => {
    writeSettings(agentDir, { "pi-tps-status": { refreshMs: "fast" } });
    const harness = createHarness();
    tpsStatus(harness.pi);

    await harness.fire("message_update", {
      message: { role: "assistant", usage: { output: 3 } },
    });
    await harness.fire("message_end", {
      message: { role: "assistant", usage: { output: 3 } },
    });
    await harness.fire("agent_end");

    await harness.fire("agent_start");
    await harness.fire("turn_start");
    await harness.fire("message_update", {
      message: { role: "assistant", usage: { output: 3 } },
      assistantMessageEvent: null,
    });
    vi.advanceTimersByTime(100);
    await harness.fire("tool_execution_start", { toolName: "bash", toolCallId: "open" });
    vi.advanceTimersByTime(100);
    await harness.fire("agent_settled");
    expect(harness.setStatus.mock.calls.at(-1)?.[1]).toContain("30.0 tok/s");
    await harness.fire("agent_end");
    await harness.fire("session_shutdown");

    const directCommit = createHarness();
    tpsStatus(directCommit.pi);
    await directCommit.fire("agent_start");
    await directCommit.fire("turn_start");
    vi.advanceTimersByTime(100);
    await directCommit.fire("message_end", {
      message: { role: "assistant", usage: { output: 5 } },
    });
    expect(directCommit.setStatus.mock.calls.at(-1)?.[1]).toContain("50.0 tok/s");
    await directCommit.fire("agent_settled");
  });

  it("falls back safely for malformed settings", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{");
    const malformed = createHarness();
    tpsStatus(malformed.pi);
    await malformed.fire("session_start");
    await malformed.fire("before_agent_start");
    expect(malformed.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("TTFT 0ms…");
    await malformed.fire("session_shutdown");

    writeFileSync(join(agentDir, "settings.json"), "[]");
    const primitive = createHarness();
    tpsStatus(primitive.pi);
    await primitive.fire("session_start");
    await primitive.fire("session_shutdown");

    writeSettings(agentDir, { "pi-tps-status": [] });
    const array = createHarness();
    tpsStatus(array.pi);
    await array.fire("session_start");
    await array.fire("session_shutdown");
  });
});
