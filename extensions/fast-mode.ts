import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SUPPORTED_MODELS = new Set([
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.5",
  "openai/gpt-5.6",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.4-mini",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.6",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
]);

const CONFIG_FIELD = "pi-gpt-fast-mode";
const DEFAULT_SHORTCUT = "ctrl+alt+m";
const FAST_SERVICE_TIER = "priority";
const STATUS_KEY = "gpt-fast-mode";
const STATUS_TEXT = " Fast";
const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

type PiModel = { provider?: string; id?: string };
type JsonObject = Record<string, unknown>;

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function isSupportedModel(model: PiModel | undefined): boolean {
  return Boolean(model?.provider && model.id && SUPPORTED_MODELS.has(modelKey(model)));
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
  let enabled = loadDefaultEnabled();

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      STATUS_KEY,
      enabled ? ctx.ui.theme.fg("warning", STATUS_TEXT) : undefined,
    );
  }

  function announceState(ctx: ExtensionContext): void {
    if (!enabled) {
      ctx.ui.notify("GPT Fast mode disabled.");
    } else if (isSupportedModel(ctx.model)) {
      ctx.ui.notify(`GPT Fast mode enabled (service_tier: ${FAST_SERVICE_TIER}).`);
    } else {
      const model = ctx.model ? modelKey(ctx.model) : "unknown model";
      ctx.ui.notify(`GPT Fast mode enabled, but ${model} is not supported.`, "warning");
    }
  }

  function toggle(ctx: ExtensionContext): void {
    enabled = !enabled;
    updateStatus(ctx);
    announceState(ctx);
  }

  pi.registerCommand("fast", {
    description: "Toggle GPT Fast mode (service_tier: priority)",
    handler: async (_args, ctx) => toggle(ctx),
  });

  for (const shortcut of loadShortcuts()) {
    pi.registerShortcut(shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
      description: "Toggle GPT Fast mode",
      handler: async (ctx) => toggle(ctx),
    });
  }

  pi.on("session_start", (_event, ctx) => {
    enabled = loadDefaultEnabled();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !isSupportedModel(ctx.model)) return undefined;
    if (!event.payload || typeof event.payload !== "object") return undefined;
    if ((event.payload as JsonObject).model !== ctx.model?.id) return undefined;

    return {
      ...(event.payload as JsonObject),
      service_tier: FAST_SERVICE_TIER,
    };
  });
}
