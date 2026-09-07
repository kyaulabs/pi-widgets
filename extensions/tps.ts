import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FIELD = "pi-tps-status";
const STATUS_KEY = "tps";
const ZENTUI_STATUS_COLOR_EVENT = "zentui:extension-status-color";
const ZENTUI_WORKING_LINE_SEGMENT_CAPABILITY_EVENT =
  "zentui:working-line-segment-capability";
const ZENTUI_WORKING_LINE_SEGMENT_EVENT = "zentui:working-line-segment";
const MIN_REFRESH_MS = 100;
const MAX_REFRESH_MS = 2_000;
const DEFAULT_REFRESH_MS = 250;
const CODE_POINTS_PER_ESTIMATED_TOKEN = 4;
const TPS_RED_MAX = 15;
const TPS_GREEN_MIN = 40;
const TPS_CYAN_MIN = 75;
const TPS_PURPLE_MIN = 100;
const TPS_GREEN = [0x1a, 0xaa, 0x13] as const;
const TPS_CYAN = [0x4d, 0xc5, 0xdc] as const;
const TPS_PURPLE = [0x73, 0x48, 0x8b] as const;
const HELP_TEXT = [
  "TPS/TTFT commands:",
  "  /tps                         Show current metrics and display settings",
  "  /tps status                  Same as /tps",
  "  /tps on|off|toggle           Control all TPS metrics",
  "  /tps bar on|off|toggle       Control the footer status",
  "  /tps line on|off|toggle      Control the Zentui working-line suffix",
  "  /tps ttft on|off|toggle      Show or hide TTFT on the Working line",
  "  /tps help                    Show this help",
  "",
  "tok/s measures generation after first output; TTFT is this response's initial wait.",
  "Command changes last for the current session. Persistent defaults are under",
  `"${CONFIG_FIELD}" in ~/.pi/agent/settings.json.`,
].join("\n");

type JsonObject = Record<string, unknown>;
type RuntimeConfig = {
  enabled: boolean;
  statusBar: boolean;
  workingLine: boolean;
  showTTFT: boolean;
  refreshMs: number;
};

type Measurement = {
  llmMs: number;
  runningSince?: number;
  firstTokenMs?: number;
  ttftKnown: boolean;
  completedOutputTokens: number;
  completedGenerationMs: number;
  currentGeneratedCodePoints: number;
  responseOpen: boolean;
  active: boolean;
};

const defaultConfig: RuntimeConfig = {
  enabled: true,
  statusBar: true,
  workingLine: true,
  showTTFT: true,
  refreshMs: DEFAULT_REFRESH_MS,
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSettings(): JsonObject | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function loadConfig(): RuntimeConfig {
  const raw = readSettings()?.[CONFIG_FIELD];
  if (!isObject(raw)) return { ...defaultConfig };

  const refreshMs =
    typeof raw.refreshMs === "number" && Number.isFinite(raw.refreshMs)
      ? Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(raw.refreshMs)))
      : DEFAULT_REFRESH_MS;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultConfig.enabled,
    statusBar: typeof raw.statusBar === "boolean" ? raw.statusBar : defaultConfig.statusBar,
    workingLine:
      typeof raw.workingLine === "boolean" ? raw.workingLine : defaultConfig.workingLine,
    showTTFT: typeof raw.showTTFT === "boolean" ? raw.showTTFT : defaultConfig.showTTFT,
    refreshMs,
  };
}

function monotonicNow(): number {
  return performance.now();
}

function isNonnegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function outputTokensFromMessage(message: unknown): number | undefined {
  if (!isObject(message) || message.role !== "assistant" || !isObject(message.usage)) {
    return undefined;
  }
  const output = message.usage.output;
  return isNonnegativeFinite(output) ? output : undefined;
}

function streamedDelta(event: unknown): string | undefined {
  if (!isObject(event)) return undefined;
  if (
    event.type !== "text_delta" &&
    event.type !== "thinking_delta" &&
    event.type !== "toolcall_delta"
  ) {
    return undefined;
  }
  return typeof event.delta === "string" && event.delta.length > 0 ? event.delta : undefined;
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _point of value) count += 1;
  return count;
}

function estimatedCurrentOutputTokens(measurement: Measurement): number {
  return Math.ceil(measurement.currentGeneratedCodePoints / CODE_POINTS_PER_ESTIMATED_TOKEN);
}

function elapsedLlmMs(measurement: Measurement, now: number): number {
  return measurement.llmMs + (measurement.runningSince === undefined
    ? 0 : Math.max(0, now - measurement.runningSince));
}

function currentGenerationMs(measurement: Measurement, now: number): number {
  if (measurement.firstTokenMs === undefined) return 0;
  return elapsedLlmMs(measurement, now) - measurement.firstTokenMs;
}

function hasCurrentSample(measurement: Measurement, now: number): boolean {
  return measurement.responseOpen && currentGenerationMs(measurement, now) >= 50;
}

function calculateTps(measurement: Measurement, now: number): number | undefined {
  const includeCurrent = hasCurrentSample(measurement, now);
  const tokens = measurement.completedOutputTokens +
    (includeCurrent ? estimatedCurrentOutputTokens(measurement) : 0);
  const durationMs = measurement.completedGenerationMs +
    (includeCurrent ? currentGenerationMs(measurement, now) : 0);
  if (tokens <= 0 || !Number.isFinite(durationMs) || durationMs < 50) return undefined;
  return tokens / (durationMs / 1_000);
}

function calculateTtft(measurement: Measurement, now: number): { value: number; pending: boolean } | undefined {
  if (!measurement.ttftKnown ||
    (measurement.firstTokenMs === undefined && !measurement.responseOpen)) return undefined;
  return {
    value: measurement.firstTokenMs ?? elapsedLlmMs(measurement, now),
    pending: measurement.firstTokenMs === undefined,
  };
}

function formatTps(value: number): string {
  if (!Number.isFinite(value)) return "--";
  if (value >= 100) return Math.round(value).toString();
  return value.toFixed(1);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(2)}s`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function formatWorkingLineMeasurement(
  measurement: Measurement,
  config: RuntimeConfig,
  now: number,
): string {
  const parts: string[] = [];
  const status = formatStatusMeasurement(measurement, now);
  if (status) parts.push(status);
  if (config.showTTFT) {
    const ttft = calculateTtft(measurement, now);
    if (ttft) parts.push(`TTFT ${formatDuration(ttft.value)}${ttft.pending ? "…" : ""}`);
  }
  return parts.join(" · ");
}

function formatStatusMeasurement(measurement: Measurement, now: number): string {
  const tps = calculateTps(measurement, now);
  if (tps === undefined) return "";
  return `${formatTps(tps)} tok/s`;
}

type TpsColor = {
  style: string;
  ansi: string;
};

function interpolateColor(
  start: readonly [number, number, number],
  end: readonly [number, number, number],
  progress: number,
): [number, number, number] {
  return [
    Math.round(start[0] + (end[0] - start[0]) * progress),
    Math.round(start[1] + (end[1] - start[1]) * progress),
    Math.round(start[2] + (end[2] - start[2]) * progress),
  ];
}

function tpsColor(value: number): TpsColor {
  let red: number;
  let green: number;
  let blue: number;

  if (value <= TPS_GREEN_MIN) {
    // Sweep through warm colors before reaching session-cost green at 40 tok/s.
    const progress = Math.min(
      1,
      Math.max(0, (value - TPS_RED_MAX) / (TPS_GREEN_MIN - TPS_RED_MAX)),
    );
    if (progress <= 0.5) {
      red = 255;
      green = Math.round(progress * 2 * 255);
      blue = 0;
    } else {
      const greenProgress = (progress - 0.5) * 2;
      [red, green, blue] = interpolateColor([255, 255, 0], TPS_GREEN, greenProgress);
    }
  } else if (value <= TPS_CYAN_MIN) {
    const progress = (value - TPS_GREEN_MIN) / (TPS_CYAN_MIN - TPS_GREEN_MIN);
    [red, green, blue] = interpolateColor(TPS_GREEN, TPS_CYAN, progress);
  } else {
    const progress = Math.min(
      1,
      (value - TPS_CYAN_MIN) / (TPS_PURPLE_MIN - TPS_CYAN_MIN),
    );
    [red, green, blue] = interpolateColor(TPS_CYAN, TPS_PURPLE, progress);
  }

  const hex = `#${red.toString(16).padStart(2, "0")}${green.toString(16).padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
  return {
    style: hex,
    ansi: `\x1b[38;2;${red};${green};${blue}m`,
  };
}

function renderOriginalStatus(color: TpsColor, text: string): string {
  return `${color.ansi}${text}\x1b[39m`;
}

function parseSwitch(value: string | undefined, current: boolean): boolean | undefined {
  switch (value?.toLowerCase()) {
    case "on":
      return true;
    case "off":
      return false;
    case "toggle":
      return !current;
    default:
      return undefined;
  }
}

export default function tpsStatus(pi: ExtensionAPI): void {
  let config = loadConfig();
  let measurement: Measurement = newMeasurement();
  let turnOpen = false;
  let compacting = false;
  let waitingForUi = false;
  let waitingForRetry = false;
  let detachAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerContext: ExtensionContext | undefined;
  let lastStatusText: string | undefined;
  let lastStatusActive: boolean | undefined;
  let lastStatusColor: string | undefined;
  let lastWorkingText: string | undefined;
  let lastRenderedAt = Number.NEGATIVE_INFINITY;
  let ownsWorkingMessage = false;
  let usesZentuiWorkingLineSegments = false;

  function newMeasurement(): Measurement {
    return {
      llmMs: 0,
      ttftKnown: false,
      completedOutputTokens: 0,
      completedGenerationMs: 0,
      currentGeneratedCodePoints: 0,
      responseOpen: false,
      active: false,
    };
  }

  function resetMeasurement(): void {
    detachAbort?.();
    detachAbort = undefined;
    measurement = newMeasurement();
    turnOpen = false;
    compacting = false;
    waitingForUi = false;
    waitingForRetry = false;
  }

  function stopTimer(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    timerContext = undefined;
  }

  function clearStatus(ctx: ExtensionContext): void {
    if (lastStatusText !== undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
    lastStatusText = undefined;
    lastStatusActive = undefined;
    lastStatusColor = undefined;
  }

  function clearWorkingLine(ctx: ExtensionContext, restoreDefault = false): void {
    if (usesZentuiWorkingLineSegments) {
      if (lastWorkingText !== undefined) {
        pi.events.emit(ZENTUI_WORKING_LINE_SEGMENT_EVENT, {
          key: STATUS_KEY,
          text: undefined,
        });
      }
      lastWorkingText = undefined;
      return;
    }
    if (!ownsWorkingMessage) return;
    ctx.ui.setWorkingMessage(restoreDefault ? undefined : "");
    ownsWorkingMessage = false;
    lastWorkingText = undefined;
  }

  function render(ctx: ExtensionContext, now = monotonicNow(), force = false): void {
    if (!force && measurement.active && now - lastRenderedAt < config.refreshMs) return;
    lastRenderedAt = now;

    if (!config.enabled) {
      clearStatus(ctx);
      clearWorkingLine(ctx);
      return;
    }

    const tps = calculateTps(measurement, now);
    const statusText = formatStatusMeasurement(measurement, now);
    const workingText = formatWorkingLineMeasurement(measurement, config, now);

    if (config.statusBar && statusText && tps) {
      const color = tpsColor(tps);
      if (
        statusText !== lastStatusText ||
        measurement.active !== lastStatusActive ||
        color.style !== lastStatusColor
      ) {
        // Original mode keeps this ANSI styling. Zentui mode can use the matching dynamic
        // per-status style announced immediately before the status update.
        pi.events.emit(ZENTUI_STATUS_COLOR_EVENT, {
          key: STATUS_KEY,
          color: color.style,
        });
        ctx.ui.setStatus(STATUS_KEY, renderOriginalStatus(color, statusText));
        lastStatusText = statusText;
        lastStatusActive = measurement.active;
        lastStatusColor = color.style;
      }
    } else {
      clearStatus(ctx);
    }

    if (config.workingLine && measurement.runningSince !== undefined && workingText) {
      if (workingText !== lastWorkingText) {
        if (usesZentuiWorkingLineSegments) {
          pi.events.emit(ZENTUI_WORKING_LINE_SEGMENT_EVENT, {
            key: STATUS_KEY,
            text: workingText,
          });
        } else {
          ctx.ui.setWorkingMessage(ctx.ui.theme.fg("muted", ` · ${workingText}`));
          ownsWorkingMessage = true;
        }
        lastWorkingText = workingText;
      }
    } else {
      clearWorkingLine(ctx, true);
    }
  }

  function startTimer(ctx: ExtensionContext): void {
    timerContext = ctx;
    if (timer !== undefined) return;
    timer = setInterval(() => {
      if (timerContext && measurement.active) render(timerContext);
    }, config.refreshMs);
  }

  function beginInteraction(ctx: ExtensionContext): void {
    const capability = { supported: false, active: false };
    pi.events.emit(ZENTUI_WORKING_LINE_SEGMENT_CAPABILITY_EVENT, capability);
    usesZentuiWorkingLineSegments = capability.active;
    measurement = newMeasurement();
    measurement.active = true;
    render(ctx, monotonicNow(), true);
  }

  function pauseClock(ctx: ExtensionContext): void {
    const now = monotonicNow();
    measurement.llmMs = elapsedLlmMs(measurement, now);
    measurement.runningSince = undefined;
    stopTimer();
    render(ctx, now, true);
  }

  function resumeClock(ctx: ExtensionContext): void {
    if (!measurement.responseOpen || waitingForUi || waitingForRetry) return;
    measurement.runningSince ??= monotonicNow();
    if (config.enabled) startTimer(ctx);
    render(ctx, monotonicNow(), true);
  }

  function startResponse(ctx: ExtensionContext, ttftKnown = false): void {
    // A turn arms the meter; only a provider request starts the clock. Context hooks,
    // authentication and compaction can all run after turn_start but before this point.
    const signal = ctx.signal;
    if (!turnOpen || compacting || signal?.aborted) return;
    if (!measurement.responseOpen) {
      measurement.llmMs = 0;
      measurement.firstTokenMs = undefined;
      measurement.ttftKnown = ttftKnown;
      if (signal) {
        const onAbort = () => closeTurn(ctx);
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
    }
    measurement.responseOpen = true;
    waitingForRetry = false;
    resumeClock(ctx);
  }

  function acceptStreamUpdate(assistantEvent: unknown, ctx: ExtensionContext): void {
    if (!measurement.active || !measurement.responseOpen) return;
    const now = monotonicNow();
    const delta = streamedDelta(assistantEvent);
    const isFirstToken = delta !== undefined && measurement.firstTokenMs === undefined;
    if (delta !== undefined) {
      if (isFirstToken) measurement.firstTokenMs = elapsedLlmMs(measurement, now);
      measurement.currentGeneratedCodePoints += countCodePoints(delta);
    }

    // Partial usage can be a stale snapshot, or include unstreamed reasoning.
    // Only a real content delta establishes first-output timing; usage is finalized
    // at message_end. Live token counts use the code-point estimate.
    render(ctx, now, isFirstToken);
  }

  function commitResponse(message: unknown, ctx: ExtensionContext): void {
    if (!measurement.active || !measurement.responseOpen) return;
    const now = monotonicNow();
    const exactOutput = outputTokensFromMessage(message);
    // Zero usage on an interrupted stream is often a provider placeholder.
    const hasExactOutput = exactOutput !== undefined && exactOutput > 0;
    const responseTokens = hasExactOutput ? exactOutput : estimatedCurrentOutputTokens(measurement);
    if (hasCurrentSample(measurement, now) && responseTokens > 0) {
      measurement.completedOutputTokens += responseTokens;
      measurement.completedGenerationMs += currentGenerationMs(measurement, now);
    }
    // Untimed/buffered responses must not add tokens without matching generation
    // time. Keep the previous aggregate rather than inventing a duration.
    measurement.currentGeneratedCodePoints = 0;
    measurement.responseOpen = false;
    waitingForRetry = false;
    detachAbort?.();
    detachAbort = undefined;
    pauseClock(ctx);
  }

  function closeTurn(ctx: ExtensionContext): void {
    commitResponse(undefined, ctx);
    turnOpen = false;
  }

  function finishInteraction(ctx: ExtensionContext): void {
    if (!measurement.active) return;
    closeTurn(ctx);
    measurement.active = false;
    stopTimer();
    render(ctx, monotonicNow(), true);
  }

  function applyRuntimeSwitch(
    target: "enabled" | "statusBar" | "workingLine" | "showTTFT",
    value: boolean,
    ctx: ExtensionContext,
  ): void {
    config = { ...config, [target]: value };
    if (target === "enabled") {
      if (!value) stopTimer();
      else if (measurement.runningSince !== undefined) startTimer(ctx);
    }
    render(ctx, monotonicNow(), true);
  }

  pi.registerCommand("tps", {
    description: "Show or configure TPS/TTFT metrics (on, off, bar, line, ttft)",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off", "toggle", "status", "help", "bar on", "bar off", "bar toggle", "line on", "line off", "line toggle", "ttft on", "ttft off", "ttft toggle"];
      const matches = values.filter((value) => value.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (words[0] === "help") {
        ctx.ui.notify(HELP_TEXT, "info");
        return;
      }

      if (words.length === 0 || words[0] === "status") {
        const current = formatWorkingLineMeasurement(measurement, config, monotonicNow());
        ctx.ui.notify(
          `${current || "No TPS/TTFT measurement yet"} · bar ${config.statusBar ? "on" : "off"} · line ${config.workingLine ? "on" : "off"}`,
          "info",
        );
        return;
      }

      if (words.length === 1) {
        const enabled = parseSwitch(words[0], config.enabled);
        if (enabled !== undefined) {
          applyRuntimeSwitch("enabled", enabled, ctx);
          ctx.ui.notify(`TPS metrics ${enabled ? "enabled" : "disabled"}.`, "info");
          return;
        }
      }

      const target =
        words[0] === "bar"
          ? "statusBar"
          : words[0] === "line"
            ? "workingLine"
            : words[0] === "ttft"
              ? "showTTFT"
              : undefined;
      if (target) {
        const value = parseSwitch(words[1], config[target]);
        if (value !== undefined) {
          applyRuntimeSwitch(target, value, ctx);
          ctx.ui.notify(`${words[0]} ${value ? "enabled" : "disabled"}.`, "info");
          return;
        }
      }

      ctx.ui.notify("Unknown TPS command. Run /tps help for usage.", "warning");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    stopTimer();
    usesZentuiWorkingLineSegments = false;
    config = loadConfig();
    resetMeasurement();
    lastStatusText = undefined;
    lastStatusActive = undefined;
    lastStatusColor = undefined;
    lastWorkingText = undefined;
    lastRenderedAt = Number.NEGATIVE_INFINITY;
    ownsWorkingMessage = false;
    render(ctx, monotonicNow(), true);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!measurement.active) beginInteraction(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    // Defensive fallback for hosts or continuation paths that do not emit before_agent_start.
    if (!measurement.active) beginInteraction(ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!measurement.active) beginInteraction(ctx);
    closeTurn(ctx);
    turnOpen = true;
  });

  pi.on("before_provider_request", (_event, ctx) => startResponse(ctx, true));

  pi.on("message_start", (event, ctx) => {
    // Conservative fallback for custom providers without a payload hook. Never start
    // at turn_start: that would meter local preparation and compaction as LLM time.
    if (event.message.role === "assistant") startResponse(ctx);
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!measurement.responseOpen) return;
    waitingForRetry = event.status < 200 || event.status >= 300;
    if (waitingForRetry) pauseClock(ctx);
    else resumeClock(ctx);
  });

  // These are defensive boundaries for interrupted/missing message_end events.
  // Normal tools (including permission gates and nested LLM tools) are already
  // outside the request window, regardless of tool name or parallel execution.
  pi.on("tool_execution_start", (_event, ctx) => closeTurn(ctx));
  pi.on("turn_end", (_event, ctx) => closeTurn(ctx));

  pi.on("session_before_compact", (_event, ctx) => {
    commitResponse(undefined, ctx);
    compacting = true;
  });
  pi.on("session_compact", () => { compacting = false; });
  pi.on("session_compact_failed", () => { compacting = false; });

  pi.on("ui_prompt_start", (_event, ctx) => {
    waitingForUi = true;
    pauseClock(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    waitingForUi = false;
    resumeClock(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    acceptStreamUpdate(
      "assistantMessageEvent" in event ? event.assistantMessageEvent : undefined,
      ctx,
    );
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant" && !compacting) {
      commitResponse(event.message, ctx);
      turnOpen = false;
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    // Preserve totals for retries/queued follow-ups, but never time the gap.
    closeTurn(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => finishInteraction(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    clearStatus(ctx);
    clearWorkingLine(ctx, true);
    resetMeasurement();
  });
}
