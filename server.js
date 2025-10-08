// server.js — Twilio Media Streams <-> OpenAI Realtime bridge + TwiML endpoint
// Node 20+, dependency: ws (npm i ws)

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // REQUIRED (project-scoped, long)
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const VOICE          = process.env.VOICE || "verse";

// ───────── Persona ─────────
const INSTRUCTIONS = `
You are **Zander** from **MachineTrade**, calling on behalf of **Martin** at **MJ Woodworking**.
Martin is busy today; you’re gathering quick details and answering immediate questions.
Be warm, brief, and genuinely conversational. Collect budget, location/postcode, and what the machine will be used to make.
Handle quick spec questions politely; if unsure, promise to get back. No transfers.
End with a clear next step (you'll pass info to Martin or arrange callback).
`;

// ───────── Tiny helpers ─────────
const bytesToB64 = b => Buffer.from(b).toString("base64");
const b64ToBytes = b => Buffer.from(b, "base64");

// Prebuilt μ-law “silence” frame (20 ms @ 8 kHz = 160 bytes of 0xFF)
const ULAW_SILENCE_20MS = new Uint8Array(160).fill(0xFF);

// ───────── HTTP: TwiML endpoint ─────────
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/twiml")) {
    res.writeHead(200, { "content-type": "text/xml" });
    const host = req.headers.host;
    res.end(`
<Response>
  <Start>
    <Stream url="wss://${host}/ws/twilio" track="both_tracks"/>
  </Start>
  <Pause length="3600"/>
</Response>`.trim());
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("OK");
});

// ───────── WS bridge (/ws/twilio) ─────────
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/ws/twilio")) {
    wss.handleUpgrade(req, socket, head, ws => handleTwilio(ws));
  } else {
    socket.destroy();
  }
});
server.listen(PORT, () => console.log(`Bridge listening on :${PORT}`));

async function connectOpenAI() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1"
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, "realtime", { headers });
    ws.on("open", () => { console.log("OpenAI WS connected"); resolve(ws); });
    ws.on("error", (e) => { console.log("OpenAI WS error", e?.message); reject(e); });
  });
}

function handleTwilio(wsTwilio) {
  console.log("Twilio stream connected");
  let streamSid = null;
  let openaiWS = null;
  let open = true;
  let keepaliveTimer = null;
  let silencePump = null;
  let gotFirstOpenAIAudio = false;
  let inResponse = false;

  const sendToTwilio = (ulawBytes) => {
    if (open && wsTwilio.readyState === WebSocket.OPEN) {
      wsTwilio.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: bytesToB64(ulawBytes) }
      }));
      console.log("🎧 Sending audio to Twilio", ulawBytes.length, "bytes");
    }
  };

  wsTwilio.on("message", async (msg) => {
    let data; try { data = JSON.parse(msg.toString("utf8")); } catch { return; }
    const event = data.event;

    if (event === "start") {
      streamSid = data.start.streamSid;
      console.log("Twilio start", streamSid, "tracks:", data.start.tracks);

      openaiWS = await connectOpenAI();

      // Keep sockets warm
      keepaliveTimer = setInterval(() => {
        try { openaiWS?.ping?.(); } catch {}
        try { wsTwilio?.send(JSON.stringify({ event: "mark", streamSid, name: "tick" })); } catch {}
      }, 15000);

      // Tell Realtime to accept PCM16 in, and emit μ-law out (so we can pass straight to Twilio)
      openaiWS.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: VOICE,
          instructions: INSTRUCTIONS,
          input_audio_format:  "pcm16",
          output_audio_format: "g711_ulaw"
        }
      }));

      // Start μ-law “silence” pump so Twilio doesn’t hang up before first audio
      if (!silencePump) {
        silencePump = setInterval(() => sendToTwilio(ULAW_SILENCE_20MS), 40); // ~25 fps
      }

      // Handle OpenAI messages
      openaiWS.on("message", (raw) => {
        let pkt; try { pkt = JSON.parse(raw.toString("utf8")); } catch { return; }

        if (pkt.type === "error") {
          console.log("OpenAI ERROR:", JSON.stringify(pkt, null, 2));
          return;
        }

        if (pkt.type === "response.started") inResponse = true;
        if (pkt.type === "response.completed" || pkt.type === "response.failed") inResponse = false;

        if (pkt.type === "response.output_text.delta" && pkt.delta) {
          console.log("🗣 Zander:", pkt.delta);
        }
        if (pkt.type === "input_text" && pkt.text) {
          console.log("👤 Caller:", pkt.text);
        }

        // When output format is g711_ulaw, the delta is μ-law bytes (base64). Send as-is.
        if (pkt.type === "output_audio.delta" && pkt.delta) {
          if (!gotFirstOpenAIAudio) {
            gotFirstOpenAIAudio = true;
            if (silencePump) { clearInterval(silencePump); silencePump = null; }
            console.log("✔ OpenAI audio started");
          }
          const ulawBytes = b64ToBytes(pkt.delta); // already μ-law @ 8kHz
          sendToTwilio(ulawBytes);
        }
      });

      openaiWS.on("close", (c, r) => console.log("OpenAI WS closed", c, r?.toString?.()));

      // Send greeting (don’t overlap responses)
      setTimeout(() => {
        console.log("Sending initial greeting...");
        inResponse = true;
        openaiWS.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: "Hi, it's Zander from MachineTrade calling for Martin at MJ Woodworking. Is now a quick time?"
          }
        }));
      }, 120);
    }

    if (event === "media" && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      // Caller audio arrives as μ-law 8k in Media Streams.
      // Realtime expects PCM16 16k for input → we’ll upsample later if needed,
      // but since we told it input is 'pcm16', we must send PCM16.
      // Minimal, workable approach: decode μ-law → PCM16 (8k) → naive 2x upsample to 16k.
      const ulaw = Buffer.from(data.media.payload, "base64");
      // μ-law decode (8k) → PCM16
      const pcm16_8k = muLawToPCM16(ulaw);
      // Simple linear upsample 8k → 16k
      const pcm16_16k = linearResamplePCM16(pcm16_8k, 8000, 16000);
      // Encode the Int16 view only
      const view = Buffer.from(pcm16_16k.buffer, pcm16_16k.byteOffset, pcm16_16k.byteLength);
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToB64(view) }));
    }

    if (event === "stop") {
      console.log("Twilio stop");
      wsTwilio.close();
    }
  });

  wsTwilio.on("close", () => {
    open = false;
    console.log("Twilio stream closed");
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (silencePump)   { clearInterval(silencePump);   silencePump = null; }
    try { openaiWS?.close(); } catch {}
  });
}

/* -------- μ-law decode + 8k→16k resample helpers -------- */

const MULAW_MAX = 0x1FFF, SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_SHIFT = 4, SEG_MASK = 0x70;
function ulawDecode(sample) {
  sample = ~sample & 0xFF;
  let t = ((sample & QUANT_MASK) << 3) + 0x84;
  t <<= ((sample & SEG_MASK) >>> SEG_SHIFT);
  return ((sample & SIGN_BIT) ? (0x84 - t) : (t - 0x84));
}
function muLawToPCM16(ulawBytes) {
  const out = new Int16Array(ulawBytes.length);
  for (let i = 0; i < ulawBytes.length; i++) out[i] = ulawDecode(ulawBytes[i]);
  return out;
}
// Simple linear resampler (good enough for telephony)
function linearResamplePCM16(int16In, inRate, outRate) {
  if (inRate === outRate) return int16In;
  const ratio = outRate / inRate;
  const outLen = Math.floor(int16In.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIndex = i / ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, int16In.length - 1);
    const f = srcIndex - i0;
    out[i] = (int16In[i0] * (1 - f) + int16In[i1] * f) | 0;
  }
  return out;
}
