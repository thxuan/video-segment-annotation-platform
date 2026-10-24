export type Theme = "dark" | "light";

// Keep the first-paint script in index.html on the same storage key.
export const THEME_STORAGE_KEY = "video-annotation-theme";
const normalizeTheme = (value: string | null): Theme =>
  value === "light" ? "light" : "dark";

function readTheme(): Theme {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

let snapshot = { theme: readTheme(), storageError: false };
const listeners = new Set<() => void>();

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#f2f1ec" : "#101012");
}

function update(theme: Theme, storageError: boolean) {
  applyTheme(theme);
  snapshot = { theme, storageError };
  listeners.forEach((listener) => listener());
}

export function setTheme(theme: Theme) {
  let storageError = false;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    storageError = true;
  }
  update(theme, storageError);
}

export const getThemeSnapshot = () => snapshot;
export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

applyTheme(snapshot.theme);
window.addEventListener("storage", (event) => {
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  try {
    if (event.storageArea !== window.localStorage) return;
  } catch {
    return;
  }
  update(normalizeTheme(event.newValue), false);
});
