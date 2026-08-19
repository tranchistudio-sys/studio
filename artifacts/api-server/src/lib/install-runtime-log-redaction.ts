import { installRuntimeConsoleRedaction } from "./runtime-log-redaction";

// Side-effect import from index.ts. It must run before app/routes are evaluated
// so legacy console calls cannot bypass the central Pino redaction policy.
installRuntimeConsoleRedaction();
