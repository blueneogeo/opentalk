#!/usr/bin/env node
//
// Kokoro TTS server — standalone HTTP server for local text-to-speech.
// Uses kokoro-js (ONNX runtime) to generate speech audio.
// One process, model stays loaded between requests.
//
// Usage:  node kokoro-server.mjs [--port 8765]
// Test:   curl http://127.0.0.1:8765/health
// Speak:  curl -X POST http://127.0.0.1:8765/speak -H "Content-Type: application/json" -d '{"text":"hello","voice":"af_bella"}'
//

import { createServer } from "node:http"
import { KokoroTTS } from "kokoro-js"
import { join } from "node:path"
import { tmpdir } from "node:os"

const args = process.argv.slice(2)
const portIdx = args.indexOf("--port")
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 8765
if (!PORT || PORT < 1 || PORT > 65535) {
  console.error("Invalid port:", PORT)
  process.exit(1)
}
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX"

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data) + "\n")
}

async function main() {
  process.stderr.write(`Loading kokoro model (${MODEL_ID}, q8)...\n`)

  const model = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: "q8",
    device: "cpu",
  })

  process.stderr.write(`Model loaded. Starting server on port ${PORT}...\n`)

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        json(res, 200, { ok: true, model: "loaded" })
        return
      }

      if (req.method === "POST" && req.url === "/speak") {
        const body = await readBody(req)
        let payload
        try { payload = JSON.parse(body) } catch { json(res, 400, { error: "invalid json" }); return }

        const { text, voice } = payload
        if (!text || !voice) { json(res, 400, { error: "text and voice required" }); return }

        const audio = await model.generate(text, { voice })
        const outPath = join(tmpdir(), `kokoro-${Date.now()}.wav`)
        await audio.save(outPath)

        json(res, 200, { path: outPath, text: text.slice(0, 50), voice })
        return
      }

      json(res, 404, { error: "not found" })
    } catch (err) {
      json(res, 500, { error: err.message || "internal error" })
    }
  })

  process.on("SIGTERM", () => { server.close(); process.exit(0) })
  process.on("SIGINT", () => { server.close(); process.exit(0) })

  server.listen(PORT, "127.0.0.1", () => {
    process.stderr.write(`Kokoro server ready: http://127.0.0.1:${PORT}\n`)
  })
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`)
  process.exit(1)
})
