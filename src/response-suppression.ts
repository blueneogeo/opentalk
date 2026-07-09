/**
 * Response suppression — intercepts globalThis.Response construction
 * to mute the error that the framework generates when we abort a
 * chat.message hook via throw.
 *
 * Uses a one-shot flag instead of a timed window:
 * - arm before throwing
 * - the very next 4xx/5xx Response gets consumed (rewritten to 200 ok)
 * - flag self-clears — subsequent errors pass through normally
 * - safety timeout clears stale flags after 5 seconds
 *
 * This is an intentional workaround for the current OpenCode plugin
 * architecture. When the framework adds a built-in error-suppression
 * mechanism this module can be removed.
 */
import { log } from "./logger"

const OriginalResponse = globalThis.Response

/** Number of pending suppressions. Each call to activate() arms one shot. */
let _pending = 0

/** Safety timeout ID for clearing stale suppressions. */
let _safetyTimeout: ReturnType<typeof setTimeout> | undefined

const SAFETY_TIMEOUT_MS = 5_000

/**
 * Arm the suppressor to consume the next framework error.
 * Call immediately before throw to suppress the error the
 * framework generates in response.
 */
export function activateSuppression(): void {
  _pending++
  log("SUPPRESS", "armed (pending=" + _pending + ")")

  // Safety net: clear any stale suppressions after the timeout
  if (_safetyTimeout) clearTimeout(_safetyTimeout)
  _safetyTimeout = setTimeout(() => {
    if (_pending > 0) {
      log("SUPPRESS", "safety timeout — clearing", _pending, "pending")
      _pending = 0
    }
  }, SAFETY_TIMEOUT_MS)
}

export function installResponseSuppression(): void {
  globalThis.Response = function (
    this: unknown,
    body?: unknown,
    init?: ResponseInit & { status?: number },
  ) {
    let bodyStr = ""
    try {
      if (typeof body === "string") {
        bodyStr = body
      } else if (body && typeof body === "object") {
        const keys = Object.keys(body)
        // Bun encodes Response bodies as objects with numeric keys (char codes)
        if (
          keys.length > 2 &&
          keys.every(
            (k, i) =>
              String(i) === k &&
              typeof (body as Record<string, unknown>)[k] === "number",
          )
        ) {
          bodyStr = String.fromCharCode(
            ...Object.values(body as Record<number, number>),
          )
        } else {
          bodyStr = JSON.stringify(body)
        }
      } else {
        bodyStr = String(body ?? "")
      }
    } catch (e) {
      bodyStr = "[err:" + String(e) + "]"
    }

    // One-shot suppression: consume the next error response
    if (_pending > 0 && init?.status !== undefined && init.status >= 400) {
      _pending--
      log("SUPPRESSED", "(pending=" + _pending + ")", bodyStr.slice(0, 200))
      return new OriginalResponse(JSON.stringify({ ok: true }), {
        ...init,
        status: 200,
      })
    }

    return new OriginalResponse(body as BodyInit | null | undefined, init)
  } as unknown as typeof Response

  Object.defineProperty(globalThis.Response, "prototype", {
    value: OriginalResponse.prototype,
  })
}

export function uninstallResponseSuppression(): void {
  globalThis.Response = OriginalResponse
}
