import { createContext, useContext } from "react";
import type { Density, ThemePreference } from "@/lib/preferences";

export interface ThemeControls {
  theme: ThemePreference;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: ThemePreference) => void;
  density: Density;
  setDensity: (density: Density) => void;
}

export const ThemeContext = createContext<ThemeControls>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => undefined,
  density: "comfortable",
  setDensity: () => undefined,
});

export function useTheme() {
  return useContext(ThemeContext);
}
