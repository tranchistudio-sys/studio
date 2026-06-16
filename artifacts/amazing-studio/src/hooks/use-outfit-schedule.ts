import { useQuery } from "@tanstack/react-query";

import { API_BASE } from "@/lib/api-base";

export interface ScheduleItem {
  id: number;
  pickupDate: string;
  returnDate: string;
  status: string;
  note?: string | null;
  bookingCode?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
}

export interface ConflictResult {
  conflicts: { id: number; pickup_date: string; return_date: string; order_code: string; customer_name: string }[];
}

export interface OutfitStats {
  totalUses: number;
  last30Days: number;
  upcoming: ScheduleItem[];
  history: ScheduleItem[];
}

function authFetch(url: string, opts?: RequestInit) {
  const token = localStorage.getItem("amazingStudioToken_v2");
  const headers = { ...(opts?.headers as Record<string, string> ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return fetch(url, { ...opts, headers });
}

export function useOutfitSchedule(dressId: number | null | undefined, mode: "admin" | "public" = "public", enabled = true) {
  return useQuery<ScheduleItem[]>({
    queryKey: ["outfit-schedule", dressId, mode],
    queryFn: async () => {
      if (!dressId) return [];
      const res = await authFetch(`${API_BASE}/api/dresses/${dressId}/schedule?mode=${mode}`);
      if (!res.ok) throw new Error("Lỗi tải lịch");
      return res.json();
    },
    enabled: !!dressId && enabled,
    staleTime: 1000 * 60,
  });
}

export function useOutfitConflict(dressId: number | null | undefined, pickup: string | undefined, returnDate: string | undefined, excludeId?: number | null, enabled = true) {
  return useQuery<ConflictResult>({
    queryKey: ["outfit-conflict", dressId, pickup, returnDate, excludeId],
    queryFn: async () => {
      if (!dressId || !pickup || !returnDate) return { conflicts: [] };
      const url = new URL(`${API_BASE}/api/dresses/${dressId}/conflict`, window.location.origin);
      url.searchParams.set("pickup", pickup);
      url.searchParams.set("return", returnDate);
      if (excludeId) url.searchParams.set("excludeId", String(excludeId));
      const res = await authFetch(url.toString());
      if (!res.ok) throw new Error("Lỗi kiểm tra trùng");
      return res.json();
    },
    enabled: !!dressId && !!pickup && !!returnDate && enabled,
    staleTime: 1000 * 30,
  });
}

export function useOutfitStats(dressId: number | null | undefined, enabled = true) {
  return useQuery<OutfitStats>({
    queryKey: ["outfit-stats", dressId],
    queryFn: async () => {
      if (!dressId) throw new Error("Missing dressId");
      const res = await authFetch(`${API_BASE}/api/dresses/${dressId}/stats`);
      if (!res.ok) throw new Error("Lỗi tải thống kê");
      return res.json();
    },
    enabled: !!dressId && enabled,
    staleTime: 1000 * 60,
  });
}
