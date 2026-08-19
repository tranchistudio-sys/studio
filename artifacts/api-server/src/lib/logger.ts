import pino from "pino";
import { LOGGER_REDACT_PATHS } from "./log-redaction";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: [...LOGGER_REDACT_PATHS], censor: "[REDACTED]" },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
