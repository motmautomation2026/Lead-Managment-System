import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/app/theme-provider";
import { useTheme } from "@/app/theme-context";
import { DENSITY_KEY, THEME_KEY } from "@/lib/preferences";

function Probe() {
  const { theme, resolvedTheme, density, setTheme, setDensity } = useTheme();
  return (
    <div>
      <span data-testid="state">{`${theme}/${resolvedTheme}/${density}`}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setDensity("compact")}>compact</button>
    </div>
  );
}

function mockSystemDark(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

const html = document.documentElement;

beforeEach(() => {
  window.localStorage.clear();
  html.className = "";
  delete html.dataset["density"];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThemeProvider", () => {
  it("defaults to system and follows prefers-color-scheme", () => {
    mockSystemDark(true);
    render(<ThemeProvider children={<Probe />} />);
    expect(screen.getByTestId("state")).toHaveTextContent("system/dark/comfortable");
    expect(html).toHaveClass("dark");
    expect(html.dataset["density"]).toBe("comfortable");
  });

  it("stores the choice and applies it to <html>", () => {
    mockSystemDark(false);
    render(<ThemeProvider children={<Probe />} />);
    act(() => screen.getByText("dark").click());
    expect(html).toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    act(() => screen.getByText("light").click());
    expect(html).not.toHaveClass("dark");
    act(() => screen.getByText("compact").click());
    expect(html.dataset["density"]).toBe("compact");
    expect(window.localStorage.getItem(DENSITY_KEY)).toBe("compact");
  });

  it("restores saved preferences and ignores unknown values", () => {
    mockSystemDark(true);
    window.localStorage.setItem(THEME_KEY, "light");
    window.localStorage.setItem(DENSITY_KEY, "huge");
    render(<ThemeProvider children={<Probe />} />);
    expect(screen.getByTestId("state")).toHaveTextContent("light/light/comfortable");
  });

  it("works when localStorage and matchMedia throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.stubGlobal("matchMedia", () => {
      throw new Error("no matchMedia");
    });
    render(<ThemeProvider children={<Probe />} />);
    expect(screen.getByTestId("state")).toHaveTextContent("system/light/comfortable");
    act(() => screen.getByText("dark").click());
    expect(html).toHaveClass("dark");
  });
});
