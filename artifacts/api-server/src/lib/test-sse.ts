import type { Response } from "express";

export type TestSseEvent =
  | { type: "follow_up"; sessionId: string; message: Record<string, unknown> }
  | { type: "debug_update"; sessionId: string; debug: Record<string, unknown> }
  | { type: "ping" };

const clients = new Map<string, Set<Response>>();

export function subscribeTestSession(sessionId: string, res: Response): () => void {
  if (!clients.has(sessionId)) clients.set(sessionId, new Set());
  clients.get(sessionId)!.add(res);
  return () => {
    const set = clients.get(sessionId);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(sessionId);
    }
  };
}

export function emitTestSessionEvent(sessionId: string, event: Omit<TestSseEvent, "type"> & { type: string }): void {
  const set = clients.get(sessionId);
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
