// server.js — Twilio Media Streams <-> OpenAI Realtime bridge + TwiML endpoint
// Node 20+, dependency: ws (npm i ws)

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// ──────────── ENV ────────────
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // REQUIRED (project-scoped, long)
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const VOICE          = process.env.VOICE || "verse";

// ──────────── Persona ────────────
const INSTRUCTIONS = `
You are **Zander** from **MachineTrade**, calling on behalf of **Martin** at **MJ Woodworking**.
Purpose: Martin is flat-out today; you're gathering quick details and answering immediate questions.
Style: warm, brief, truly conversational. Allow interruptions and acknowledge them.
Collect (adapt order; skip if covered):
• Budget (rough range)
• Location / delivery postcode
• Intended use: what they'll make; materials, sizes, throughput; special requirements
• Quick spec questions (power, capacity, compatible materials, throughput, warranty). If unsure, promise a quick follow-up.
Confirm key details back; gently steer if off track. No transfers.
Close with a clear next step (you'll pass notes to Martin / arrange callback / send quote outline).
`;

// ──────────── μ-law helpers ────────────
const MULAW_MAX = 0x1FFF, SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_SHIFT = 4, SEG_MASK = 0x70;
function ulawDecode(sample){sample=~sample&0xFF;let t=((sample&QUANT_MASK)<<3)+0x84;t<<=((sample&SEG_MASK)>>>SEG_SHIFT);return((sample&SIGN_BIT)?(0x84-t):(t-0x84))}
function muLawToPCM16(ulaw){const out=new Int16Array(ulaw.length);for(let i=0;i<ulaw.length;i++)out[i]=ulawDecode(ulaw[i]);return out}
function linearResamplePCM16(int16,inRate,outRate){
  if(inRate===outRate) return int16;
  const ratio = outRate/inRate, outLen = Math.floor(int16.length*ratio), out = new Int16Array(outLen);
  for (let i=0;i<outLen;i++){
    const src=i/ratio, i0=Math.floor(src), i1=Math.min(i0+1,int16.length-1), f=src-i0;
    out[i]=(int16[i0]*(1-f)+int16[i1]*f)|0;
  }
  return out;
}
function pcm16ToMuLaw(int16){
  const out = new Uint8Array(int16.length);
  for (let i=0;i<int16.length;i++){
    let s=int16[i], sign=(s>>8)&0x80; if(sign) s=-s;
    if (s>MULAW_MAX) s=MULAW_MAX; s+=0x84;
    let exponent=7; for(let m=0x4000;(s&m)===0 && exponent>0; m>>=1) exponent--;
    const mantissa=(s>>((exponent===0)?4:(exponent+3)))&0x0F;
    out[i]=~(sign|(exponent<<4)|mantissa)&0xFF;
  }
  return out;
}
const b64ToBytes = b64 => Buffer.from(b64, "base64");
const bytesToB64 = bytes => Buffer.from(bytes).toString("base64");

// ──────────── HTTP (serves TwiML) ────────────
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

// ──────────── WebSocket bridge (/ws/twilio) ────────────
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/ws/twilio")) {
    wss.handleUpgrade(req, socket, head, ws => handleTwilio(ws));
  } else {
    socket.destroy();
  }
});
server.listen(PORT, () => console.log(`Bridge listening on :${PORT}`));

// ──────────── Helpers ────────────
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

// ──────────── Core bridge ────────────
function handleTwilio(wsTwilio) {
  console.log("Twilio stream connected");
  let streamSid = null;
  let openaiWS = null;
  let open = true;
  let framesSinceCommit = 0;
  const COMMIT_EVERY_FRAMES = 20; // ~400ms
  let keepaliveTimer = null;

  function sendToTwilio(mutlaw) {
    if (!open || wsTwilio.readyState !== WebSocket.OPEN) return;
    wsTwilio.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: bytesToB64(mutlaw) }
    }));
  }

  wsTwilio.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString("utf8")); } catch { return; }
    const event = data.event;

    if (event === "connected") console.log("Twilio event: connected");

    if (event === "start") {
      streamSid = data.start.streamSid;
      console.log("Twilio start", streamSid, "tracks:", data.start.tracks);

      openaiWS = await connectOpenAI();

      // Keepalive
      keepaliveTimer = setInterval(() => {
        try { openaiWS?.ping?.(); } catch {}
        try { wsTwilio?.send(JSON.stringify({ event: "mark", streamSid, name: "tick" })); } catch {}
      }, 15000);

      // Handle OpenAI messages
      openaiWS.on("message", (raw) => {
        let pkt; try { pkt = JSON.parse(raw.toString("utf8")); } catch { return; }

        if (pkt.type === "error" || pkt.type?.endsWith?.(".error")) {
          console.log("OpenAI ERROR:", JSON.stringify(pkt, null, 2));
          return;
        }

        // 🗣 transcripts
        if (pkt.type === "response.output_text.delta" && pkt.delta) {
          console.log("🗣 Zander:", pkt.delta);
        }
        if (pkt.type === "input_text" && pkt.text) {
          console.log("👤 Caller:", pkt.text);
        }

        // audio deltas
        if (pkt.type === "output_audio.delta" && pkt.delta) {
          const b = Buffer.from(pkt.delta, "base64");
          const pcm16_16k = new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
          const pcm16_8k  = linearResamplePCM16(pcm16_16k, 16000, 8000);
          const ulaw8k    = pcm16ToMuLaw(pcm16_8k);
          sendToTwilio(ulaw8k);
          return;
        }

        console.log("OpenAI msg:", pkt.type);
      });

      openaiWS.on("close", (c, r) => console.log("OpenAI WS closed", c, r?.toString?.()));

      // Configure the session
      openaiWS.send(JSON.stringify({
        type: "session.update",
        session: { voice: VOICE, instructions: INSTRUCTIONS }
      }));

      // Small delay before first greeting
      setTimeout(() => {
        console.log("Sending initial greeting...");
        openaiWS.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: "Hi, it's Zander from MachineTrade calling for Martin at MJ Woodworking. Is now a quick time?"
          }
        }));
      }, 200);
    }

    // Incoming caller audio
    if (event === "media" && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      const ulawBytes = b64ToBytes(data.media.payload);
      const pcm16_8k  = muLawToPCM16(ulawBytes);
      const pcm16_16k = linearResamplePCM16(pcm16_8k, 8000, 16000);

      const viewBuf = Buffer.from(pcm16_16k.buffer, pcm16_16k.byteOffset, pcm16_16k.byteLength);
      openaiWS.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: bytesToB64(viewBuf)
      }));

      framesSinceCommit++;
      if (framesSinceCommit >= COMMIT_EVERY_FRAMES) {
        framesSinceCommit = 0;
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio", "text"] }
        }));
      }
    }

    if (event === "stop" || event === "dtmf") {
      if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio", "text"] }
        }));
      }
      if (event === "stop") {
        console.log("Twilio stop");
        wsTwilio.close();
      }
    }
  });

  wsTwilio.on("close", () => {
    open = false;
    console.log("Twilio stream closed");
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    try { openaiWS?.close(); } catch {}
  });
}
