import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock filesystem before importing the module under test
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}))

const fs = await import("node:fs")
const { createConfigLoader } = await import("../src/config")

describe("createConfigLoader", () => {
  const mockResolver = vi.fn().mockResolvedValue(null)

  beforeEach(() => {
    vi.clearAllMocks()
    mockResolver.mockReset().mockResolvedValue(null)
  })

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY
  })

  it("returns default config when no speak.md is found", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const getConfig = createConfigLoader({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getConfig()
    expect(config.engine).toBe("kokoro")
    expect(config.voice).toBe("af_bella")
    expect(config.speed).toBe(1.0)
  })

  it("parses speak.md with kokoro engine", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(`---
tts:
  engine: kokoro
  voice: af_nicole
  speed: 1.5
---
`)

    const getConfig = createConfigLoader({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getConfig()
    expect(config.engine).toBe("kokoro")
    expect(config.voice).toBe("af_nicole")
    expect(config.speed).toBe(1.5)
  })

  it("falls back to say when openrouter has no credentials", async () => {
    // Ensure no env var leaks in
    delete process.env.OPENROUTER_API_KEY

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(`---
tts:
  engine: openrouter
---
`)

    const getConfig = createConfigLoader({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getConfig()
    expect(config.engine).toBe("say")
  })

  it("validates engine field — unknown engine falls back to default", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(`---
tts:
  engine: foobar
  voice: some_voice
---
`)

    const getConfig = createConfigLoader({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getConfig()
    expect(config.engine).toBe("kokoro") // default
  })

  it("handles speed: 0 correctly (not falsy fallback)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(`---
tts:
  engine: kokoro
  speed: 0
---
`)

    const getConfig = createConfigLoader({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getConfig()
    expect(config.speed).toBe(0)
  })
})
