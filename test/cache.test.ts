import { describe, expect, it } from "vitest";
import cache from "../extensions/cache.js";
import { createHarness } from "./harness.js";

function setup(provider = "openai", id = "gpt-6.1-sol") {
  const h = createHarness({ model: { provider, id } });
  Object.assign(h.ctx.model!, { api: "openai-responses" });
  cache(h.pi);
  const command = (args: string) => (h.command("cache").handler as
    (args: string, ctx: typeof h.ctx) => Promise<void>)(args, h.ctx);
  const request = (payload: unknown = { model: id }) =>
    h.fire("before_provider_request", { payload });
  const complete = (response: unknown, extra = {}) => h.fire("provider_stream_event", {
    provider, model: id, api: "openai-responses",
    data: { type: "response.completed", response }, ...extra,
  });
  return { ...h, command, request, complete };
}

describe("prompt cache diagnostics", () => {
  it("is opt-in and compares consecutive responses without changing other options", async () => {
    const h = setup();
    expect(await h.request()).toEqual([undefined]);
    await h.command("on");
    expect(await h.request()).toEqual([undefined]);
    await h.complete({ id: "resp_first" });
    const payload = { model: "gpt-6.1-sol", service_tier: "ultrafast",
      store: false, prompt_cache_options: { retention: "24h" } };
    expect(await h.request(payload)).toEqual([{ ...payload,
      prompt_cache_options: { retention: "24h", comparison_response_id: "resp_first" } }]);
    await h.complete({ id: "resp_second", prompt_cache_diagnostics: { type: "cache_hit" },
      usage: { input_tokens: 2500, input_tokens_details: { cached_tokens: 2000 } } });
    await h.command("status");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("2000 / 2500"));
    expect(h.setStatus).toHaveBeenLastCalledWith("prompt-cache", "<success>Cache hit · 80%</success>");
    expect(await h.request()).toEqual([{ model: "gpt-6.1-sol",
      prompt_cache_options: { comparison_response_id: "resp_second" } }]);
  });

  it.each(["cache_miss", "comparison_response_not_found", "unavailable", "unknown\u001b[2J"])(
    "handles %s without inferring actual reuse", async (type) => {
      const h = setup(); await h.command(""); await h.request();
      await h.complete({ id: "resp_a", prompt_cache_diagnostics: {
        type, reason: "tools_changed", comparison_reusable_tokens: 2048, cache_missed_tokens: 1024,
      } });
      await h.command("status");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Cached input: unconfirmed"));
      expect(h.notify.mock.lastCall?.[0]).not.toContain("\u001b");
      if (type === "cache_miss") {
        expect(h.notify.mock.lastCall?.[0]).toContain("tools changed");
        expect(h.notify.mock.lastCall?.[0]).toContain("1024");
      }
    });

  it.each(["session_start", "session_shutdown", "session_tree", "model_select"])(
    "clears the baseline on %s", async (event) => {
      const h = setup(); await h.command("on"); await h.request();
      await h.complete({ id: "resp_a" }); await h.fire(event);
      expect(await h.request()).toEqual([undefined]);
    });

  it("toggles off, rejects bad arguments and ignores late events", async () => {
    const h = setup(); await h.command("status");
    expect(h.notify.mock.lastCall?.[0]).toContain("off");
    await h.command("bad"); expect(h.notify.mock.lastCall?.[0]).toContain("Usage:");
    await h.command(""); await h.request(); await h.command("");
    await h.complete({ id: "resp_late" }); await h.command("on");
    expect(await h.request()).toEqual([undefined]);
    await h.command("off"); expect(h.setStatus).toHaveBeenLastCalledWith("prompt-cache", undefined);
  });

  it.each([["openai-codex", "gpt-6.1-sol"], ["openai", "gpt-5.4"],
    ["openai", "gpt-5.5"], ["openai", "gpt-5.6-sol"], ["openai", "gpt-7"]])(
    "guards provider/model %s/%s", async (provider, id) => {
      const h = setup(provider, id); await h.command("on"); await h.request();
      await h.complete({ id: "resp_a" });
      const supported = provider === "openai" && ["gpt-5.6-sol", "gpt-7"].includes(id);
      expect((await h.request())[0] !== undefined).toBe(supported);
    });

  it("ignores malformed, mismatched and unrelated events and preserves explicit comparisons", async () => {
    const h = setup(); await h.command("on");
    for (const payload of [null, [], "bad", { model: "other" }]) await h.request(payload);
    await h.complete({ id: "resp_ignored" });
    expect(await h.request()).toEqual([undefined]);
    for (const extra of [{ provider: "other" }, { model: "other" },
      { api: "openai-completions" }, { data: null }, { data: [] },
      { data: { type: "response.created" } }, { data: { type: "response.completed" } }]) {
      await h.complete({ id: "resp_wrong" }, extra);
    }
    expect(await h.request()).toEqual([undefined]);
    await h.complete({ id: "resp_a", prompt_cache_diagnostics: { type: "cache_miss", reason: "\u001b[2J" },
      usage: { input_tokens: -1, input_tokens_details: { cached_tokens: "bad" } } });
    await h.command("status"); expect(h.notify.mock.lastCall?.[0]).toContain("unknown");
    const payload = { model: "gpt-6.1-sol", prompt_cache_options: { comparison_response_id: "custom" } };
    expect(await h.request(payload)).toEqual([undefined]);
    await h.complete({ id: "resp_b", prompt_cache_diagnostics: { type: "cache_hit" },
      usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 } } });
    await h.command("status"); expect(h.notify.mock.lastCall?.[0]).toContain("0 / 0");
  });
});
