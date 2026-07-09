/**
 * Response suppression — intercepts globalThis.Response construction
 * to mute "Failed to send prompt" / "UnknownError" errors that the
 * speak subagent would otherwise surface to the user.
 *
 * This is an intentional workaround for the current OpenCode plugin
 * architecture. When the framework adds a built-in error-suppression
 * mechanism this module can be removed.
 */
import { log } from "./logger"

const OriginalResponse = globalThis.Response

let _suppress = false

export function setResponseSuppression(value: boolean): void {
  _suppress = value
}

export function installResponseSuppression(): void {
  globalThis.Response = function (
    this: unknown,
    body?: unknown,
    init?: ResponseInit & { status?: number },
  ) {
    if (!_suppress) {
      return new OriginalResponse(body as BodyInit | null | undefined, init)
    }

    let bodyStr = ""
    try {
      if (typeof body === "string") {
        bodyStr = body
      } else if (body && typeof body === "object") {
        const keys = Object.keys(body)
        // Bun encodes Response bodies as objects with numeric keys (char codes)
        if (
          keys.length > 2 &&
          keys.every((k, i) => String(i) === k && typeof (body as Record<string, unknown>)[k] === "number")
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

    log(
      "RESP",
      init?.status ?? "?",
      "len=" + bodyStr.length,
      bodyStr.slice(0, 300),
    )

    if (init?.status !== undefined && init.status >= 400) {
      // Match on stable error type names
      if (
        bodyStr.includes('"name":"UnknownError"') ||
        bodyStr.includes('"name":"InternalServerError"')
      ) {
        log("SUPPRESSED", bodyStr.slice(0, 200))
        return new OriginalResponse(JSON.stringify({ ok: true }), {
          ...init,
          status: 200,
        })
      }
      // Fallback: match on known display messages
      if (
        bodyStr.includes("Failed to send prompt") ||
        bodyStr.includes("Unexpected server error")
      ) {
        log("SUPPRESSED (message match)", bodyStr.slice(0, 200))
        return new OriginalResponse(JSON.stringify({ ok: true }), {
          ...init,
          status: 200,
        })
      }
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
