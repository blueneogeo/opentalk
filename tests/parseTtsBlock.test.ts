import { describe, it, expect } from "vitest"
import { parseSpeakBlock } from "../src/config"

describe("parseSpeakBlock", () => {
  it("parses a simple speak block", () => {
    const input = `mode: primary
speak:
  enabled: true
  process: false
  instruction: Custom instruction
  model: custom-model
`
    const result = parseSpeakBlock(input)
    expect(result).toEqual({
      enabled: "true",
      process: "false",
      instruction: "Custom instruction",
      model: "custom-model",
    })
  })

  it("returns null when no speak block is present", () => {
    const input = `description: something
mode: subagent
`
    expect(parseSpeakBlock(input)).toBeNull()
  })

  it("returns null for empty speak block", () => {
    const input = `
speak:
  # only a comment
next: thing
`
    expect(parseSpeakBlock(input)).toBeNull()
  })

  it("parses a speak block with voice sub-block", () => {
    const input = `speak:
  enabled: true
  voice:
    provider: openrouter
    model: hexgrad/kokoro-82m
    voice: af_bella
    speed: 1.5
    response_format: pcm
`
    const result = parseSpeakBlock(input)
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

  it("parses a speak block with only voice (agent override)", () => {
    const input = `speak:
  enabled: true
  voice:
    provider: say
`
    const result = parseSpeakBlock(input)
    expect(result).toEqual({
      enabled: "true",
      voice: { provider: "say" },
    })
  })

  it("stops parsing at the next top-level key", () => {
    const input = `speak:
  enabled: true
  process: false
next_key: value
  should_be_ignored: yes
`
    const result = parseSpeakBlock(input)
    expect(result).toEqual({ enabled: "true", process: "false" })
  })

  it("ignores comments", () => {
    const input = `speak:
  # this is a comment
  enabled: true
  # another comment
  process: false
`
    const result = parseSpeakBlock(input)
    expect(result).toEqual({ enabled: "true", process: "false" })
  })

  it("ignores empty lines", () => {
    const input = `speak:

  enabled: true

  process: false

`
    const result = parseSpeakBlock(input)
    expect(result).toEqual({ enabled: "true", process: "false" })
  })

  it("handles keys with underscores in voice block", () => {
    const input = `speak:
  voice:
    api_provider: openrouter
    response_format: mp3
    base_url: https://example.com
`
    const result = parseSpeakBlock(input)
    expect(result).toEqual({
      voice: {
        api_provider: "openrouter",
        response_format: "mp3",
        base_url: "https://example.com",
      },
    })
  })

  it("handles values with colons in voice block (URLs)", () => {
    const input = `speak:
  voice:
    base_url: https://openrouter.ai/api/v1
`
    const result = parseSpeakBlock(input)
    expect(result).toEqual({
      voice: { base_url: "https://openrouter.ai/api/v1" },
    })
  })

  it("handles tab indentation", () => {
    const input = "speak:\n\tenabled: true\n\tvoice:\n\t\tprovider: say"
    const result = parseSpeakBlock(input)
    expect(result).toEqual({
      enabled: "true",
      voice: { provider: "say" },
    })
  })

  it("voice block between speak keys", () => {
    const input = `speak:
  enabled: true
  voice:
    provider: say
  process: false
`
    const result = parseSpeakBlock(input)
    expect(result).toEqual({
      enabled: "true",
      process: "false",
      voice: { provider: "say" },
    })
  })

  it("only-enabled override", () => {
    const input = `speak:
  enabled: true
`
    const result = parseSpeakBlock(input)
    expect(result).toEqual({ enabled: "true" })
  })
})
