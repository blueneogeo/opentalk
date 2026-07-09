import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const LOG_DIR = join(homedir(), ".opentalk")
const LOG_FILE = join(LOG_DIR, "plugin.log")

let _initialized = false

/** Ensures the log directory exists. Creates it recursively if missing. */
function ensureLogDir(): void {
  if (_initialized) return
  try {
    mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    // Directory may already exist or be inaccessible — not fatal
  }
  _initialized = true
}

/** Append a line to the debug log. Failures are silently ignored. */
export function log(...args: unknown[]): void {
  ensureLogDir()
  try {
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`,
    )
  } catch {
    // Logging is best-effort
  }
}
