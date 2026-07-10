import { describe, it, expect } from "vitest"
import { parseTalkBlock } from "../src/config"

describe("parseTalkBlock", () => {
  it("parses a simple talk block", () => {
    const input = `mode: primary
talk:
  enabled: true
  process: false
  instruction: Custom instruction
  model: custom-model
`
    const result = parseTalkBlock(input)
    expect(result).toEqual({
      enabled: "true",
      process: "false",
      instruction: "Custom instruction",
      model: "custom-model",
    })
  })

  it("returns null when no talk block is present", () => {
    const input = `description: something
mode: subagent
`
    expect(parseTalkBlock(input)).toBeNull()
  })

  it("returns null for empty talk block", () => {
    const input = `
talk:
  # only a comment
next: thing
`
    expect(parseTalkBlock(input)).toBeNull()
  })

  it("parses a talk block with voice sub-block", () => {
    const input = `talk:
  enabled: true
  voice:
    provider: openrouter
    model: hexgrad/kokoro-82m
    voice: af_bella
    speed: 1.5
    response_format: pcm
`
    const result = parseTalkBlock(input)
    expect(result).toEqual({
      enabled: "true",
      voice: {
        provider: "openrouter",
        model: "hexgrad/kokoro-82m",
        voice: "af_bella",
        speed: "1.5",
        response_format: "pcm",
      },
    })
  })

  it("parses a talk block with only voice (agent override)", () => {
    const input = `talk:
  enabled: true
  voice:
    provider: say
`
    const result = parseTalkBlock(input)
    expect(result).toEqual({
      enabled: "true",
      voice: { provider: "say" },
    })
  })

  it("stops parsing at the next top-level key", () => {
    const input = `talk:
  enabled: true
  process: false
next_key: value
  should_be_ignored: yes
`
    const result = parseTalkBlock(input)
    expect(result).toEqual({ enabled: "true", process: "false" })
  })

  it("ignores comments", () => {
    const input = `talk:
  # this is a comment
  enabled: true
  # another comment
  process: false
`
    const result = parseTalkBlock(input)
    expect(result).toEqual({ enabled: "true", process: "false" })
  })

  it("ignores empty lines", () => {
    const input = `talk:

  enabled: true

  process: false

`
    const result = parseTalkBlock(input)
    expect(result).toEqual({ enabled: "true", process: "false" })
  })

  it("handles keys with underscores in voice block", () => {
    const input = `talk:
  voice:
    api_provider: openrouter
    response_format: mp3
    base_url: https://example.com
`
    const result = parseTalkBlock(input)
    expect(result).toEqual({
      voice: {
        api_provider: "openrouter",
        response_format: "mp3",
        base_url: "https://example.com",
      },
    })
  })

  it("handles values with colons in voice block (URLs)", () => {
    const input = `talk:
  voice:
    base_url: https://openrouter.ai/api/v1
`
    const result = parseTalkBlock(input)
    expect(result).toEqual({
      voice: { base_url: "https://openrouter.ai/api/v1" },
    })
  })

  it("handles tab indentation", () => {
    const input = "talk:\n\tenabled: true\n\tvoice:\n\t\tprovider: say"
    const result = parseTalkBlock(input)
    expect(result).toEqual({
      enabled: "true",
      voice: { provider: "say" },
    })
  })

  it("voice block between talk keys", () => {
    const input = `talk:
  enabled: true
  voice:
    provider: say
  process: false
`
    const result = parseTalkBlock(input)
    expect(result).toEqual({
      enabled: "true",
      process: "false",
      voice: { provider: "say" },
    })
  })

  it("only-enabled override", () => {
    const input = `talk:
  enabled: true
`
    const result = parseTalkBlock(input)
    expect(result).toEqual({ enabled: "true" })
  })
})
