import { describe, it, expect } from "vitest"
import { resolveEnv } from "../src/config"

describe("resolveEnv", () => {
  it("returns the env value when variable is set", () => {
    process.env.TEST_VAR = "hello"
    expect(resolveEnv("${TEST_VAR}")).toBe("hello")
    delete process.env.TEST_VAR
  })

  it("returns empty string when variable is not set", () => {
    expect(resolveEnv("${NONEXISTENT_VAR_12345}")).toBe("")
  })

  it("returns the value as-is when it is not a ${VAR} pattern", () => {
    expect(resolveEnv("plain text")).toBe("plain text")
  })

  it("handles empty string", () => {
    expect(resolveEnv("")).toBe("")
  })

  it("does not resolve partial env vars (must match ^${...}$)", () => {
    process.env.PARTIAL = "test"
    expect(resolveEnv("prefix-${PARTIAL}")).toBe("prefix-${PARTIAL}")
    delete process.env.PARTIAL
  })
})
