// Minimal TTS voice service — Edge TTS (Microsoft) + Kokoro (local ONNX), each
// generating audio AND converting it to the formats our call engine uses:
// MP3 / WAV (browser-playable) and raw 8 kHz 16-bit mono PCM (engine format).
//
//   npm install
//   npm start                 # -> :3000
//
//   POST /tts/edge            { text, voice? }  -> audio/mpeg          (Edge MP3)
//   POST /tts/edge/raw        { text, voice? }  -> audio/pcm           (Edge -> 8kHz PCM)
//   POST /tts/kokoro          { text, voice? }  -> audio/wav           (Kokoro WAV, 24kHz)
//   POST /tts/kokoro/raw      { text, voice? }  -> audio/pcm           (Kokoro -> 8kHz PCM)
//   GET  /health                                  -> { ok: true }
import http from "node:http";
import { EdgeTTS } from "edge-tts-universal";
import { KokoroTTS } from "kokoro-js";
import { MPEGDecoder } from "mpg123-decoder";
import samplerate from "@alexanderolsen/libsamplerate-js";

const PORT = process.env.PORT || 3000;
let kokoro = null;      // Kokoro model (lazy, loaded once)
let mp3Decoder = null;  // mpg123 decoder (lazy)

// ──────────────────────────────────────────────────────────────────────────────
// 1) GENERATE — two engines
// ──────────────────────────────────────────────────────────────────────────────

// Edge TTS (Microsoft cloud) -> 24 kHz audio as an ArrayBuffer (MP3 bytes).
async function edgeTts(text, voice) {
  const tts = new EdgeTTS(String(text || "").trim(), voice || "en-US-AriaNeural", {});
  const result = await tts.synthesize();
  return Buffer.from(await result.audio.arrayBuffer());
}

// Kokoro (local model) -> Float32Array at native 24 kHz.
async function kokoroTts(text, voice) {
  if (!kokoro) {
    kokoro = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      { dtype: "q8", device: "cpu" },
    );
  }
  const a = await kokoro.generate(String(text || "").trim(), { voice: voice || "af_heart" });
  return { samples: a.audio, rate: a.sampling_rate || 24000 };
}

// ──────────────────────────────────────────────────────────────────────────────
// 2) CONVERT — to the formats our engine plays
// ──────────────────────────────────────────────────────────────────────────────

// Float32Array -> 16-bit signed PCM bytes.
function float32ToPcm16(float32) {
  const pcm = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, i * 2);
  }
  return pcm;
}

// Decode an Edge MP3 and resample to 8 kHz 16-bit mono PCM — this is the exact
// raw format the outbound engine streams for notification_file_url.
async function mp3ToPcm8k(mp3Buffer) {
  if (!mp3Decoder) {
    mp3Decoder = new MPEGDecoder();
    await mp3Decoder.ready;
  }
  const { channelData, sampleRate } = mp3Decoder.decode(new Uint8Array(mp3Buffer));
  const left = channelData[0] || new Float32Array(0);
  const resampler = await samplerate.create(1, sampleRate, 8000);
  const downsampled = resampler.full(left); // 24k -> 8k Float32
  return float32ToPcm16(downsampled);
}

// Simple linear resample (Kokoro's 24 kHz -> 8 kHz). Good enough for our use.
function linearResample(samples, srcRate, dstRate) {
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

// Wrap raw PCM in a WAV header so browsers can play it.
function wrapWav(pcm, sampleRate) {
  const dataSize = pcm.length;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataSize, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);            // PCM
  h.writeUInt16LE(1, 22);            // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataSize, 40);
  return Buffer.concat([h, pcm]);
}

// ──────────────────────────────────────────────────────────────────────────────
// 3) HTTP
// ──────────────────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}

async function handleTts(req, res, synth, contentType) {
  const body = await readBody(req);
  const audio = await synth(body.text, body.voice);
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": audio.length });
  res.end(audio);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");

    // Edge: MP3, and raw 8 kHz PCM (the engine format)
    if (req.method === "POST" && url.pathname === "/tts/edge") {
      return handleTts(req, res, (t, v) => edgeTts(t, v), "audio/mpeg");
    }
    if (req.method === "POST" && url.pathname === "/tts/edge/raw") {
      return handleTts(req, res, async (t, v) => mp3ToPcm8k(await edgeTts(t, v)), "audio/pcm");
    }

    // Kokoro: WAV (24 kHz, playable), and raw 8 kHz PCM (the engine format)
    if (req.method === "POST" && url.pathname === "/tts/kokoro") {
      return handleTts(req, res, async (t, v) => {
        const { samples } = await kokoroTts(t, v);
        return wrapWav(float32ToPcm16(samples), 24000);
      }, "audio/wav");
    }
    if (req.method === "POST" && url.pathname === "/tts/kokoro/raw") {
      return handleTts(req, res, async (t, v) => {
        const { samples } = await kokoroTts(t, v);
        return float32ToPcm16(linearResample(samples, 24000, 8000));
      }, "audio/pcm");
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, service: "tts", edge: "ready", kokoro: kokoro ? "ready" : "idle" }));
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`TTS voice service listening on :${PORT}`));