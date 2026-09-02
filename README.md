# callremind-edgetts-backend

Minimal TTS voice service: **Edge TTS** (Microsoft) and **Kokoro** (local ONNX) in one tiny Node server.

## Run

```bash
npm install
npm start            # listens on :3000
```

## Endpoints

| Method | Path              | Body                    | Returns      |
|--------|-------------------|-------------------------|--------------|
| GET    | `/health`          | —                       | JSON status  |
| POST   | `/tts/edge`        | `{ "text", "voice"? }`  | `audio/mpeg` (MP3) |
| POST   | `/tts/edge/raw`    | `{ "text", "voice"? }`  | `audio/pcm` (Edge → 8 kHz 16-bit mono PCM) |
| POST   | `/tts/kokoro`      | `{ "text", "voice"? }`  | `audio/wav` (Kokoro, 24 kHz playable) |
| POST   | `/tts/kokoro/raw`  | `{ "text", "voice"? }`  | `audio/pcm` (Kokoro → 8 kHz PCM) |

Default voice — Edge: `en-US-AriaNeural`, Kokoro: `af_heart`.

`/raw` endpoints return the **exact raw format the CallRemind engine streams**
for `notification_file_url` (8 kHz, 16-bit, mono, little-endian PCM) — that's the
decode + resample step: Edge MP3 → MPEG-decoder → libsamplerate; Kokoro 24 kHz → linear downsample.

## Try it

```bash
# Edge TTS -> MP3
curl -X POST http://localhost:3000/tts/edge -H 'content-type: application/json' \
  -d '{"text":"Hello from Edge TTS"}' -o edge.mp3

# Edge TTS -> raw 8 kHz PCM (engine format)
curl -X POST http://localhost:3000/tts/edge/raw -H 'content-type: application/json' \
  -d '{"text":"Hello from Edge TTS"}' -o edge.raw

# Kokoro -> WAV
curl -X POST http://localhost:3000/tts/kokoro -H 'content-type: application/json' \
  -d '{"text":"Hello from Kokoro","voice":"am_adam"}' -o kokoro.wav

# Kokoro -> raw 8 kHz PCM (engine format)
curl -X POST http://localhost:3000/tts/kokoro/raw -H 'content-type: application/json' \
  -d '{"text":"Hello from Kokoro","voice":"am_adam"}' -o kokoro.raw
```

Notes:
- First Kokoro call downloads the ONNX model (~300 MB) + warms up; afterwards it's fast.
- Edge TTS is a Microsoft cloud endpoint (needs internet); Kokoro runs 100% locally on CPU.