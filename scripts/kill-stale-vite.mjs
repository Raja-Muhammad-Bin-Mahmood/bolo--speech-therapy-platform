#!/usr/bin/env node
/**
 * Kills any stale Vite dev-server process holding port 5173 so the
 * preview always boots on the expected port.  Pure Node — no external
 * dependencies, works on any Linux with /proc.
 */
import { readdirSync, readFileSync, readlinkSync, existsSync } from "node:fs";
import { kill } from "node:process";

const PORT = 5173;
const hexPort = PORT.toString(16).padStart(4, "0"); // "1435"

function getSocketInodes() {
  const inodes = new Set();
  for (const netFile of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(netFile)) continue;
    const content = readFileSync(netFile, "utf8");
    for (const line of content.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const [, localAddr, , state] = parts;
      const [, portHex] = localAddr.split(":");
      if (portHex.toLowerCase() === hexPort && state === "0A") {
        inodes.add(parts[9]);
      }
    }
  }
  return inodes;
}

function findPidsHoldingPort(inodes) {
  const pids = [];
  const procEntries = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  for (const pid of procEntries) {
    const fdDir = `/proc/${pid}/fd`;
    if (!existsSync(fdDir)) continue;
    let fds;
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`${fdDir}/${fd}`);
        const match = target.match(/socket:\[(\d+)\]/);
        if (match && inodes.has(match[1])) {
          pids.push(pid);
          break;
        }
      } catch {
        // broken symlink or permission — skip
      }
    }
  }
  return pids;
}

const inodes = getSocketInodes();
if (inodes.size > 0) {
  const pids = findPidsHoldingPort(inodes);
  for (const pid of pids) {
    try {
      kill(Number(pid), "SIGTERM");
      console.log(`[dev] Killed stale process ${pid} holding port ${PORT}`);
    } catch {
      console.warn(`[dev] Could not kill pid ${pid} — ignoring`);
    }
  }
}