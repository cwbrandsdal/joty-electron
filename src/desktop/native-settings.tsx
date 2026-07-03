import { useEffect, useState } from "react";
import type { DesktopSettings } from "./electron-api";

/** Desktop-only preferences (launch at login, tray, updates, capture hotkey). */
export function NativeSettings() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const bridge = typeof window.joty !== "undefined";

  useEffect(() => {
    if (!bridge) return;
    window.joty!.getSettings().then(setSettings);
  }, [bridge]);

  if (!bridge || !settings) return null;

  function update(partial: Partial<DesktopSettings>) {
    setSettings((s) => (s ? { ...s, ...partial } : s));
    window.joty!.updateSettings(partial).then(setSettings);
  }

  return (
    <div className="space-y-3">
      <Toggle
        label="Launch Joty at login"
        checked={settings.launchAtLogin}
        onChange={(v) => update({ launchAtLogin: v })}
      />
      <Toggle
        label="Keep running in the system tray when closed"
        checked={settings.minimizeToTray}
        onChange={(v) => update({ minimizeToTray: v })}
      />
      <Toggle
        label="Download updates automatically"
        checked={settings.autoDownloadUpdates}
        onChange={(v) => update({ autoDownloadUpdates: v })}
      />
      <div>
        <label className="block text-sm text-ink-secondary">Quick capture shortcut</label>
        <p className="mt-0.5 text-xs text-ink-muted">
          Global hotkey that opens a scratch note window (e.g. CommandOrControl+Shift+J).
        </p>
        <input
          defaultValue={settings.quickCaptureShortcut}
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (value && value !== settings.quickCaptureShortcut) {
              update({ quickCaptureShortcut: value });
            }
          }}
          className="mt-1 w-64 rounded-sm border border-border bg-page px-2 py-1 text-sm text-ink outline-none focus:border-accent"
        />
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-secondary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  );
}
