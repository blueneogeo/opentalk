import { describe, it, expect } from "vitest"
import { parseTtsBlock } from "../src/config"

describe("parseTtsBlock", () => {
  it("parses a simple tts block", () => {
    const input = `description: something
tts:
  engine: kokoro
  voice: af_bella
`
    const result = parseTtsBlock(input)
    expect(result).toEqual({ engine: "kokoro", voice: "af_bella" })
  })

  it("returns null when no tts block is present", () => {
    const input = `description: something
mode: subagent
`
    expect(parseTtsBlock(input)).toBeNull()
  })

  it("stops parsing at the next top-level key", () => {
    const input = `tts:
  engine: kokoro
next_key: value
  voice: af_bella
`
    const result = parseTtsBlock(input)
    expect(result).toEqual({ engine: "kokoro" })
  })

  it("ignores comments", () => {
    const input = `tts:
  # this is a comment
  engine: say
  # another comment
  voice: Samantha
`
    const result = parseTtsBlock(input)
    expect(result).toEqual({ engine: "say", voice: "Samantha" })
  })

  it("ignores empty lines", () => {
    const input = `tts:

  engine: kokoro

  voice: af_bella

`
    const result = parseTtsBlock(input)
    expect(result).toEqual({ engine: "kokoro", voice: "af_bella" })
  })

  it("handles keys with underscores", () => {
    const input = `tts:
  api_provider: openrouter
  response_format: mp3
  base_url: https://example.com
`
    const result = parseTtsBlock(input)
    expect(result).toEqual({
      api_provider: "openrouter",
      response_format: "mp3",
      base_url: "https://example.com",
    })
  })

  it("handles values with colons (URLs)", () => {
    const input = `tts:
  base_url: https://openrouter.ai/api/v1
`
    const result = parseTtsBlock(input)
    expect(result).toEqual({ base_url: "https://openrouter.ai/api/v1" })
  })

  it("returns null for empty tts block", () => {
    const input = `tts:
  # only comments
`
    expect(parseTtsBlock(input)).toBeNull()
  })

  it("handles tab indentation", () => {
    const input = "tts:\n\tengine: kokoro\n\tvoice: af_bella"
    const result = parseTtsBlock(input)
    expect(result).toEqual({ engine: "kokoro", voice: "af_bella" })
  })
})
