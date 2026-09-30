import { appendFileSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Repository root (this file lives in `<root>/src/`). */
export const EXT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const LOG = join(EXT_DIR, "debug.log")

/** Append a timestamped line to the extension's own log. Never throws. */
export function dbg(msg: string): void {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}

/** Keep the log bounded so it can never fill the disk. */
export function rotateLog(): void {
  try {
    const stat = statSync(LOG)
    if (stat.size > 512 * 1024) renameSync(LOG, `${LOG}.1`)
  } catch {
    /* file may not exist yet */
  }
}
