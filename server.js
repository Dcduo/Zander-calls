// Minimal Twilio Media Streams ↔ OpenAI Realtime bridge
// Node 20+, no native deps. Good for a first working demo.
// For production audio quality, swap the naive resampler with a high-quality one.

import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

// ---------- ENV ----------
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // project-scoped key (long)
const OPENAI_MODEL  = process.env.OPENAI_MODEL  || "gpt-4o-realtime-preview";
const VOICE         = process.env.VOICE         || "verse";

// Persona/instructions (edit to taste)
const INSTRUCTIONS = `
You are **Zander** from **MachineTrade**, calling on behalf of **Martin** at **MJ Woodworking**.
Purpose: Martin is flat-out today; you're gathering quick details and answering immediate questions.

Style: warm, brief, truly conversational. Allow interruptions.
Collect (adapt order; skip if already covered):
• Budget (rough range)
• Location / delivery postcode
• Intended use: what they’ll make; materials, sizes, throughput; special requirements
• Immediate questions about specs (power, capacity, materials, throughput, warranty). If unsure, promise a quick follow-up.

Confirm key details back; gently steer if off track.
No transfers. Close with a clear next step (you’ll pass notes to Martin / arrange callback / send quote outline).
`;

// ---------- μ-law codec helpers ----------
const MULAW_MAX = 0x1FFF;
const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0F;
const SEG_SHIFT = 4;
const SEG_MASK = 0x70;
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
function linearResamplePCM16(int16In, inRate, outRate) {
  if (inRate === outRate) return int16In;
  const ratio = outRate / inRate;
  const outLen = Math.floor(int16In.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIndex = i / ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, int16In.length - 1);
    const frac = srcIndex - i0;
    out[i] = (int16In[i0] * (1 - frac) + int16In[i1] * frac) | 0;
  }
  return out;
}
// Simple PCM16 → μ-law (fast; not hi-fi but fine for telephony)
function pcm16ToMuLaw(int16) {
  const out = new Uint8Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    let s = int16[i];
    let sign = (s >> 8) & 0x80;
    if (sign !== 0) s = -s;
    if (s > MULAW_MAX) s = MULAW_MAX;
    s = s + 0x84;
    let exponent = 7;
    for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
    let mantissa = (s >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }
  return out;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("OK");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const { url } = req;
  if (url.startsWith("/ws/twilio")) {
    wss.handleUpgrade(req, socket, head, (wsTwilio) => handleTwilio(wsTwilio));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Bridge listening on :${PORT}`);
});

function base64ToBytes(b64) {
  return Buffer.from(b64, "base64");
}
function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function handleTwilio(wsTwilio) {
  console.log("Twilio stream connected");
  let streamSid = null;
  let openaiWS = null;
  let open = true;

  async function connectOpenAI() {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
    const headers = {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
      // subprotocol is recommended by OpenAI; some WS libs set it differently
      "Sec-WebSocket-Protocol": "realtime"
    };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, "realtime", { headers });
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function sendToTwilioMedia(mutlawBytes) {
    if (!open || !wsTwilio || wsTwilio.readyState !== WebSocket.OPEN) return;
    wsTwilio.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: bytesToBase64(mutlawBytes) }
    }));
  }

  wsTwilio.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString("utf8"));
      const event = data.event;

      if (event === "start") {
        streamSid = data.start.streamSid;
        console.log("Twilio start", streamSid);

        // Connect to OpenAI and configure the session
        openaiWS = await connectOpenAI();

        openaiWS.on("message", (raw) => {
          // Messages from OpenAI
          let packet;
          try { packet = JSON.parse(raw.toString("utf8")); } catch { return; }

          // 1) Audio deltas (base64 PCM16 16k)
          if (packet.type === "output_audio.delta" && packet.delta) {
            const pcm16_16k = new Int16Array(Buffer.from(packet.delta, "base64").buffer);
            const pcm16_8k = linearResamplePCM16(pcm16_16k, 16000, 8000);
            const ulaw8k = pcm16ToMuLaw(pcm16_8k);
            sendToTwilioMedia(ulaw8k);
          }

          // When a response finishes, you could append more instructions or start the next turn
        });

        openaiWS.on("close", () => console.log("OpenAI WS closed"));

        // Prime the session: voice + instructions
        const sessionUpdate = {
          type: "session.update",
          session: { voice: VOICE, instructions: INSTRUCTIONS }
        };
        openaiWS.send(JSON.stringify(sessionUpdate));

        // Force immediate greeting (so caller hears audio right away)
        openaiWS.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio"], instructions: "Hi, it's Zander from MachineTrade calling for Martin at MJ Woodworking. Is now a quick time?" }
        }));
      }

      // Media from Twilio (8k μ-law)
      if (event === "media" && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
        const ulawBytes = base64ToBytes(data.media.payload);
        const pcm16_8k = muLawToPCM16(ulawBytes);
        const pcm16_16k = linearResamplePCM16(pcm16_8k, 8000, 16000);

        // Send to OpenAI input buffer
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: bytesToBase64(Buffer.from(pcm16_16k.buffer))
        }));
      }

      // Twilio marks end of chunk; tell OpenAI to process
      if (event === "mark" || event === "stop" || event === "dtmf") {
        if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
        }
      }

      if (event === "stop") {
        console.log("Twilio stop");
        wsTwilio.close();
      }
    } catch (e) {
      console.error("Twilio msg error", e);
    }
  });

  wsTwilio.on("close", () => {
    open = false;
    console.log("Twilio stream closed");
    try { openaiWS?.close(); } catch {}
  });
}
