import { useState, useEffect, useRef, useCallback } from "react";
import { notificationFeedback } from "@/lib/feedback";
import { showNotificationToast } from "@/lib/notification-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string, opts?: RequestInit) {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return fetch(url, { ...opts, headers: { ...opts?.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}

export interface Notification {
  id: number;
  staffId: number | null;
  senderStaffId?: number | null;
  senderName?: string | null;
  type: string;
  priority: string;
  title: string;
  message: string;
  targetModule: string | null;
  targetId: string | null;
  bookingId: number | null;
  isRead: boolean;
  createdAt: string;
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem("notifSound") !== "off");
  const lastSoundRef = useRef(0);
  const hasInteracted = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sseConnectedRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const lastUnreadFetchRef = useRef(0);
  const MAX_SSE_RETRY = 3;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const handler = () => { hasInteracted.current = true; };
    document.addEventListener("click", handler, { once: true });
    document.addEventListener("keydown", handler, { once: true });
    return () => {
      document.removeEventListener("click", handler);
      document.removeEventListener("keydown", handler);
    };
  }, []);

  const playSound = useCallback(() => {
    if (!soundEnabled || !hasInteracted.current) return;
    const now = Date.now();
    if (now - lastSoundRef.current < 5000) return;
    lastSoundRef.current = now;
    notificationFeedback();
  }, [soundEnabled]);

  const notificationsInitRef = useRef(false);
  const knownNotifIdsRef = useRef(new Set<number>());

  const fetchNotifications = useCallback(async () => {
    try {
      const r = await authFetch(`${BASE}/api/notifications?limit=30`);
      if (!r.ok) return;
      const data = await r.json();
      if (!Array.isArray(data)) return;
      const list = data as Notification[];
      if (!notificationsInitRef.current) {
        list.forEach(n => knownNotifIdsRef.current.add(n.id));
        notificationsInitRef.current = true;
        setNotifications(list);
        return;
      }
      const fresh = list.filter(n => !knownNotifIdsRef.current.has(n.id));
      fresh.forEach(n => {
        knownNotifIdsRef.current.add(n.id);
        showNotificationToast(n);
      });
      setNotifications(list);
    } catch {}
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    try {
      lastUnreadFetchRef.current = Date.now();
      const r = await authFetch(`${BASE}/api/notifications/unread-count`);
      if (r.ok) {
        const data = await r.json();
        const next = data.count || 0;
        setUnreadCount(prev => {
          if (notificationsInitRef.current && next > prev) fetchNotifications();
          return next;
        });
      }
    } catch {}
  }, [fetchNotifications]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(() => {
      if (document.hidden) return;
      fetchUnreadCount();
    }, 60000);
  }, [fetchUnreadCount]);

  const closeSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    sseConnectedRef.current = false;
  }, []);

  const connectSSE = useCallback(() => {
    const token = localStorage.getItem("amazingStudioToken_v2");
    if (!token || !mountedRef.current) return;
    if (document.hidden) return;
    if (eventSourceRef.current) return;

    const es = new EventSource(`${BASE}/api/notifications/stream?token=${encodeURIComponent(token)}`);
    eventSourceRef.current = es;

    es.onopen = () => {
      retryCountRef.current = 0;
      sseConnectedRef.current = true;
      // SSE connected — stop fallback polling to reduce request thrash
      stopPolling();
    };

    es.onmessage = (event) => {
      try {
        const notif: Notification = JSON.parse(event.data);
        if (!knownNotifIdsRef.current.has(notif.id)) {
          knownNotifIdsRef.current.add(notif.id);
          showNotificationToast(notif);
        }
        setNotifications(prev => [notif, ...prev].slice(0, 50));
        setUnreadCount(prev => prev + 1);
        playSound();
      } catch {}
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      sseConnectedRef.current = false;
      if (!mountedRef.current || document.hidden) return;
      // Fall back to polling while SSE is down
      startPolling();
      retryCountRef.current += 1;
      // After MAX_SSE_RETRY attempts, give up reconnecting and rely on polling only.
      if (retryCountRef.current > MAX_SSE_RETRY) return;
      const delay = Math.min(5000 * Math.pow(2, retryCountRef.current), 120000);
      retryTimerRef.current = setTimeout(() => {
        if (mountedRef.current && !document.hidden) connectSSE();
      }, delay);
    };
  }, [playSound, startPolling, stopPolling]);

  // Initial fetch
  useEffect(() => {
    fetchNotifications();
    fetchUnreadCount();
  }, [fetchNotifications, fetchUnreadCount]);

  // SSE + visibility-aware polling
  useEffect(() => {
    connectSSE();

    const onVisibility = () => {
      if (document.hidden) {
        // Pause everything when tab is hidden to avoid proxy thrash
        closeSSE();
        stopPolling();
      } else {
        // Skip refetch if we just fetched recently (<30s) to reduce churn on desktop.
        if (Date.now() - lastUnreadFetchRef.current > 30000) {
          fetchUnreadCount();
        }
        retryCountRef.current = 0;
        connectSSE();
        if (!sseConnectedRef.current) startPolling();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      closeSSE();
      stopPolling();
    };
  }, [connectSSE, startPolling, stopPolling, closeSSE, fetchUnreadCount]);

  const markAsRead = useCallback(async (id: number) => {
    try {
      const r = await authFetch(`${BASE}/api/notifications/${id}/read`, { method: "PATCH" });
      if (r.ok) {
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
        setUnreadCount(prev => Math.max(0, prev - 1));
      }
    } catch {}
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      const r = await authFetch(`${BASE}/api/notifications/mark-all-read`, { method: "POST" });
      if (r.ok) {
        setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
        setUnreadCount(0);
      }
    } catch {}
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled(prev => {
      const next = !prev;
      localStorage.setItem("notifSound", next ? "on" : "off");
      return next;
    });
  }, []);

  return { notifications, unreadCount, soundEnabled, toggleSound, markAsRead, markAllRead, fetchNotifications };
}
