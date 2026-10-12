import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tps from "../extensions/tps.js";
import { createHarness } from "./harness.js";

describe("TPS provider timing", () => {
  let harness: ReturnType<typeof createHarness>;
  let agentDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    agentDir = mkdtempSync(join(tmpdir(), "pi-tps-metering-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    harness = createHarness();
    tps(harness.pi);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function request() {
    await harness.fire("turn_start");
    await harness.fire("before_provider_request", { payload: {} });
  }

  async function output(tokens = 10, generationMs = 1_000) {
    await harness.fire("message_update", {
      message: { role: "assistant", usage: { output: tokens } },
      assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(tokens * 4) },
    });
    vi.advanceTimersByTime(generationMs);
    // Force a UI refresh when testing samples shorter than the display interval.
    const handler = harness.command("tps").handler;
    if (typeof handler !== "function") throw new Error("Missing TPS handler");
    await handler("bar on", harness.ctx);
  }

  async function end(tokens = 10) {
    await harness.fire("message_end", {
      message: { role: "assistant", usage: { output: tokens } },
    });
  }

  function expectTps(value: string) {
    expect(harness.setStatus.mock.calls.at(-1)?.[1]).toContain(`${value} tok/s`);
  }

  it("excludes prompt hooks, context preparation and credential setup from throughput and latency", async () => {
    await harness.fire("before_agent_start");
    vi.advanceTimersByTime(5_000);
    await harness.fire("agent_start");
    await harness.fire("turn_start");
    await harness.fire("context");
    vi.advanceTimersByTime(5_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.setWorkingMessage).not.toHaveBeenCalled();
    expect(await harness.fire("before_provider_request", { payload: {} })).toEqual([undefined]);
    vi.advanceTimersByTime(100);
    await harness.fire("provider_stream_event", { data: { type: "response.created" } });
    await output(10, 100);
    expectTps("50.0");
    expect(harness.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("TTFT 100ms");
    await end();
  });

  it.each(["bash", "powershell", "read", "write", "edit", "grep", "find", "ls",
    "ask_user_question", "subagent", "custom_network_tool"])(
    "excludes %s execution, preflight, result hooks and inter-turn gaps", async (toolName) => {
      await request();
      vi.advanceTimersByTime(1_000);
      await output();
      await end();
      expectTps("5.0");
      expect(vi.getTimerCount()).toBe(0);
      const calls = harness.setStatus.mock.calls.length;
      vi.advanceTimersByTime(1_000);
      await harness.fire("tool_execution_start", { toolName, toolCallId: "one" });
      await harness.fire("tool_call", { toolName, toolCallId: "one" });
      vi.advanceTimersByTime(10_000);
      // Nested model calls inside tools must not arm or contaminate the meter.
      await harness.fire("before_provider_request");
      await harness.fire("provider_stream_event", { data: { type: "response.created" } });
      await harness.fire("message_start", { message: { role: "assistant" } });
      await output(100_000);
      await end(100_000);
      await harness.fire("tool_result", { toolName, usage: { output: 100_000 } });
      await harness.fire("tool_execution_end", { toolName, toolCallId: "one" });
      await harness.fire("message_end", {
        message: { role: "toolResult", usage: { output: 100_000 } },
      });
      vi.advanceTimersByTime(1_000);
      expect(harness.setStatus.mock.calls.length).toBe(calls);
      await harness.fire("turn_end");
      await harness.fire("turn_start");
      vi.advanceTimersByTime(1_000);
      await harness.fire("before_provider_request");
      vi.advanceTimersByTime(1_000);
      await output(30);
      await end(30);
      await harness.fire("agent_end");
      vi.advanceTimersByTime(5_000);
      await harness.fire("agent_settled");
      expectTps("10.0"); // 40 tokens / 4 seconds of matching request time
    },
  );

  it.each(["session_compact", "session_compact_failed"])(
    "freezes during compaction and resumes only on a request after %s", async (outcome) => {
      await request();
      vi.advanceTimersByTime(1_000);
      await output();
      await end();
      // Between-turn compaction can run inside context preparation, after turn_start.
      await harness.fire("turn_start");
      await harness.fire("session_before_compact");
      await harness.fire("before_provider_request");
      await harness.fire("message_start", { message: { role: "assistant" } });
      vi.advanceTimersByTime(60_000);
      await output(100_000);
      await end(100_000);
      expectTps("5.0");
      expect(vi.getTimerCount()).toBe(0);
      await harness.fire(outcome, { aborted: outcome === "session_compact_failed" });
      vi.advanceTimersByTime(5_000);
      expectTps("5.0");
      await harness.fire("before_provider_request");
      vi.advanceTimersByTime(1_000);
      await output();
      await end();
      await harness.fire("agent_settled");
      expectTps("5.0");
    },
  );

  it("ignores idle compaction, branch summaries, user shell commands and unrelated usage", async () => {
    for (const event of ["session_before_compact", "before_provider_request", "session_compact",
      "session_before_tree", "before_provider_request", "session_tree", "user_bash"]) {
      await harness.fire(event);
      vi.advanceTimersByTime(1_000);
    }
    await harness.fire("message_start", { message: { role: "assistant" } });
    await output();
    await end();
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.setWorkingMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("excludes retry backoff and queued-continuation preparation without resetting totals", async () => {
    await request();
    vi.advanceTimersByTime(100);
    await end(0);
    await harness.fire("agent_end");
    vi.advanceTimersByTime(30_000);
    expect(vi.getTimerCount()).toBe(0);
    await harness.fire("agent_start");
    await request();
    vi.advanceTimersByTime(100);
    await harness.fire("provider_stream_event", { data: { type: "response.created" } });
    await output();
    expect(harness.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("TTFT 100ms");
    await end();
    await harness.fire("agent_end");
    vi.advanceTimersByTime(30_000);
    await harness.fire("before_agent_start");
    await harness.fire("agent_start");
    await request();
    vi.advanceTimersByTime(800);
    await output(30);
    await end(30);
    await harness.fire("agent_settled");
    expectTps("13.8");
  });

  it("excludes blocking UI from throughput and first-event latency, including overlapping lifecycle events", async () => {
    await request();
    vi.advanceTimersByTime(100);
    await harness.fire("ui_prompt_start");
    await harness.fire("ui_prompt_start"); // host notifications are coalesced
    vi.advanceTimersByTime(30_000);
    expect(vi.getTimerCount()).toBe(0);
    await harness.fire("ui_prompt_end");
    await harness.fire("ui_prompt_end");
    vi.advanceTimersByTime(100);
    await harness.fire("provider_stream_event", { data: { type: "response.created" } });
    await output(10, 200);
    expectTps("25.0");
    expect(harness.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("TTFT 200ms");
    await harness.fire("ui_prompt_start");
    vi.advanceTimersByTime(30_000);
    await harness.fire("ui_prompt_end");
    vi.advanceTimersByTime(800);
    await end();
    expectTps("8.3");
  });

  it("does not restart a completed response when a UI prompt closes", async () => {
    await request();
    vi.advanceTimersByTime(1_000);
    await output();
    await harness.fire("ui_prompt_start");
    await end();
    vi.advanceTimersByTime(30_000);
    await harness.fire("ui_prompt_end");
    expect(vi.getTimerCount()).toBe(0);
    await harness.fire("agent_settled");
    expectTps("5.0");
  });

  it("stops on agent_end even without message_end and clears pending latency after abort without output", async () => {
    await request();
    vi.advanceTimersByTime(1_000);
    await harness.fire("agent_end");
    expect(vi.getTimerCount()).toBe(0);
    await harness.fire("agent_settled");
    vi.advanceTimersByTime(30_000);
    const command = harness.command("tps").handler;
    if (typeof command !== "function") throw new Error("Missing TPS handler");
    await command("status", harness.ctx);
    expect(harness.notify.mock.calls.at(-1)?.[0]).toBe(
      "No TPS/TTFT measurement yet · bar on · line on",
    );
    await harness.fire("before_agent_start");
    await request();
    vi.advanceTimersByTime(100);
    await output(10, 100);
    await harness.fire("agent_end");
    vi.advanceTimersByTime(30_000);
    await harness.fire("agent_settled");
    expectTps("50.0");
  });

  it("does not use assistant message start as a fabricated request hook", async () => {
    await harness.fire("turn_start");
    vi.advanceTimersByTime(5_000);
    await harness.fire("message_start", { message: { role: "user" } });
    expect(vi.getTimerCount()).toBe(0);
    await harness.fire("message_start", { message: { role: "assistant" } });
    vi.advanceTimersByTime(100);
    await output(10, 100);
    await end();
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops immediately on abort even if the provider has not ended the message", async () => {
    const controller = new AbortController();
    Object.assign(harness.ctx, { signal: controller.signal });
    await request();
    vi.advanceTimersByTime(100);
    await output(10, 100);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000);
    await output(100_000);
    await end(100_000);
    await harness.fire("agent_settled");
    expectTps("50.0");
    await request(); // already aborted signals cannot start a new clock
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detaches abort listeners on completion and shutdown", async () => {
    const controller = new AbortController();
    Object.assign(harness.ctx, { signal: controller.signal });
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await request();
    await harness.fire("message_start", { message: { role: "assistant" } });
    await end(0);
    expect(remove).toHaveBeenCalledTimes(1);
    await request();
    await harness.fire("session_shutdown");
    expect(remove).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    await harness.fire("session_start");
    Object.assign(harness.ctx, { signal: undefined });
    await request();
    vi.advanceTimersByTime(100);
    await output(10, 100);
    await end();
    expectTps("50.0");
  });

  it.each([false, true])("releases the working line throughout non-LLM work (Zentui: %s)",
    async (zentuiSegments) => {
      harness = createHarness({ zentuiSegments });
      tps(harness.pi);
      await request();
      vi.advanceTimersByTime(1_000);
      await output();
      await end();
      if (zentuiSegments) {
        expect(harness.eventEmit).toHaveBeenLastCalledWith("zentui:working-line-segment", {
          key: "tps", text: undefined,
        });
        expect(harness.setWorkingMessage).not.toHaveBeenCalled();
      } else {
        expect(harness.setWorkingMessage).toHaveBeenLastCalledWith(undefined);
      }
      const calls = harness.eventEmit.mock.calls.length;
      await harness.fire("session_before_compact");
      vi.advanceTimersByTime(60_000);
      expect(harness.eventEmit.mock.calls.length).toBe(calls);
      await harness.fire("session_compact");
      await request();
      vi.advanceTimersByTime(1_000);
      await output();
      await end();
      expectTps("5.0");
    },
  );

  it("does not reset request timing or output on duplicate starts", async () => {
    await request();
    vi.advanceTimersByTime(100);
    await output(10, 100);
    await harness.fire("message_start", { message: { role: "assistant" } });
    await harness.fire("before_provider_request");
    vi.advanceTimersByTime(100);
    await end();
    expectTps("33.3");
  });

  it.each(["headers", "raw", "delta", "end"])(
    "excludes an unhooked retry sample resumed via %s instead of shortening its denominator", async (resume) => {
    await request();
    vi.advanceTimersByTime(100);
    await harness.fire("after_provider_response", { status: 429 });
    vi.advanceTimersByTime(30_000);
    expect(vi.getTimerCount()).toBe(0);
    if (resume === "headers") await harness.fire("after_provider_response", { status: 200 });
    if (resume === "raw") await harness.fire("provider_stream_event", { data: {} });
    vi.advanceTimersByTime(100);
    if (resume !== "end") await output(10, 200);
    await end();
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await request();
    await output(10);
    await end();
    expectTps("10.0");
  });

  it("includes known retry attempt time but excludes backoff when the request hook repeats", async () => {
    await request();
    vi.advanceTimersByTime(100);
    await harness.fire("after_provider_response", { status: 429 });
    vi.advanceTimersByTime(30_000);
    await harness.fire("before_provider_request");
    vi.advanceTimersByTime(100);
    await harness.fire("after_provider_response", { status: 200 });
    await harness.fire("provider_stream_event", { data: { type: "response.created" } });
    await output(10, 200);
    expect(harness.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("TTFT 200ms");
    await end();
    expectTps("25.0"); // 10 / (0.1 failed + 0.3 successful)
    await harness.fire("agent_settled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts timing at the request hook even when assistant message_start arrives first", async () => {
    await harness.fire("turn_start");
    await harness.fire("message_start", { message: { role: "assistant" } });
    vi.advanceTimersByTime(30_000);
    expect(vi.getTimerCount()).toBe(0);
    await harness.fire("provider_stream_event", { data: {} });
    await harness.fire("before_provider_request");
    vi.advanceTimersByTime(100);
    await output(10, 100);
    await end();
    expectTps("50.0");
  });

  it("keeps first-event TTFT after abort before content", async () => {
    const controller = new AbortController();
    Object.assign(harness.ctx, { signal: controller.signal });
    await request();
    vi.advanceTimersByTime(700);
    await harness.fire("provider_stream_event", { data: { type: "response.created" } });
    vi.advanceTimersByTime(10_000);
    controller.abort();
    vi.advanceTimersByTime(30_000);
    const handler = harness.command("tps").handler;
    if (typeof handler !== "function") throw new Error("Missing TPS handler");
    await handler("status", harness.ctx);
    expect(harness.notify.mock.calls.at(-1)?.[0]).toContain("TTFT 700ms");
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
