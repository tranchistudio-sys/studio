import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Monitor, Smartphone, Tablet } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_DEVICE_ID,
  DEVICE_PRESETS,
  getDeviceById,
  STORAGE_DEVICE_KEY,
  STORAGE_MODE_KEY,
  TABLET_PRESET,
  type DevicePresetId,
  type PreviewMode,
} from "./device-presets";
import "./dev-responsive-preview.css";

function readStoredMode(): PreviewMode {
  try {
    const v = localStorage.getItem(STORAGE_MODE_KEY);
    if (v === "mobile" || v === "tablet" || v === "desktop") return v;
  } catch { /* ignore */ }
  return "mobile";
}

function readStoredDevice(): DevicePresetId {
  try {
    const v = localStorage.getItem(STORAGE_DEVICE_KEY) as DevicePresetId | null;
    if (v && DEVICE_PRESETS.some((d) => d.id === v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_DEVICE_ID;
}

function buildIframeSrc(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

export function DevResponsivePreview({ children }: { children: ReactNode }) {
  const inIframe = typeof window !== "undefined" && window.self !== window.top;

  if (!import.meta.env.DEV || inIframe) {
    return <>{children}</>;
  }

  return <DevResponsivePreviewShell>{children}</DevResponsivePreviewShell>;
}

function DevResponsivePreviewShell({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<PreviewMode>(readStoredMode);
  const [deviceId, setDeviceId] = useState<DevicePresetId>(readStoredDevice);
  const [iframeSrc, setIframeSrc] = useState(buildIframeSrc);
  const [toolbarOpen, setToolbarOpen] = useState(true);

  const device = useMemo(() => getDeviceById(deviceId), [deviceId]);

  const frameSize = useMemo(() => {
    if (mode === "tablet") return TABLET_PRESET;
    if (mode === "mobile") return device;
    return null;
  }, [mode, device]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_MODE_KEY, mode);
    } catch { /* ignore */ }
  }, [mode]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_DEVICE_KEY, deviceId);
    } catch { /* ignore */ }
  }, [deviceId]);

  const syncIframeFromApp = useCallback(() => {
    setIframeSrc(buildIframeSrc());
  }, []);

  useEffect(() => {
    const onPopState = () => syncIframeFromApp();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [syncIframeFromApp]);

  useEffect(() => {
    if (mode === "desktop") return;
    syncIframeFromApp();
  }, [mode, deviceId, syncIframeFromApp]);

  const modeButtons: { id: PreviewMode; label: string; icon: typeof Monitor }[] = [
    { id: "mobile", label: "Mobile Preview", icon: Smartphone },
    { id: "tablet", label: "Tablet Preview", icon: Tablet },
    { id: "desktop", label: "Desktop Preview", icon: Monitor },
  ];

  return (
    <div className="dev-preview-root">
      <div className={cn("dev-preview-toolbar", !toolbarOpen && "is-collapsed")}>
        <button
          type="button"
          className="dev-preview-toolbar-toggle"
          onClick={() => setToolbarOpen((v) => !v)}
          title={toolbarOpen ? "Thu gọn toolbar" : "Mở toolbar"}
        >
          {toolbarOpen ? "▾" : "◂"} DEV
        </button>

        {toolbarOpen && (
          <div className="dev-preview-toolbar-body">
            <span className="dev-preview-badge">DEV MODE</span>
            <div className="dev-preview-mode-group">
              {modeButtons.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={cn("dev-preview-mode-btn", mode === id && "is-active")}
                  onClick={() => setMode(id)}
                  title={label}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label.replace(" Preview", "")}</span>
                </button>
              ))}
            </div>

            {mode === "mobile" && (
              <label className="dev-preview-device-select">
                <span className="sr-only">Thiết bị</span>
                <select
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value as DevicePresetId)}
                >
                  {DEVICE_PRESETS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label} ({d.width}×{d.height})
                    </option>
                  ))}
                </select>
              </label>
            )}

            {frameSize && (
              <span className="dev-preview-size">
                {frameSize.width} × {frameSize.height}px
              </span>
            )}

            <span className="dev-preview-hint" title="Chrome DevTools">
              F12 · Ctrl+Shift+M
            </span>
          </div>
        )}
      </div>

      {mode === "desktop" ? (
        <div className="dev-preview-desktop">{children}</div>
      ) : (
        <div className="dev-preview-stage">
          <div
            className="dev-preview-device"
            style={{ width: frameSize!.width, height: frameSize!.height }}
          >
            <div className="dev-preview-device-notch" aria-hidden />
            <iframe
              key={`${mode}-${deviceId}-${iframeSrc}`}
              title="Mobile preview"
              src={iframeSrc}
              className="dev-preview-iframe"
            />
          </div>
          <p className="dev-preview-caption">
            {mode === "mobile" ? device.label : TABLET_PRESET.label} — viewport{" "}
            {frameSize!.width}×{frameSize!.height}
          </p>
        </div>
      )}
    </div>
  );
}
