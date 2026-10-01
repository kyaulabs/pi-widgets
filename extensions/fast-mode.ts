import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Explicit support from OpenAI's Fast pricing table; retain the existing gpt-5.6 alias.
const SUPPORTED_MODELS = new Set([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-2024-05-13",
  "gpt-4o-mini",
  "o3",
  "o4-mini",
]);
const ULTRAFAST_MODELS = new Set(["gpt-6-astra", "gpt-5.6-sol"]);
// Flex has its own availability list; Fast support does not imply Flex support.
const FLEX_MODELS = new Set([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "o3",
  "o4-mini",
]);

const CONFIG_FIELD = "pi-gpt-fast-mode";
const DEFAULT_SHORTCUT = "ctrl+alt+m";
const STATUS_KEY = "gpt-fast-mode";
const STATUS_TEXT = " Fast";
// Fixed purple; text presentation keeps the lightning glyph from becoming a yellow emoji.
const ULTRAFAST_STATUS = "\u001b[38;5;141m⚡\uFE0E Ultrafast\u001b[39m";
const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

type SpeedMode = "fast" | "ultrafast" | "flex";
type PiModel = { provider?: string; id?: string };
type JsonObject = Record<string, unknown>;

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function isSupportedModel(model: PiModel | undefined, mode: SpeedMode): boolean {
  const models = mode === "ultrafast"
    ? ULTRAFAST_MODELS
    : mode === "flex" ? FLEX_MODELS : SUPPORTED_MODELS;
  return Boolean(
    (model?.provider === "openai" || model?.provider === "openai-codex") &&
      model.id &&
      models.has(model.id),
  );
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

function resolvePiFilePath(fileName: string): string {
  const home = homedir();
  const piDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (piDir) return join(resolve(expandHome(piDir, home)), fileName);

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
    ? resolve(expandHome(process.env.XDG_CONFIG_HOME, home))
    : join(home, ".config");
  const candidates = [
    join(xdgConfigHome, "pi", "agent", fileName),
    join(xdgConfigHome, "pi", fileName),
  ];

  return candidates.find(existsSync) ?? join(home, ".pi", "agent", fileName);
}

function readJson(path: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function loadDefaultEnabled(): boolean {
  const config = readJson(resolvePiFilePath("settings.json"))?.[CONFIG_FIELD];
  return Boolean(
    config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      (config as { enabled?: unknown }).enabled === true,
  );
}

function normalizeShortcuts(value: unknown): string[] {
  if (value === false || value === null) return [];
  const isArray = Array.isArray(value);
  const values = isArray ? value : [value];
  const shortcuts = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !RESERVED_SHORTCUTS.has(item.toLowerCase()));
  return isArray || shortcuts.length > 0 ? shortcuts : [DEFAULT_SHORTCUT];
}

function loadShortcuts(): string[] {
  const config = readJson(resolvePiFilePath("keybindings.json"));
  return config ? normalizeShortcuts(config[CONFIG_FIELD]) : [DEFAULT_SHORTCUT];
}

export default function gptFastModeStatus(pi: ExtensionAPI): void {
  let mode: SpeedMode | undefined = loadDefaultEnabled() ? "fast" : undefined;

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      STATUS_KEY,
      mode === "ultrafast"
        ? ULTRAFAST_STATUS
        : mode === "fast"
          ? ctx.ui.theme.fg("warning", STATUS_TEXT)
          : mode === "flex"
            ? ctx.ui.theme.fg("success", "󰿗 Flex")
            : undefined,
    );
  }

  function toggle(ctx: ExtensionContext, requested: SpeedMode): void {
    mode = mode === requested ? undefined : requested;
    updateStatus(ctx);
    const label = requested === "ultrafast"
      ? "Ultrafast"
      : requested === "flex" ? "Flex" : "Fast";
    if (!mode) {
      ctx.ui.notify(`GPT ${label} mode disabled.`);
    } else if (isSupportedModel(ctx.model, mode)) {
      ctx.ui.notify(`GPT ${label} mode enabled (service_tier: ${mode}).`);
    } else {
      const model = ctx.model ? modelKey(ctx.model) : "unknown model";
      ctx.ui.notify(`GPT ${label} mode enabled, but ${model} is not supported.`, "warning");
    }
  }

  pi.registerCommand("fast", {
    description: "Toggle GPT Fast mode (service_tier: fast)",
    handler: async (_args, ctx) => toggle(ctx, "fast"),
  });
  pi.registerCommand("ultrafast", {
    description: "Toggle GPT Ultrafast mode (service_tier: ultrafast)",
    handler: async (_args, ctx) => toggle(ctx, "ultrafast"),
  });
  pi.registerCommand("flex", {
    description: "Toggle GPT Flex mode (service_tier: flex)",
    handler: async (_args, ctx) => toggle(ctx, "flex"),
  });

  for (const shortcut of loadShortcuts()) {
    pi.registerShortcut(shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
      description: "Toggle GPT Fast mode",
      handler: async (ctx) => toggle(ctx, "fast"),
    });
  }

  pi.on("session_start", (_event, ctx) => {
    mode = loadDefaultEnabled() ? "fast" : undefined;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!mode || !isSupportedModel(ctx.model, mode)) return undefined;
    if (!event.payload || typeof event.payload !== "object") return undefined;
    if ((event.payload as JsonObject).model !== ctx.model?.id) return undefined;

    return {
      ...(event.payload as JsonObject),
      service_tier: mode,
    };
  });
}
