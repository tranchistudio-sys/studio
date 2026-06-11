#!/usr/bin/env node
/**
 * Kill any process listening on the given port.
 * Works without lsof/fuser by reading /proc/net/tcp6 (Linux-only, always
 * available on Replit NixOS). Falls back silently on other platforms.
 *
 * Usage: node scripts/kill-port.mjs [port]   (defaults to $PORT or 8080)
 */
import { readFileSync, readdirSync, readlinkSync } from "fs";

const port = Number(process.argv[2] || process.env.PORT || 8080);
const portHex = port.toString(16).padStart(4, "0").toUpperCase();

function killProcessOnPort() {
  // Read both tcp and tcp6 — a listener may appear in either or both
  const contents = [];
  for (const f of ["/proc/net/tcp6", "/proc/net/tcp"]) {
    try { contents.push(readFileSync(f, "utf8")); } catch { /* skip */ }
  }
  if (contents.length === 0) return;
  const content = contents.join("\n");

  const line = content.split("\n").find((l) => {
    const cols = l.trim().split(/\s+/);
    if (cols.length < 10) return false;
    const localAddr = cols[1];
    const state = cols[3];
    const listenState = "0A";
    if (state !== listenState) return false;
    const addrPort = localAddr.split(":").pop();
    return addrPort && addrPort.toUpperCase() === portHex;
  });

  if (!line) return;

  const inode = line.trim().split(/\s+/)[9];
  if (!inode) return;

  let pids;
  try {
    pids = readdirSync("/proc").filter((f) => /^\d+$/.test(f));
  } catch {
    return;
  }

  for (const pid of pids) {
    try {
      const fds = readdirSync(`/proc/${pid}/fd`);
      for (const fd of fds) {
        try {
          const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (link === `socket:[${inode}]`) {
            const numPid = Number(pid);
            process.kill(numPid, "SIGTERM");
            console.log(`[kill-port] Sent SIGTERM to PID ${numPid} (port ${port})`);
            // Give process up to 500 ms to exit gracefully, then SIGKILL.
            // Do NOT .unref() — we must wait to guarantee the kill before the
            // dev server attempts to bind the same port.
            setTimeout(() => {
              try { process.kill(numPid, "SIGKILL"); } catch { /* already gone */ }
            }, 500);
            return;
          }
        } catch {
          /* fd unreadable — skip */
        }
      }
    } catch {
      /* process gone or no permission — skip */
    }
  }
}

killProcessOnPort();
