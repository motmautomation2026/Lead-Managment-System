/**
 * Per-browser UI preferences in localStorage. Storage can be missing or throw
 * (private windows, blocked site data), so every access falls back silently.
 * index.html reads the same keys before first paint; keep them in sync.
 */
export const THEMES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEMES)[number];
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const THEME_KEY = "motmflow.theme";
export const DENSITY_KEY = "motmflow.density";
export const SIDEBAR_KEY = "motmflow.sidebarCollapsed";

export function readPreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice still applies for this page load.
  }
}

export function systemPrefersDark() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function applyTheme(resolved: "light" | "dark") {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function applyDensity(density: Density) {
  document.documentElement.dataset["density"] = density;
}
