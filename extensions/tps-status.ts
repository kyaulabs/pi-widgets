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
  "Command changes last for the current session. Persistent defaults are under",
  `\"${CONFIG_FIELD}\" in ~/.pi/agent/settings.json.`,
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
  requestStartedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  excludedShellMs: number;
  shellPausedAt?: number;
  completedOutputTokens: number;
  currentExactOutputTokens?: number;
  currentGeneratedCodePoints: number;
  responseOpen: boolean;
  active: boolean;
  complete: boolean;
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

function measuredOutputTokens(measurement: Measurement): number {
  const current =
    measurement.currentExactOutputTokens ?? estimatedCurrentOutputTokens(measurement);
  return measurement.completedOutputTokens + current;
}

function calculateTps(measurement: Measurement, now: number): number | undefined {
  if (measurement.requestStartedAt === undefined || measurement.firstTokenAt === undefined) {
    return undefined;
  }
  const tokens = measuredOutputTokens(measurement);
  if (tokens <= 0) return undefined;

  const end = measurement.completedAt ?? now;
  const activeShellPauseMs =
    measurement.shellPausedAt === undefined ? 0 : Math.max(0, end - measurement.shellPausedAt);
  const interactionMs =
    end - measurement.requestStartedAt - measurement.excludedShellMs - activeShellPauseMs;
  if (!Number.isFinite(interactionMs) || interactionMs < 50) return undefined;
  return tokens / (interactionMs / 1_000);
}

function calculateTtft(measurement: Measurement, now: number): { value: number; pending: boolean } | undefined {
  if (measurement.requestStartedAt === undefined) return undefined;
  const end = measurement.firstTokenAt ?? now;
  return { value: Math.max(0, end - measurement.requestStartedAt), pending: measurement.firstTokenAt === undefined };
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
  const tps = calculateTps(measurement, now);
  if (tps !== undefined) parts.push(`${formatTps(tps)} tok/s`);
  if (config.showTTFT) {
    const ttft = calculateTtft(measurement, now);
    if (ttft) parts.push(`TTFT ${formatDuration(ttft.value)}${ttft.pending ? "…" : ""}`);
  }
  return parts.join(" · ");
}

function formatStatusMeasurement(measurement: Measurement, now: number): string {
  const tps = calculateTps(measurement, now);
  return tps !== undefined ? `${formatTps(tps)} tok/s` : "";
}

type TpsColor = {
  style: string;
  ansi: string;
};

function tpsColor(value: number): TpsColor {
  // Sweep through red, orange, amber, yellow, lime, and chartreuse before
  // reaching the same #1aaa13 green used for session cost at 40 tok/s.
  const progress = Math.min(
    1,
    Math.max(0, (value - TPS_RED_MAX) / (TPS_GREEN_MIN - TPS_RED_MAX)),
  );
  let red: number;
  let green: number;
  let blue: number;
  if (progress <= 0.5) {
    red = 255;
    green = Math.round(progress * 2 * 255);
    blue = 0;
  } else {
    const greenProgress = (progress - 0.5) * 2;
    red = Math.round(255 + (0x1a - 255) * greenProgress);
    green = Math.round(255 + (0xaa - 255) * greenProgress);
    blue = Math.round(0x13 * greenProgress);
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
  let measurement: Measurement = {
    excludedShellMs: 0,
    completedOutputTokens: 0,
    currentGeneratedCodePoints: 0,
    responseOpen: false,
    active: false,
    complete: false,
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerContext: ExtensionContext | undefined;
  let lastStatusText: string | undefined;
  let lastStatusActive: boolean | undefined;
  let lastStatusColor: string | undefined;
  let lastWorkingText: string | undefined;
  let lastRenderedAt = Number.NEGATIVE_INFINITY;
  let ownsWorkingMessage = false;
  let usesZentuiWorkingLineSegments = false;
  const activeShellToolCalls = new Set<string>();

  function resetMeasurement(): void {
    activeShellToolCalls.clear();
    measurement = {
      excludedShellMs: 0,
      completedOutputTokens: 0,
      currentGeneratedCodePoints: 0,
      responseOpen: false,
      active: false,
      complete: false,
    };
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

    if (config.workingLine && measurement.active && workingText) {
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
      clearWorkingLine(ctx);
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
    const now = monotonicNow();
    activeShellToolCalls.clear();
    measurement = {
      requestStartedAt: now,
      excludedShellMs: 0,
      completedOutputTokens: 0,
      currentGeneratedCodePoints: 0,
      responseOpen: false,
      active: true,
      complete: false,
    };
    if (config.enabled) startTimer(ctx);
    render(ctx, now, true);
  }

  function startResponse(ctx: ExtensionContext): void {
    if (!measurement.active) beginInteraction(ctx);
    measurement.currentExactOutputTokens = undefined;
    measurement.currentGeneratedCodePoints = 0;
    measurement.responseOpen = true;
    render(ctx, monotonicNow(), true);
  }

  function acceptStreamUpdate(message: unknown, assistantEvent: unknown, ctx: ExtensionContext): void {
    if (!measurement.active || !measurement.responseOpen) return;
    const now = monotonicNow();
    const delta = streamedDelta(assistantEvent);
    const isFirstToken = delta !== undefined && measurement.firstTokenAt === undefined;
    if (delta !== undefined) {
      if (isFirstToken) measurement.firstTokenAt = now;
      measurement.currentGeneratedCodePoints += countCodePoints(delta);
    }

    const exactOutput = outputTokensFromMessage(message);
    if (exactOutput !== undefined && exactOutput > 0) {
      measurement.currentExactOutputTokens = exactOutput;
      if (measurement.firstTokenAt === undefined) measurement.firstTokenAt = now;
    }
    render(ctx, now, isFirstToken);
  }

  function commitResponse(message: unknown, ctx: ExtensionContext): void {
    if (!measurement.active || !measurement.responseOpen) return;
    const now = monotonicNow();
    const exactOutput = outputTokensFromMessage(message);
    if (exactOutput !== undefined && exactOutput > 0) {
      measurement.currentExactOutputTokens = exactOutput;
    }
    const responseTokens =
      measurement.currentExactOutputTokens ?? estimatedCurrentOutputTokens(measurement);
    measurement.completedOutputTokens += responseTokens;
    if (measurement.firstTokenAt === undefined && responseTokens > 0) {
      measurement.firstTokenAt = now;
    }
    measurement.currentExactOutputTokens = undefined;
    measurement.currentGeneratedCodePoints = 0;
    measurement.responseOpen = false;
    render(ctx, now, true);
  }

  function pauseShellAveraging(toolCallId: string, ctx: ExtensionContext): void {
    if (!measurement.active || activeShellToolCalls.has(toolCallId)) return;
    activeShellToolCalls.add(toolCallId);
    if (activeShellToolCalls.size !== 1) return;

    const now = monotonicNow();
    measurement.shellPausedAt = now;
    render(ctx, now, true);
  }

  function resumeShellAveraging(toolCallId: string, ctx: ExtensionContext): void {
    if (!activeShellToolCalls.delete(toolCallId) || activeShellToolCalls.size > 0) return;

    const now = monotonicNow();
    if (measurement.shellPausedAt !== undefined) {
      measurement.excludedShellMs += Math.max(0, now - measurement.shellPausedAt);
      measurement.shellPausedAt = undefined;
    }
    render(ctx, now, true);
  }

  function finishInteraction(ctx: ExtensionContext): void {
    if (!measurement.active) return;
    if (measurement.responseOpen) commitResponse(undefined, ctx);
    const now = monotonicNow();
    if (measurement.shellPausedAt !== undefined) {
      measurement.excludedShellMs += Math.max(0, now - measurement.shellPausedAt);
      measurement.shellPausedAt = undefined;
    }
    activeShellToolCalls.clear();
    measurement.active = false;
    measurement.complete = true;
    measurement.completedAt = now;
    stopTimer();
    render(ctx, now, true);
    clearWorkingLine(ctx);
  }

  function applyRuntimeSwitch(
    target: "enabled" | "statusBar" | "workingLine" | "showTTFT",
    value: boolean,
    ctx: ExtensionContext,
  ): void {
    config = { ...config, [target]: value };
    if (target === "enabled") {
      if (!value) stopTimer();
      else if (measurement.active) startTimer(ctx);
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

  pi.on("turn_start", (_event, ctx) => startResponse(ctx));

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName === "bash" || event.toolName === "powershell") {
      pauseShellAveraging(event.toolCallId, ctx);
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName === "bash" || event.toolName === "powershell") {
      resumeShellAveraging(event.toolCallId, ctx);
    }
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    acceptStreamUpdate(
      event.message,
      "assistantMessageEvent" in event ? event.assistantMessageEvent : undefined,
      ctx,
    );
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") commitResponse(event.message, ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    // The interaction may continue through retries, compaction, or queued follow-ups.
    // Keep the same prompt-level clock and accumulated output until agent_settled.
    if (measurement.active) render(ctx, monotonicNow(), true);
  });

  pi.on("agent_settled", (_event, ctx) => finishInteraction(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    clearStatus(ctx);
    clearWorkingLine(ctx, true);
    resetMeasurement();
  });
}
