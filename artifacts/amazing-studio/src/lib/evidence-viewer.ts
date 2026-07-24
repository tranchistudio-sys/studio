// Logic thuần cho viewer ảnh bằng chứng thu/chi (tách riêng để test không cần DOM).

/** Gom danh sách URL bằng chứng từ cặp field (proofImageUrls/proofImageUrl, receiptUrls/receiptUrl…). */
export function evidenceUrlList(urls?: string[] | null, single?: string | null): string[] {
  const list = (urls ?? []).filter((u): u is string => Boolean(u && u.trim()));
  if (list.length) return list;
  return single && single.trim() ? [single] : [];
}

/** Chuyển ảnh trước/sau, vòng lại đầu/cuối danh sách. */
export function stepEvidenceIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

/** Kẹp index mở đầu vào [0, count-1] để không mở ngoài danh sách. */
export function clampEvidenceIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}
