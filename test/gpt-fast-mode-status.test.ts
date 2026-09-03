import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import gptFastModeStatus from "../extensions/gpt-fast-mode-status.js";
import { createHarness } from "./harness.js";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function handler(value: unknown): (...args: any[]) => any {
  if (typeof value !== "function") throw new Error("Expected a handler");
  return value as (...args: any[]) => any;
}

describe("GPT Fast mode status", () => {
  let agentDir: string;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-widgets-fast-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  });

  it("toggles priority requests for supported models", async () => {
    const harness = createHarness({ model: { provider: "openai", id: "gpt-5.4" } });
    gptFastModeStatus(harness.pi);

    expect([...harness.shortcuts.keys()]).toEqual(["ctrl+alt+m"]);
    await harness.fire("session_start");
    expect(harness.setStatus).toHaveBeenLastCalledWith("gpt-fast-mode", undefined);

    await handler(harness.command("fast").handler)("", harness.ctx);
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "gpt-fast-mode",
      "<warning> Fast</warning>",
    );
    expect(harness.notify).toHaveBeenLastCalledWith(
      "GPT Fast mode enabled (service_tier: priority).",
    );

    await expect(
      harness.fire("before_provider_request", {
        payload: { model: "gpt-5.4", stream: true },
      }),
    ).resolves.toEqual([{ model: "gpt-5.4", stream: true, service_tier: "priority" }]);
    await expect(
      harness.fire("before_provider_request", { payload: { model: "another-model" } }),
    ).resolves.toEqual([undefined]);
    await expect(harness.fire("before_provider_request", { payload: null })).resolves.toEqual([
      undefined,
    ]);

    await handler(harness.shortcut("ctrl+alt+m").handler)(harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith("GPT Fast mode disabled.");
    await expect(
      harness.fire("before_provider_request", { payload: { model: "gpt-5.4" } }),
    ).resolves.toEqual([undefined]);

    await harness.fire("session_shutdown");
    expect(harness.setStatus).toHaveBeenLastCalledWith("gpt-fast-mode", undefined);
  });

  it("warns when Fast mode is enabled for an unsupported or missing model", async () => {
    const harness = createHarness({ model: { provider: "anthropic", id: "claude" } });
    gptFastModeStatus(harness.pi);

    await handler(harness.command("fast").handler)("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(
      "GPT Fast mode enabled, but anthropic/claude is not supported.",
      "warning",
    );
    await expect(
      harness.fire("before_provider_request", { payload: { model: "claude" } }),
    ).resolves.toEqual([undefined]);

    (harness.ctx as any).model = undefined;
    await handler(harness.command("fast").handler)("", harness.ctx);
    await handler(harness.command("fast").handler)("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(
      "GPT Fast mode enabled, but unknown model is not supported.",
      "warning",
    );
  });

  it("loads persistent defaults and filters custom shortcuts", async () => {
    writeJson(join(agentDir, "settings.json"), {
      "pi-gpt-fast-mode": { enabled: true },
    });
    writeJson(join(agentDir, "keybindings.json"), {
      "pi-gpt-fast-mode": [" ctrl+x ", "ctrl+m", "enter", "return", "", 42],
    });
    const harness = createHarness({ model: { provider: "openai-codex", id: "gpt-5.6" } });
    gptFastModeStatus(harness.pi);

    expect([...harness.shortcuts.keys()]).toEqual(["ctrl+x"]);
    await harness.fire("session_start");
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "gpt-fast-mode",
      "<warning> Fast</warning>",
    );
    await expect(
      harness.fire("before_provider_request", { payload: { model: "gpt-5.6" } }),
    ).resolves.toEqual([{ model: "gpt-5.6", service_tier: "priority" }]);
  });

  it("supports disabling shortcuts and falls back from invalid scalar values", () => {
    writeJson(join(agentDir, "keybindings.json"), { "pi-gpt-fast-mode": false });
    const disabled = createHarness();
    gptFastModeStatus(disabled.pi);
    expect(disabled.shortcuts.size).toBe(0);

    writeJson(join(agentDir, "keybindings.json"), { "pi-gpt-fast-mode": 42 });
    const fallback = createHarness();
    gptFastModeStatus(fallback.pi);
    expect([...fallback.shortcuts.keys()]).toEqual(["ctrl+alt+m"]);

    writeJson(join(agentDir, "keybindings.json"), { "pi-gpt-fast-mode": null });
    const nullBinding = createHarness();
    gptFastModeStatus(nullBinding.pi);
    expect(nullBinding.shortcuts.size).toBe(0);
  });

  it("ignores malformed and non-object configuration files", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{");
    writeFileSync(join(agentDir, "keybindings.json"), "[]");
    const malformed = createHarness();
    gptFastModeStatus(malformed.pi);
    await malformed.fire("session_start");
    expect(malformed.setStatus).toHaveBeenLastCalledWith("gpt-fast-mode", undefined);
    expect([...malformed.shortcuts.keys()]).toEqual(["ctrl+alt+m"]);

    writeJson(join(agentDir, "settings.json"), { "pi-gpt-fast-mode": [] });
    writeFileSync(join(agentDir, "keybindings.json"), "not-json");
    const arrays = createHarness();
    gptFastModeStatus(arrays.pi);
    expect([...arrays.shortcuts.keys()]).toEqual(["ctrl+alt+m"]);
  });

  it("uses XDG configuration locations when the agent directory is unset", async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const xdg = mkdtempSync(join(tmpdir(), "pi-widgets-xdg-"));
    process.env.XDG_CONFIG_HOME = xdg;
    const xdgAgent = join(xdg, "pi", "agent");
    writeJson(join(xdgAgent, "settings.json"), { "pi-gpt-fast-mode": { enabled: true } });
    writeJson(join(xdg, "pi", "keybindings.json"), { "pi-gpt-fast-mode": "alt+m" });

    const harness = createHarness();
    gptFastModeStatus(harness.pi);
    await harness.fire("session_start");
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "gpt-fast-mode",
      "<warning> Fast</warning>",
    );
    expect([...harness.shortcuts.keys()]).toEqual(["alt+m"]);
    rmSync(xdg, { recursive: true, force: true });
  });

  it("falls back through standard home paths", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.XDG_CONFIG_HOME;
    const defaultHome = createHarness();
    gptFastModeStatus(defaultHome.pi);

    const emptyXdg = mkdtempSync(join(tmpdir(), "pi-widgets-empty-xdg-"));
    process.env.XDG_CONFIG_HOME = emptyXdg;
    const fallback = createHarness();
    gptFastModeStatus(fallback.pi);
    rmSync(emptyXdg, { recursive: true, force: true });

    process.env.PI_CODING_AGENT_DIR = "~";
    const tilde = createHarness();
    gptFastModeStatus(tilde.pi);
  });

  it("expands a tilde in the configured agent directory", () => {
    const relative = `.pi-widgets-test-${process.pid}`;
    const expanded = join(homedir(), relative);
    rmSync(expanded, { recursive: true, force: true });
    mkdirSync(expanded, { recursive: true });
    writeJson(join(expanded, "keybindings.json"), { "pi-gpt-fast-mode": "alt+f" });
    process.env.PI_CODING_AGENT_DIR = `~/${relative}`;

    const harness = createHarness();
    gptFastModeStatus(harness.pi);
    expect([...harness.shortcuts.keys()]).toEqual(["alt+f"]);
    rmSync(expanded, { recursive: true, force: true });
  });
});
