import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal .env reader. Node 18 has no --env-file, and a dependency for ~15 lines isn't
 * worth it. On Render the variables come from the dashboard, so this is a dev convenience
 * and never the source of truth.
 *
 * Existing process.env always wins, so `KEY=x npm run dev` overrides the file.
 */
export function loadDotEnv(file = path.resolve(process.cwd(), '../.env')): void {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return; // no .env is the normal case in production
  }

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
