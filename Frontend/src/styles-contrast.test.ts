import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Text/background token pairs that must reach WCAG AA (4.5:1) in both themes. */
const PAIRS: Array<[fg: string, bg: string]> = [
  ["foreground", "background"],
  ["foreground", "surface-raised"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["primary", "card"],
  ["primary", "background"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["destructive", "card"],
  ["success-foreground", "success"],
  ["warning-foreground", "warning"],
  ["info-foreground", "info"],
  ["success-soft-foreground", "success-soft"],
  ["warning-soft-foreground", "warning-soft"],
  ["info-soft-foreground", "info-soft"],
  ["danger-soft-foreground", "danger-soft"],
  ["sidebar-foreground", "sidebar"],
  ["sidebar-accent-foreground", "sidebar-accent"],
  ["sidebar-primary-foreground", "sidebar-primary"],
];

const css = readFileSync("src/styles.css", "utf8"); // vitest runs from Frontend/

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
}

/** Linear sRGB channels (0–1) of a hex or oklch() colour. */
function linearRgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    return [0, 2, 4].map((i) => {
      const c = parseInt((hex[1] ?? "").slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
  }
  const ok = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(value.trim());
  if (!ok) throw new Error(`Unsupported colour: ${value}`);
  const [L = 0, C = 0, h = 0] = ok.slice(1).map(Number);
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function contrast(fg: string, bg: string) {
  const lum = (v: string) => {
    const [r, g, b] = linearRgb(v);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [x, y] = [lum(fg), lum(bg)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("theme token contrast", () => {
  const light = block(":root,\n.light {");
  const dark = { ...light, ...block(".dark {") };

  it.each([
    ["light", light],
    ["dark", dark],
  ])("text tokens reach 4.5:1 in %s", (_name, tokens) => {
    const results = PAIRS.map(([fg, bg]) => ({
      pair: `${fg} on ${bg}`,
      ratio: Number(contrast(tokens[fg] ?? "", tokens[bg] ?? "").toFixed(2)),
    }));
    if (process.env["PRINT_CONTRAST"]) console.table(results);
    expect(results.filter((r) => r.ratio < 4.5)).toEqual([]);
  });
});
