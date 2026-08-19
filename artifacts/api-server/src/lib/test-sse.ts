import type { Response } from "express";
import { tenantScopedKey } from "./tenant-scope";

export type TestSseEvent =
  | { type: "follow_up"; sessionId: string; message: Record<string, unknown> }
  | { type: "debug_update"; sessionId: string; debug: Record<string, unknown> }
  | { type: "ping" };

const clients = new Map<string, Set<Response>>();

export function subscribeTestSession(sessionId: string, res: Response): () => void {
  const key = tenantScopedKey("ai-test-session", sessionId);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key)!.add(res);
  return () => {
    const set = clients.get(key);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(key);
    }
  };
}

export function emitTestSessionEvent(sessionId: string, event: TestSseEvent): void {
  const set = clients.get(tenantScopedKey("ai-test-session", sessionId));
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      // Connection already closed; cleanup will happen on close/error
    }
  }
}

export function broadcastPing(): void {
  const payload = `data: ${JSON.stringify({ type: "ping" })}\n\n`;
  for (const set of clients.values()) {
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        // ignore
      }
    }
  }
}
