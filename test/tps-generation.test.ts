import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tps from "../extensions/tps.js";
import { createHarness } from "./harness.js";

describe("request-average output throughput", () => {
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

  it("includes long hidden reasoning before a short content burst in finalized throughput", async () => {
    await start();
    vi.advanceTimersByTime(350_000);
    await delta("short answer");
    vi.advanceTimersByTime(2_000);
    await harness.fire("message_end", {
      message: { role: "assistant", usage: { output: 10_867, reasoning: 10_286 } },
    });
    expect(footer()).toContain("30.9 tok/s");
    expect(await status()).not.toContain("TTFT");
  });

  it("distinguishes the first server event from the first nonempty content", async () => {
    await start();
    vi.advanceTimersByTime(700);
    await harness.fire("provider_stream_event", { data: { type: "response.created" } });
    expect(await status()).toBe("TTFT 700ms · bar on · line on");
    expect(footer()).toBeUndefined();
    await delta("", "thinking_delta");
    vi.advanceTimersByTime(4_500);
    await harness.fire("provider_stream_event", { data: { type: "response.reasoning_text.delta" } });
    await delta("think", "thinking_delta");
    vi.advanceTimersByTime(500);
    await delta("prose");
    expect(await status()).toContain("TTFT 700ms");
    expect(await status()).not.toMatch(/Event|Content/);
    await end(57);
    expect(footer()).toContain("10.0 tok/s");
  });

  it("reports request-average throughput after a 10-second wait", async () => {
    await start();
    vi.advanceTimersByTime(10_000);
    await delta("a");
    expect(footer()).toContain("0.1 tok/s");
    expect(await status()).not.toContain("TTFT");
    vi.advanceTimersByTime(2_000);
    await delta("b".repeat(399));
    expect(await status()).toBe("8.3 tok/s · bar on · line on");
    await end(100);
    expect(footer()).toContain("8.3 tok/s");
    expect(footer()).not.toContain("est.");
  });

  it("sums matching request durations without inventing first-event latency", async () => {
    await start();
    vi.advanceTimersByTime(500);
    await delta("read", "toolcall_delta");
    vi.advanceTimersByTime(1_000);
    await end(20);
    expect(footer()).toContain("13.3 tok/s");
    await harness.fire("tool_execution_start", { toolName: "read", toolCallId: "file" });
    vi.advanceTimersByTime(60_000);
    await harness.fire("message_end", {
      message: { role: "toolResult", content: "x".repeat(50_000), usage: { output: 99_999 } },
    });
    await harness.fire("tool_execution_end", { toolName: "read", toolCallId: "file" });
    await start();
    vi.advanceTimersByTime(10_000);
    expect(await status()).toContain("13.3 tok/s");
    await delta("think", "thinking_delta");
    expect(await status()).toContain("1.9 tok/s");
    vi.advanceTimersByTime(3_000);
    await end(100);
    // 120 / (1.5 + 13), not the mean of the individual response rates.
    expect(footer()).toContain("8.3 tok/s");
    await harness.fire("agent_settled");
    vi.advanceTimersByTime(60_000);
    expect(await status()).toContain("8.3 tok/s");
  });

  it("measures buffered usage-only responses with a real request window", async () => {
    await start();
    vi.advanceTimersByTime(10_000);
    await harness.fire("message_update", {
      message: { role: "assistant", usage: { output: 5_000 } },
      assistantMessageEvent: { type: "text_start" },
    });
    await end(5_000);
    expect(footer()).toContain("500 tok/s");
    expect(await status()).not.toContain("TTFT");
    await start();
    await delta("x");
    vi.advanceTimersByTime(1_000);
    await end(10);
    expect(footer()).toContain("455 tok/s"); // 5010 / 11 seconds
  });

  it.each(["thinking_delta", "toolcall_delta"])(
    "does not treat %s before prose as a first-server-event timestamp", async (type) => {
      await start();
      vi.advanceTimersByTime(100);
      await delta("", type);
      vi.advanceTimersByTime(100);
      await delta("first", type);
      vi.advanceTimersByTime(800);
      await delta("prose");
      await end(20);
      expect(await status()).not.toContain("TTFT");
      expect(footer()).toContain("20.0 tok/s");
    },
  );

  it("does not pair untimed buffered tokens with a later timed response", async () => {
    await harness.fire("turn_start");
    await harness.fire("message_start", { message: { role: "assistant" } });
    vi.advanceTimersByTime(10_000);
    await end(5_000);
    expect(footer()).toBeUndefined();
    await start();
    vi.advanceTimersByTime(1_000);
    await end(10);
    expect(footer()).toContain("10.0 tok/s");
  });

  it("does not turn a too-short response into a misleading rate", async () => {
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
    expect(await status()).toBe("20.0 tok/s · bar on · line on");
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
    expect(await status()).not.toContain("TTFT");
    vi.advanceTimersByTime(500);
    await harness.fire("ui_prompt_start");
    vi.advanceTimersByTime(60_000);
    await harness.fire("ui_prompt_end");
    vi.advanceTimersByTime(500);
    await end(50);
    expect(footer()).toContain("41.7 tok/s");
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

  it("keeps missing and zero usage without deltas unknown", async () => {
    for (const message of [
      { role: "assistant" },
      { role: "assistant", usage: null },
      { role: "assistant", usage: { output: 0, reasoning: 100 } },
    ]) {
      await start();
      vi.advanceTimersByTime(1_000);
      await harness.fire("message_end", { message });
      expect(footer()).toBeUndefined();
      expect(await status()).not.toContain("unknown");
    }
  });

  it("does not fabricate throughput or latency without a provider-request hook", async () => {
    await harness.fire("turn_start");
    vi.advanceTimersByTime(10_000);
    await harness.fire("message_start", { message: { role: "assistant" } });
    await delta("a");
    vi.advanceTimersByTime(1_000);
    await end(50);
    expect(footer()).toBeUndefined();
    expect(await status()).not.toContain("unknown");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("uses plain tok/s for live and finalized fallback estimates (Zentui: %s)",
    async (zentuiSegments) => {
      harness = createHarness({ zentuiSegments });
      tps(harness.pi);
      await start();
      vi.advanceTimersByTime(100);
      await delta("a".repeat(40));
      vi.advanceTimersByTime(1_000);
      expect(await status()).toBe("9.1 tok/s · bar on · line on");
      await end(); // No provider count: the finalized fallback stays estimated internally.
      expect(await status()).toBe("9.1 tok/s · bar on · line on");
      const displayed = [
        ...harness.setStatus.mock.calls.map((call) => call[1]),
        ...harness.setWorkingMessage.mock.calls.map((call) => call[0]),
        ...harness.notify.mock.calls.map((call) => call[0]),
        ...harness.eventEmit.mock.calls.map((call) => (call[1] as { text?: string }).text),
      ].filter((text): text is string => typeof text === "string");
      expect(displayed.some((text) => text.includes("tok/s"))).toBe(true);
      for (const text of displayed) expect(text).not.toMatch(/est\.|\bavg\b/);
    },
  );

  it.each([undefined, 0, 40])("does not add or subtract reasoning breakdown %s", async (reasoning) => {
    await start();
    await delta("think", "thinking_delta");
    vi.advanceTimersByTime(1_000);
    await harness.fire("message_end", {
      message: { role: "assistant", usage: {
        input: 50_000, cacheRead: 30_000, cacheWrite: 20_000,
        output: 50, reasoning, totalTokens: 100_050,
      } },
    });
    expect(footer()).toContain("50.0 tok/s");
  });
});
