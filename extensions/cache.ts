import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ObjectValue = Record<string, unknown>;
const STATUS = "prompt-cache";
const REASONS = new Set([
  "model_changed", "prompt_cache_key_changed", "service_tier_changed", "tools_changed",
  "text_format_changed", "reasoning_effort_changed", "verbosity_changed", "context_compacted",
  "input_changed",
]);
const TYPES: Record<string, string> = {
  cache_hit: "hit", cache_miss: "miss",
  comparison_response_not_found: "baseline expired or missing", unavailable: "unavailable",
};
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function supported(ctx: ExtensionContext): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(ctx.model?.id ?? "");
  return ctx.model?.provider === "openai" && ctx.model.api === "openai-responses" &&
    Boolean(match && (Number(match[1]) > 5 ||
      (Number(match[1]) === 5 && Number(match[2]) >= 6)));
}

export default function cacheDiagnostics(pi: ExtensionAPI): void {
  let enabled = false;
  let baseline: string | undefined;
  let pending = false;
  let details = "Awaiting a completed response.";

  function reset(ctx: ExtensionContext): void {
    baseline = undefined;
    pending = false;
    details = "Awaiting a completed response.";
    ctx.ui.setStatus(STATUS, enabled ? "Cache: awaiting response" : undefined);
  }

  pi.registerCommand("cache", {
    description: "Toggle OpenAI cache diagnostics; /cache on|off|status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(`Cache diagnostics: ${enabled ? "on" : "off"}. ` +
          `${supported(ctx) ? "" : "Requires OpenAI Responses with GPT-5.6 or later. "}${details}`);
        return;
      }
      if (!["", "on", "off"].includes(action)) {
        ctx.ui.notify("Usage: /cache [on|off|status]", "warning");
        return;
      }
      enabled = action === "" ? !enabled : action === "on";
      reset(ctx);
      ctx.ui.notify(`Cache diagnostics ${enabled ? "enabled" : "disabled"}.`);
    },
  });
  pi.on("session_start", (_event, ctx) => { enabled = false; reset(ctx); });
  pi.on("session_shutdown", (_event, ctx) => { enabled = false; reset(ctx); });
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("model_select", (_event, ctx) => reset(ctx));

  pi.on("before_provider_request", (event, ctx) => {
    pending = false;
    const payload = object(event.payload);
    if (!enabled || !supported(ctx) || !payload || payload.model !== ctx.model?.id) return;
    pending = true;
    if (!baseline) return;
    const options = object(payload.prompt_cache_options);
    // Respect explicit comparisons supplied by another extension or provider configuration.
    if (options?.comparison_response_id !== undefined) return;
    return { ...payload, prompt_cache_options: { ...options, comparison_response_id: baseline } };
  });

  // Older supported Pi types predate the raw stream hook; unavailable hooks leave status pending.
  const onStream = pi.on as unknown as (name: "provider_stream_event", handler: (
    event: { provider: string; model: string; api: string; data: unknown },
    ctx: ExtensionContext,
  ) => void) => void;
  onStream("provider_stream_event", (event, ctx) => {
    if (!enabled || !pending || !supported(ctx) || event.provider !== "openai" ||
        event.model !== ctx.model?.id || event.api !== "openai-responses") return;
    const data = object(event.data);
    const response = object(data?.response);
    if (data?.type !== "response.completed" || !response) return;
    pending = false;
    baseline = typeof response.id === "string" && /^resp_[A-Za-z0-9_-]+$/.test(response.id)
      ? response.id : undefined;
    const diagnostics = object(response.prompt_cache_diagnostics);
    const type = typeof diagnostics?.type === "string" &&
      Object.hasOwn(TYPES, diagnostics.type) ? TYPES[diagnostics.type] : "unconfirmed";
    const reason = typeof diagnostics?.reason === "string" && REASONS.has(diagnostics.reason)
      ? diagnostics.reason.replaceAll("_", " ") : "unknown";
    const usage = object(response.usage);
    const input = count(usage?.input_tokens);
    const cached = count(object(usage?.input_tokens_details)?.cached_tokens);
    const reuse = input !== undefined && cached !== undefined && cached <= input
      ? `${cached} / ${input} tokens` : "unconfirmed";
    details = `Cache: ${type}. Cached input: ${reuse}.`;
    if (type === "miss") {
      details += ` Reason: ${reason}. Missed tokens: ${count(diagnostics?.cache_missed_tokens) ?? "unknown"}.` +
        ` Comparison reusable tokens: ${count(diagnostics?.comparison_reusable_tokens) ?? "unknown"}.`;
    }
    const percent = input && cached !== undefined && cached <= input
      ? ` · ${Math.round(cached / input * 100)}%` : "";
    ctx.ui.setStatus(STATUS, ctx.ui.theme.fg(type === "hit" ? "success" : "warning",
      `Cache ${type}${percent}`));
  });
}
