import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext } from "@/app/theme-context";
import {
  DENSITIES,
  DENSITY_KEY,
  THEMES,
  THEME_KEY,
  applyDensity,
  applyTheme,
  readPreference,
  systemPrefersDark,
  writePreference,
  type Density,
  type ThemePreference,
} from "@/lib/preferences";

/** Light / dark / system theme and table density, remembered per browser. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(() =>
    readPreference(THEME_KEY, THEMES, "system"),
  );
  const [density, setDensityState] = useState<Density>(() =>
    readPreference(DENSITY_KEY, DENSITIES, "comfortable"),
  );
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (theme !== "system") return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => applyTheme(resolvedTheme), [resolvedTheme]);
  useEffect(() => applyDensity(density), [density]);

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      density,
      setTheme: (next: ThemePreference) => {
        writePreference(THEME_KEY, next);
        setThemeState(next);
      },
      setDensity: (next: Density) => {
        writePreference(DENSITY_KEY, next);
        setDensityState(next);
      },
    }),
    [theme, resolvedTheme, density],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
