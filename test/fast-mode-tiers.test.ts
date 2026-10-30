import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import gptFastModeStatus from "../extensions/fast-mode.js";
import { createHarness } from "./harness.js";

const MODEL = { provider: "openai-codex", id: "gpt-6.1-sol" };
const FAST_REQUESTED = "<warning> Fast (requested)</warning>";
type Harness = ReturnType<typeof createHarness>;

async function command(harness: Harness, name: string, args = ""): Promise<void> {
  const handler = harness.command(name).handler;
  if (typeof handler !== "function") throw new Error("Expected a command handler");
  await handler(args, harness.ctx);
}

async function request(harness: Harness): Promise<void> {
  await harness.fire("before_provider_request", { payload: { model: MODEL.id } });
}

async function completed(harness: Harness, tier: unknown): Promise<void> {
  await harness.fire("provider_stream_event", {
    provider: harness.ctx.model?.provider ?? MODEL.provider,
    model: MODEL.id,
    data: { type: "response.completed", response: { service_tier: tier } },
  });
}

describe("GPT service-tier confirmation", () => {
  let agentDir: string;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-widgets-tiers-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it.each(["priority", "fast"])("confirms the public API's %s Fast tier", async (tier) => {
    const harness = createHarness({ model: { ...MODEL, provider: "openai" } });
    gptFastModeStatus(harness.pi);
    await command(harness, "fast");
    expect(harness.setStatus).toHaveBeenLastCalledWith("gpt-fast-mode", FAST_REQUESTED);
    await request(harness);
    harness.notify.mockClear();
    await completed(harness, tier);
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "gpt-fast-mode", "<warning> Fast</warning>",
    );
    expect(harness.notify).not.toHaveBeenCalled();
    await command(harness, "fast", " STATUS ");
    expect(harness.notify).toHaveBeenLastCalledWith(
      `Model: openai/gpt-6.1-sol. Requested service_tier: priority. ` +
      `Last reported service_tier: ${tier}.`,
    );
    await request(harness);
    expect(harness.setStatus).toHaveBeenLastCalledWith("gpt-fast-mode", FAST_REQUESTED);
  });

  it.each([
    { mode: "ultrafast", status: "\u001b[38;5;141m⚡\uFE0E Ultrafast\u001b[39m" },
    { mode: "flex", status: "<success>󰿗 Flex</success>" },
  ])("confirms a granted public API $mode tier", async ({ mode, status }) => {
    const harness = createHarness({ model: { ...MODEL, provider: "openai" } });
    gptFastModeStatus(harness.pi);
    await command(harness, mode);
    await request(harness);
    harness.notify.mockClear();
    await completed(harness, mode);
    expect(harness.setStatus).toHaveBeenLastCalledWith("gpt-fast-mode", status);
    expect(harness.notify).not.toHaveBeenCalled();
    await command(harness, "fast", "status");
    expect(harness.notify).toHaveBeenLastCalledWith(
      `Model: openai/gpt-6.1-sol. Requested service_tier: ${mode}. ` +
      `Last reported service_tier: ${mode}.`,
    );
  });

  it.each(["fast", "ultrafast", "flex"].flatMap((mode) =>
    ["auto", "default", "standard", "priority", "fast", "ultrafast", "flex", "scale"]
      .map((tier) => ({ mode, tier })),
  ))("does not infer a Codex $mode outcome from reported $tier", async ({ mode, tier }) => {
    const harness = createHarness({ model: MODEL });
    gptFastModeStatus(harness.pi);
    await command(harness, mode);
    const requestedStatus = harness.setStatus.mock.lastCall;
    await request(harness);
    harness.notify.mockClear();
    await completed(harness, tier);
    expect(harness.setStatus).toHaveBeenLastCalledWith(...requestedStatus!);
    expect(harness.notify).not.toHaveBeenCalled();
    await command(harness, "fast", "status");
    expect(harness.notify).toHaveBeenLastCalledWith(
      `Model: openai-codex/gpt-6.1-sol. Requested service_tier: ${mode === "fast" ? "priority" : mode}. ` +
      `Last reported service_tier: ${tier}. ` +
      "Codex response metadata does not confirm the applied tier.",
    );
  });

  it.each([
    null,
    [],
    "response.completed",
    {},
    { type: "response.created", response: { service_tier: "priority" } },
    { type: "response.completed" },
    { type: "response.completed", response: null },
    { type: "response.completed", response: [] },
    { type: "response.completed", response: "priority" },
    { type: "response.completed", response: {} },
    { type: "response.completed", response: { service_tier: null } },
    { type: "response.completed", response: { service_tier: [] } },
    { type: "response.completed", response: { service_tier: 1 } },
    { type: "response.completed", response: { service_tier: "" } },
    { type: "response.completed", response: { service_tier: "unknown" } },
    { type: "response.completed", response: { service_tier: "\u001b[2Jpriority" } },
  ])("keeps malformed or untrusted completion metadata unconfirmed: %j", async (data) => {
    const harness = createHarness({ model: MODEL });
    gptFastModeStatus(harness.pi);
    await command(harness, "fast");
    await request(harness);
    harness.setStatus.mockClear();
    harness.notify.mockClear();
    await harness.fire("provider_stream_event", {
      provider: MODEL.provider, model: MODEL.id, data,
    });
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
    await command(harness, "fast", "status");
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Model: openai-codex/gpt-6.1-sol. Requested service_tier: priority. " +
      "Last reported service_tier: unconfirmed.",
    );
  });

  it("ignores completions without a matching enabled request", async () => {
    const harness = createHarness({ model: MODEL });
    gptFastModeStatus(harness.pi);
    await harness.fire("session_start");
    harness.setStatus.mockClear();
    await completed(harness, "priority");
    expect(harness.setStatus).not.toHaveBeenCalled();
    await command(harness, "fast");
    harness.setStatus.mockClear();
    await completed(harness, "priority");
    expect(harness.setStatus).not.toHaveBeenCalled();
    await request(harness);
    harness.setStatus.mockClear();
    for (const model of [
      { provider: "openai", model: MODEL.id },
      { provider: MODEL.provider, model: "gpt-6-astra" },
    ]) {
      await harness.fire("provider_stream_event", {
        ...model,
        data: { type: "response.completed", response: { service_tier: "priority" } },
      });
    }
    harness.ctx.model = { ...harness.ctx.model!, id: "gpt-6-astra" };
    await completed(harness, "priority");
    harness.ctx.model = undefined;
    await completed(harness, "priority");
    expect(harness.setStatus).not.toHaveBeenCalled();
  });

  it("reports off and unconfirmed status without toggling", async () => {
    const harness = createHarness();
    gptFastModeStatus(harness.pi);
    await command(harness, "fast", "status");
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Model: unknown model. Requested service_tier: off. " +
      "Last reported service_tier: unconfirmed.",
    );
    expect(harness.setStatus).not.toHaveBeenCalled();
    await command(harness, "fast");
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "gpt-fast-mode", "<warning> Fast (unsupported)</warning>",
    );
    await command(harness, "fast", "status");
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Model: unknown model. Requested service_tier: priority. " +
      "Last reported service_tier: unconfirmed.",
    );
    await command(harness, "fast");
    expect(harness.setStatus).toHaveBeenLastCalledWith("gpt-fast-mode", undefined);
  });

  it("clears confirmation across mode changes and model switches", async () => {
    const harness = createHarness({ model: MODEL });
    gptFastModeStatus(harness.pi);
    await command(harness, "fast");
    await request(harness);
    await completed(harness, "priority");
    await command(harness, "ultrafast");
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "gpt-fast-mode", "\u001b[38;5;141m⚡\uFE0E Ultrafast (requested)\u001b[39m",
    );
    await request(harness);
    await completed(harness, "ultrafast");
    harness.ctx.model = { ...harness.ctx.model!, id: "gpt-6-sol" };
    await harness.fire("model_select");
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "gpt-fast-mode", "\u001b[38;5;141m⚡\uFE0E Ultrafast (unsupported)\u001b[39m",
    );
    harness.ctx.model = { ...harness.ctx.model!, ...MODEL };
    await harness.fire("model_select");
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "gpt-fast-mode", "\u001b[38;5;141m⚡\uFE0E Ultrafast (requested)\u001b[39m",
    );
    await command(harness, "fast", "status");
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Model: openai-codex/gpt-6.1-sol. Requested service_tier: ultrafast. " +
      "Last reported service_tier: unconfirmed.",
    );
  });

  it("clears confirmation on shutdown and reloads the session default", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      "pi-gpt-fast-mode": { enabled: true },
    }));
    const harness = createHarness({ model: MODEL });
    gptFastModeStatus(harness.pi);
    await harness.fire("session_start");
    await request(harness);
    await completed(harness, "priority");
    await harness.fire("session_shutdown");
    expect(harness.setStatus).toHaveBeenLastCalledWith("gpt-fast-mode", undefined);
    await command(harness, "fast", "status");
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Model: openai-codex/gpt-6.1-sol. Requested service_tier: priority. " +
      "Last reported service_tier: unconfirmed.",
    );
    await harness.fire("session_start");
    expect(harness.setStatus).toHaveBeenLastCalledWith("gpt-fast-mode", FAST_REQUESTED);
  });

  it("preserves max effort and unrelated request fields while switching speed modes", async () => {
    const harness = createHarness({ model: MODEL });
    gptFastModeStatus(harness.pi);
    const payload = {
      model: MODEL.id,
      reasoning: { effort: "max", summary: "auto" },
      stream: true,
      instructions: "Keep this instruction.",
      metadata: { request: "original" },
      service_tier: "default",
    };
    const original = structuredClone(payload);
    for (const mode of ["fast", "ultrafast", "flex"]) {
      await command(harness, mode);
      await expect(harness.fire("before_provider_request", { payload })).resolves.toEqual([
        { ...original, service_tier: mode === "fast" ? "priority" : mode },
      ]);
      expect(payload).toEqual(original);
    }
    await command(harness, "flex");
    await expect(harness.fire("before_provider_request", { payload })).resolves.toEqual([
      undefined,
    ]);
    expect(payload).toEqual(original);
  });
});
