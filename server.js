// server.js — Twilio Media Streams <-> OpenAI Realtime bridge + TwiML endpoint
// Adds: detailed logging, OpenAI message dump, 100ms delay before first speak,
// periodic commits, WS keepalives.

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const VOICE          = process.env.VOICE || "verse";

const INSTRUCTIONS = `
You are **Zander** from **MachineTrade**, calling on behalf of **Martin** at **MJ Woodworking**.
Purpose: Martin is flat-out today; you're gathering quick details and answering immediate questions.
Style: warm, brief, conversational. Collect budget, location, intended use, and handle quick spec questions.
No transfers. Close with a clear next step (you’ll pass notes to Martin / arrange callback / send quote outline).
`;

// ---- μ-law helpers ----
const MULAW_MAX = 0x1FFF, SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_SHIFT = 4, SEG_MASK = 0x70;
function ulawDecode(sample){sample=~sample&0xFF;let t=((sample&QUANT_MASK)<<3)+0x84;t<<=((sample&SEG_MASK)>>>SEG_SHIFT);return((sample&SIGN_BIT)?(0x84-t):(t-0x84))}
function muLawToPCM16(ulaw){const out=new Int16Array(ulaw.length);for(let i=0;i<ulaw.length;i++)out[i]=ulawDecode(ulaw[i]);return out}
function linearResamplePCM16(int16,inRate,outRate){
  if(inRate===outRate) return int16;
  const ratio = outRate/inRate, outLen = Math.floor(int16.length*ratio), out = new Int16Array(outLen);
  for (let i=0;i<outLen;i++){const src=i/ratio, i0=Math.floor(src), i1=Math.min(i0+1,int16.length-1), f=src-i0; out[i]=(int16[i0]*(1-f)+int16[i1]*f)|0;}
  return out;
}
function pcm16ToMuLaw(int16){
  const out = new Uint8Array(int16.length);
  for (let i=0;i<int16.length;i++){
    let s=int16[i], sign=(s>>8)&0x80; if(sign) s=-s; if(s>MULAW_MAX) s=MULAW_MAX; s+=0x84;
    let exponent=7; for(let m=0x4000;(s&m)===0 && exponent>0; m>>=1) exponent--;
    const mantissa=(s>>((exponent===0)?4:(exponent+3)))&0x0F;
    out[i]=~(sign|(exponent<<4)|mantissa)&0xFF;
  }
  return out;
}
const b64ToBytes = b64 => Buffer.from(b64, "base64");
const bytesToB64 = bytes => Buffer.from(bytes).toString("base64");

// ---- HTTP: TwiML endpoint ----
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

// ---- WS bridge: /ws/twilio ----
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

  let framesSinceCommit = 0;
  const COMMIT_EVERY_FRAMES = 5; // ~100ms (5 x 20ms)
  let keepaliveTimer = null;

  function sendToTwilio(mutlaw) {
    if (!open || wsTwilio.readyState !== WebSocket.OPEN) return;
    wsTwilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: bytesToB64(mutlaw) }}));
  }

  wsTwilio.on("message", async (msg) => {
    const txt = msg.toString("utf8");
    let data; try { data = JSON.parse(txt); } catch { return; }
    const event = data.event;

    if (event === "connected") {
      console.log("Twilio event: connected");
    }

    if (event === "start") {
      streamSid = data.start.streamSid;
      console.log("Twilio start", streamSid, "tracks:", data.start.tracks);

      // OpenAI connect
      openaiWS = await connectOpenAI();

      // Keepalive (avoid idle closes)
      keepaliveTimer = setInterval(() => {
        try { openaiWS?.ping?.(); } catch {}
        try { wsTwilio?.send(JSON.stringify({ event: "mark", streamSid, name: "tick" })); } catch {}
      }, 15000);

      // Log ALL messages from OpenAI so we can see what's happening
      openaiWS.on("message", (raw) => {
        let pkt; try { pkt = JSON.parse(raw.toString("utf8")); } catch { return; }
        if (pkt.type === "output_audio.delta") {
          const samples = Buffer.from(pkt.delta, "base64").length / 2; // 2 bytes per int16
          const pcm16_16k = new Int16Array(Buffer.from(pkt.delta, "base64").buffer);
          const pcm16_8k  = linearResamplePCM16(pcm16_16k, 16000, 8000);
          const ulaw8k    = pcm16ToMuLaw(pcm16_8k);
          sendToTwilio(ulaw8k);
          console.log(`OpenAI → audio delta: ${samples} samples, sent ${ulaw8k.length} ulaw`);
        } else {
          // helpful for debugging: see interim transcripts, statuses, errors
          console.log("OpenAI msg:", pkt.type);
        }
      });

      openaiWS.on("close", (c, r) => console.log("OpenAI WS closed", c, r?.toString?.()));

      // Configure the session
      openaiWS.send(JSON.stringify({ type: "session.update", session: { voice: VOICE, instructions: INSTRUCTIONS }}));

      // Small delay helps some hosts avoid immediate stop before first audio frame
      setTimeout(() => {
        console.log("Sending initial greeting...");
        openaiWS.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio"], instructions: "Hi, it's Zander from MachineTrade calling for Martin at MJ Woodworking. Is now a quick time?" }
        }));
      }, 100); // 100ms
    }

    if (event === "media" && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      const ulawBytes = b64ToBytes(data.media.payload);
      const pcm16_8k  = muLawToPCM16(ulawBytes);
      const pcm16_16k = linearResamplePCM16(pcm16_8k, 8000, 16000);

      openaiWS.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: bytesToB64(Buffer.from(pcm16_16k.buffer))
      }));
      framesSinceCommit++;
      if (framesSinceCommit >= COMMIT_EVERY_FRAMES) {
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] }}));
        framesSinceCommit = 0;
      }
    }

    if (event === "stop") {
      console.log("Twilio stop");
      try { openaiWS?.send(JSON.stringify({ type: "input_audio_buffer.commit" })); } catch {}
      wsTwilio.close();
    }
  });

  wsTwilio.on("close", () => {
    open = false;
    console.log("Twilio stream closed");
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    try { openaiWS?.close(); } catch {}
  });
}
