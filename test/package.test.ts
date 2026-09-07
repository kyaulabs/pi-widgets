import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Pi package entry points", () => {
  it("ships the renamed extensions without duplicate legacy entries", () => {
    const root = new URL("../", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    expect(manifest.pi.extensions).toEqual([
      "./extensions/fast-mode.ts",
      "./extensions/tps.ts",
    ]);
    for (const entry of manifest.pi.extensions) {
      expect(existsSync(new URL(entry, root))).toBe(true);
    }
    for (const old of ["gpt-fast-mode-status.ts", "tps-status.ts"]) {
      expect(existsSync(new URL(`extensions/${old}`, root))).toBe(false);
    }
  });
});
