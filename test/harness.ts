import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

type AnyFunction = (...args: any[]) => any;

type HarnessOptions = {
  model?: { provider?: string; id?: string };
  zentuiSegments?: boolean;
};

export function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, AnyFunction[]>();
  const commands = new Map<string, Record<string, AnyFunction | string>>();
  const shortcuts = new Map<string, Record<string, AnyFunction | string>>();

  const setStatus = vi.fn();
  const setWorkingMessage = vi.fn();
  const notify = vi.fn();
  const eventEmit = vi.fn((name: string, data: unknown) => {
    if (
      name === "zentui:working-line-segment-capability" &&
      options.zentuiSegments &&
      data &&
      typeof data === "object"
    ) {
      Object.assign(data, { supported: true, active: true });
    }
  });

  const ctx = {
    model: options.model,
    ui: {
      notify,
      setStatus,
      setWorkingMessage,
      theme: {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      },
    },
  } as unknown as ExtensionContext;

  const pi = {
    events: { emit: eventEmit },
    on: (name: string, handler: AnyFunction) => {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerCommand: (name: string, command: Record<string, AnyFunction | string>) => {
      commands.set(name, command);
    },
    registerShortcut: (name: string, shortcut: Record<string, AnyFunction | string>) => {
      shortcuts.set(name, shortcut);
    },
  } as unknown as ExtensionAPI;

  async function fire(name: string, event: unknown = {}) {
    const results = [];
    for (const handler of handlers.get(name) ?? []) {
      results.push(await handler(event, ctx));
    }
    return results;
  }

  function command(name: string) {
    const value = commands.get(name);
    if (!value) throw new Error(`Command not registered: ${name}`);
    return value;
  }

  function shortcut(name: string) {
    const value = shortcuts.get(name);
    if (!value) throw new Error(`Shortcut not registered: ${name}`);
    return value;
  }

  return {
    command,
    commands,
    ctx,
    eventEmit,
    fire,
    handlers,
    notify,
    pi,
    setStatus,
    setWorkingMessage,
    shortcut,
    shortcuts,
  };
}
