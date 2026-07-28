"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type ThemeMode = "system" | "light" | "dark";

const ThemeContext = createContext<{
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}>({ mode: "system", setMode: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("system");

  const apply = useCallback((next: ThemeMode) => {
    const root = document.documentElement;
    if (next === "system") {
      root.removeAttribute("data-theme");
      localStorage.removeItem("adloop-theme");
    } else {
      root.setAttribute("data-theme", next);
      localStorage.setItem("adloop-theme", next);
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("adloop-theme");
    if (stored === "light" || stored === "dark") {
      setModeState(stored);
      apply(stored);
    }
  }, [apply]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      apply(next);
    },
    [apply],
  );

  return (
    <ThemeContext.Provider value={{ mode, setMode }}>{children}</ThemeContext.Provider>
  );
}
