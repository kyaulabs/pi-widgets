import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tps from "../extensions/tps.js";
import { createHarness } from "./harness.js";

describe("observed generation speed", () => {
  let harness: ReturnType<typeof createHarness>;
  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "pi-generation-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    harness = createHarness();
    tps(harness.pi);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    await harness.fire("turn_start");
    await harness.fire("before_provider_request");
  }
  async function delta(text: string, type = "text_delta", output = 0) {
    await harness.fire("message_update", {
      message: { role: "assistant", usage: { output } },
      assistantMessageEvent: { type, delta: text },
    });
  }
  async function end(output?: number) {
    await harness.fire("message_end", {
      message: { role: "assistant", usage: { output } },
    });
  }
  async function status() {
    const handler = harness.command("tps").handler;
    if (typeof handler !== "function") throw new Error("Missing command");
    await handler("status", harness.ctx);
    return harness.notify.mock.calls.at(-1)?.[0];
  }
  function footer() { return harness.setStatus.mock.calls.at(-1)?.[1]; }

  it("reports 50 tok/s for 100 tokens generated in 2 seconds after a 10-second wait", async () => {
    await start();
    vi.advanceTimersByTime(10_000);
    await delta("a");
    expect(footer()).toBeUndefined();
    expect(await status()).toContain("TTFT 10.0s");
    vi.advanceTimersByTime(2_000);
    await delta("b".repeat(399));
    expect(await status()).toBe("50.0 tok/s · TTFT 10.0s · bar on · line on");
    await end(100);
    expect(footer()).toContain("50.0 tok/s");
    expect(footer()).not.toContain("est.");
  });

  it("excludes every response's initial wait and reports per-response TTFT", async () => {
    await start();
    vi.advanceTimersByTime(500);
    await delta("read", "toolcall_delta");
    vi.advanceTimersByTime(1_000);
    await end(20);
    expect(footer()).toContain("20.0 tok/s");
    await harness.fire("tool_execution_start", { toolName: "read", toolCallId: "file" });
    vi.advanceTimersByTime(60_000);
    await harness.fire("message_end", {
      message: { role: "toolResult", content: "x".repeat(50_000), usage: { output: 99_999 } },
    });
    await harness.fire("tool_execution_end", { toolName: "read", toolCallId: "file" });
    await start();
    vi.advanceTimersByTime(10_000);
    expect(await status()).toContain("20.0 tok/s · TTFT 10.0s…");
    await delta("think", "thinking_delta");
    expect(await status()).toContain("20.0 tok/s · TTFT 10.0s");
    vi.advanceTimersByTime(3_000);
    await end(100);
    // Weighted by generation time, not the mean of the two response rates.
    expect(footer()).toContain("30.0 tok/s");
    await harness.fire("agent_settled");
    vi.advanceTimersByTime(60_000);
    expect(await status()).toContain("30.0 tok/s · TTFT 10.0s");
  });

  it("does not invent timing from usage-only messages or fold untimed tokens into later rates", async () => {
    await start();
    vi.advanceTimersByTime(10_000);
    await harness.fire("message_update", {
      message: { role: "assistant", usage: { output: 5_000 } },
      assistantMessageEvent: { type: "text_start" },
    });
    await end(5_000);
    expect(footer()).toBeUndefined();
    expect(await status()).toContain("No TPS/TTFT measurement yet");
    await start();
    await delta("x");
    vi.advanceTimersByTime(1_000);
    await end(10);
    expect(footer()).toContain("10.0 tok/s");
  });

  it("does not turn a buffered or too-short response into a misleading rate", async () => {
    await start();
    await delta("x".repeat(4_000));
    vi.advanceTimersByTime(10);
    await end(1_000);
    expect(footer()).toBeUndefined();
    await start();
    await delta("x");
    vi.advanceTimersByTime(1_000);
    await end(10);
    expect(footer()).toContain("10.0 tok/s");
  });

  it("retains fallback counts after completion when exact usage is missing", async () => {
    await start();
    await delta("😀😀😀😀", "thinking_delta");
    vi.advanceTimersByTime(1_000);
    await delta("abcd", "toolcall_delta");
    await end();
    expect(footer()).toContain("2.0 tok/s");
    await start();
    await delta("text");
    vi.advanceTimersByTime(1_000);
    await end(10);
    expect(footer()).toContain("6.0 tok/s");
    await harness.fire("agent_settled");
    await start();
    await delta("text");
    vi.advanceTimersByTime(1_000);
    await end(10);
    expect(footer()).toContain("10.0 tok/s");
    expect(footer()).not.toContain("est.");
  });

  it("never treats a stale positive partial usage count as an exact live total", async () => {
    await start();
    await delta("a".repeat(40), "text_delta", 10);
    vi.advanceTimersByTime(1_000);
    await delta("b".repeat(40), "text_delta", 10);
    expect(await status()).toBe("20.0 tok/s · TTFT 0ms · bar on · line on");
    await end(25);
    expect(footer()).toContain("25.0 tok/s");
    expect(footer()).not.toContain("est.");
  });

  it("excludes UI pauses both before and after the first output", async () => {
    await start();
    vi.advanceTimersByTime(100);
    await harness.fire("ui_prompt_start");
    vi.advanceTimersByTime(60_000);
    await harness.fire("ui_prompt_end");
    vi.advanceTimersByTime(100);
    await delta("a");
    expect(await status()).toContain("TTFT 200ms");
    vi.advanceTimersByTime(500);
    await harness.fire("ui_prompt_start");
    vi.advanceTimersByTime(60_000);
    await harness.fire("ui_prompt_end");
    vi.advanceTimersByTime(500);
    await end(50);
    expect(footer()).toContain("50.0 tok/s");
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps fallback counts when final usage is %s", async (usage) => {
      await start();
      await delta("a".repeat(40));
      vi.advanceTimersByTime(1_000);
      await end(usage);
      expect(footer()).toContain("10.0 tok/s");
    },
  );

  it("measures generation but omits unavailable TTFT without a provider-request hook", async () => {
    await harness.fire("turn_start");
    vi.advanceTimersByTime(10_000);
    await harness.fire("message_start", { message: { role: "assistant" } });
    await delta("a");
    vi.advanceTimersByTime(1_000);
    await end(50);
    expect(footer()).toContain("50.0 tok/s");
    expect(await status()).not.toContain("TTFT");
  });

  it.each([false, true])("never labels metrics as estimates (Zentui: %s)",
    async (zentuiSegments) => {
      harness = createHarness({ zentuiSegments });
      tps(harness.pi);
      await start();
      vi.advanceTimersByTime(100);
      await delta("a".repeat(40));
      vi.advanceTimersByTime(1_000);
      expect(await status()).toBe("10.0 tok/s · TTFT 100ms · bar on · line on");
      await end(); // No provider count: the finalized fallback must use the same plain UI.
      expect(await status()).toBe("10.0 tok/s · TTFT 100ms · bar on · line on");
      const displayed = [
        ...harness.setStatus.mock.calls.map((call) => call[1]),
        ...harness.setWorkingMessage.mock.calls.map((call) => call[0]),
        ...harness.notify.mock.calls.map((call) => call[0]),
        ...harness.eventEmit.mock.calls.map((call) => (call[1] as { text?: string }).text),
      ].filter((text): text is string => typeof text === "string");
      expect(displayed.some((text) => text.includes("tok/s"))).toBe(true);
      for (const text of displayed) expect(text).not.toMatch(/est\.|estimate|~|≈/i);
    },
  );

  it("does not count input, cache or reasoning breakdown twice", async () => {
    await start();
    await delta("think", "thinking_delta");
    vi.advanceTimersByTime(1_000);
    await harness.fire("message_end", {
      message: { role: "assistant", usage: {
        input: 50_000, cacheRead: 30_000, cacheWrite: 20_000,
        output: 50, reasoning: 40, totalTokens: 100_050,
      } },
    });
    expect(footer()).toContain("50.0 tok/s");
  });
});
