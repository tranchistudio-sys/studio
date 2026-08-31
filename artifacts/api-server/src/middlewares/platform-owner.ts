import type { NextFunction, Request, Response } from "express";
import type { PlatformSessionContext } from "../platform/types";

export function requirePlatformOwner(_req: Request, res: Response, next: NextFunction): void {
  const context = res.locals.platformAuth as PlatformSessionContext | undefined;
  if (!context) { res.status(401).json({ error: "Chưa đăng nhập" }); return; }
  if (context.platformRole !== "PLATFORM_OWNER") {
    res.status(403).json({ error: "Chỉ Platform Owner được truy cập" }); return;
  }
  next();
}
