/**
 * Minimal .env loader for the CLI scripts.
 *
 * Next.js loads .env.local itself; plain `tsx` does not. Kept dependency-free
 * and deliberately non-overriding, so a variable already in the shell wins.
 *
 * Import this *before* anything that reads configuration, because lib/config.ts
 * snapshots process.env at import time.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FILES = ['.env.local', '.env'];

export function loadEnv(cwd: string = process.cwd()): void {
  for (const file of FILES) {
    let contents: string;
    try {
      contents = readFileSync(path.join(cwd, file), 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of contents.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      if (!key || process.env[key] !== undefined) continue;
      let value = line.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnv();
