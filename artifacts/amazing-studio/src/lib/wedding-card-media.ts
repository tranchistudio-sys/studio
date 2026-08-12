export type WeddingMediaRole = "cover1" | "cover2" | "album";

export interface WeddingMediaItem {
  id: string;
  name: string;
  fingerprint: string;
  previewUrl: string;
  remoteUrl: string | null;
  role: WeddingMediaRole;
  status: "processing" | "uploading" | "complete" | "failed";
  progress: number;
  error?: string;
  file?: File;
}

export function fileFingerprint(file: Pick<File, "name" | "size" | "lastModified">): string {
  return `${file.name.toLowerCase()}::${file.size}::${file.lastModified}`;
}

export function assignInitialRoles<T extends { role?: WeddingMediaRole }>(items: T[]): Array<T & { role: WeddingMediaRole }> {
  return items.map((item, index) => ({ ...item, role: item.role ?? (index === 0 ? "cover1" : index === 1 ? "cover2" : "album") }));
}

export function setMediaRole(items: WeddingMediaItem[], id: string, role: WeddingMediaRole): WeddingMediaItem[] {
  const target = items.find((item) => item.id === id);
  if (!target || target.role === role) return items;
  if (role === "album") return items.map((item) => item.id === id ? { ...item, role } : item);
  return items.map((item) => {
    if (item.id === id) return { ...item, role };
    if (item.role === role) return { ...item, role: target.role === "album" ? "album" : target.role };
    return item;
  });
}

export function swapCovers(items: WeddingMediaItem[]): WeddingMediaItem[] {
  return items.map((item) => item.role === "cover1" ? { ...item, role: "cover2" } : item.role === "cover2" ? { ...item, role: "cover1" } : item);
}

export function removeMedia(items: WeddingMediaItem[], id: string): WeddingMediaItem[] {
  const removed = items.find((item) => item.id === id);
  const remaining = items.filter((item) => item.id !== id);
  if (!removed || removed.role === "album") return remaining;
  const replacementIndex = remaining.findIndex((item) => item.role === "album");
  if (replacementIndex < 0) return remaining;
  return remaining.map((item, index) => index === replacementIndex ? { ...item, role: removed.role } : item);
}

