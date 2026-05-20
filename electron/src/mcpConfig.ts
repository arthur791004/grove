// Per-tab MCP config helper.
//
// When a tab opens in Claude mode and the workspace has a browser panel,
// Grove writes a small JSON file describing the Playwright MCP server and
// hands its path to `claude --mcp-config <path>`. Claude Code spawns the MCP
// server itself from the config's `command`/`args`, so Grove never manages
// the MCP child process — it only supplies the config and the CDP proxy URL.
//
// Filenames embed the owning process pid so two concurrent Grove instances
// (sharing one userData dir) don't delete each other's live configs.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite';

const CONFIG_PREFIX = 'grove-mcp-';
const CONFIG_RE = /^grove-mcp-(\d+)-.+\.json$/;

function configDir(): string {
  return path.join(app.getPath('userData'), 'mcp');
}

function configPathFor(tabId: string): string {
  // Tab ids come from store.uid() (alphanumeric), but sanitize anyway so a
  // malformed id can never escape the mcp/ directory.
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(configDir(), `${CONFIG_PREFIX}${process.pid}-${safe}.json`);
}

export interface PlaywrightMcpConfig {
  cdpEndpoint: string;
}

export function writePlaywrightMcpConfig(tabId: string, opts: PlaywrightMcpConfig): string {
  const config = {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', opts.cdpEndpoint],
      },
    },
  };
  const p = configPathFor(tabId);
  atomicWriteFile(p, JSON.stringify(config, null, 2));
  return p;
}

export function deleteMcpConfig(tabId: string): void {
  try {
    fs.unlinkSync(configPathFor(tabId));
  } catch {
    // ENOENT is fine — config may never have been written for this tab.
  }
}

// Drop configs whose owning process is no longer alive — leftovers from a
// crashed run. Configs belonging to a live pid (another Grove instance) are
// left untouched. Called once at app startup.
export function pruneStaleMcpConfigs(): void {
  let names: string[];
  try {
    names = fs.readdirSync(configDir());
  } catch {
    return; // dir doesn't exist yet — nothing to prune
  }
  for (const name of names) {
    const pid = Number(name.match(CONFIG_RE)?.[1]);
    if (!pid || isProcessAlive(pid)) continue;
    try {
      fs.unlinkSync(path.join(configDir(), name));
    } catch {
      /* ignore */
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
