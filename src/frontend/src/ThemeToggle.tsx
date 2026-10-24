import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { getThemeSnapshot, setTheme, subscribeTheme } from "./theme";

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, storageError } = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
  );
  return (
    <div className="theme-control" data-theme-control>
      <div
        className={`theme-toggle ${compact ? "theme-toggle-compact" : ""}`}
        role="group"
        aria-label="外观主题"
      >
        <button
          type="button"
          aria-label="浅色模式"
          aria-pressed={theme === "light"}
          title="浅色模式"
          onClick={() => setTheme("light")}
        >
          <Sun size={15} aria-hidden="true" />
          <span>浅色</span>
        </button>
        <button
          type="button"
          aria-label="深色模式"
          aria-pressed={theme === "dark"}
          title="深色模式"
          onClick={() => setTheme("dark")}
        >
          <Moon size={15} aria-hidden="true" />
          <span>深色</span>
        </button>
      </div>
      {storageError && (
        <span className="theme-storage-error" role="status">
          已切换，浏览器暂时无法记住主题。
        </span>
      )}
    </div>
  );
}
