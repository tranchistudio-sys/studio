export type PreviewMode = "mobile" | "tablet" | "desktop";

export type DevicePresetId =
  | "iphone-se"
  | "iphone-13-14"
  | "iphone-15-pro"
  | "samsung-s24";

export interface DevicePreset {
  id: DevicePresetId;
  label: string;
  width: number;
  height: number;
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-13-14", label: "iPhone 13/14", width: 390, height: 844 },
  { id: "iphone-15-pro", label: "iPhone 15 Pro", width: 393, height: 852 },
  { id: "samsung-s24", label: "Samsung S24", width: 360, height: 780 },
];

export const DEFAULT_DEVICE_ID: DevicePresetId = "iphone-15-pro";

export const TABLET_PRESET = { label: "Tablet", width: 768, height: 1024 };

export const STORAGE_MODE_KEY = "amazing-dev-preview-mode";
export const STORAGE_DEVICE_KEY = "amazing-dev-preview-device";

export function getDeviceById(id: DevicePresetId): DevicePreset {
  return DEVICE_PRESETS.find((d) => d.id === id) ?? DEVICE_PRESETS[2];
}
