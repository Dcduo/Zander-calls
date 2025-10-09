import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const VOICE          = process.env.VOICE || "verse";
const TONE_TEST = (process.env.TONE_TEST || "").toLowerCase() === "true";
const ECHO_TEST = (process.env.ECHO_TEST || "").toLowerCase() === "true";

const INSTRUCTIONS = `You are Zander from MachineTrade, calling for Martin at MJ Woodworking. Warm, brief, conversational. Collect budget, location/postcode, intended use. Answer simple spec questions; if unsure, promise quick follow-up. No transfers. Close with a clear next step.`;

const bytesToB64 = b => Buffer.from(b).toString("base64");
const b64ToBytes = b => Buffer.from(b, "base64");
const ULAW_SILENCE_20MS = new Uint8Array(160).fill(0xFF);

// simple μ-law encoder for test tone
function ulawEncode(pcm) {
  const BIAS = 0x84;
  let sign = (pcm >> 8) & 0x80;
  if (sign !== 0) pcm = -pcm;
  pcm = pcm + BIAS; if (pcm > 32635) pcm = 32635;
  let exponent = 7, expMask;
  for (expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);
  const mantissa = (pcm >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let ulaw = ~(sign | (exponent << 4) | mantissa);
  return ulaw & 0xFF;
}
function genToneUlaw(ms=1500, freq=440, sr=8000) {
  const total = Math.floor(sr * ms / 1000);
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const s = Math.sin(2 * Math.PI * freq * (i / sr));
    const pcm = (s * 30000) | 0;
    out[i] = ulawEncode(pcm);
  }
  return out;
}

// μ-law decode + linear 8k→16k upsample (for OpenAI input)
function ulawDecode(sample){ sample=~sample&255; let t=((sample&0x0F)<<3)+0x84; t<<=((sample&0x70)>>>4); return ((sample&0x80)?(0x84-t):(t-0x84)); }
function muLawToPCM16(buf){ const o=new Int16Array(buf.length); for(let i=0;i<buf.length;i++) o[i]=ulawDecode(buf[i]); return o; }
function linearResamplePCM16(a,fi,fo){ if(fi===fo)return a; const r=fo/fi, o=new Int16Array(Math.floor(a.length*r));
  for(let i=0;i<o.length;i++){ const s=i/r, i0=Math.floor(s), i1=Math.min(i0+1,a.length-1), f=s-i0; o[i]=(a[i0]*(1-f)+a[i1]*f)|0; } return o; }

// TwiML (kept for quick sanity checks—won’t be used when you point number at TwiML Bin)
const server = http.createServer((req,res)=>{
  if (req.url.startsWith("/twiml")) {
    res.writeHead(200, {"content-type":"text/xml"});
    const host = req.headers.host;
    res.end(`
<Response>
  <Connect>
    <Stream url="wss://${host}/ws/twilio"/>
  </Connect>
</Response>`.trim());
    return;
  }
  res.writeHead(200, {"content-type": "text/plain"}); res.end("OK");
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade",(req,sock,head)=>{
  if (req.url.startsWith("/ws/twilio")) wss.handleUpgrade(req,sock,head,ws=>handleTwilio(ws));
  else sock.destroy();
});
server.listen(PORT,()=>console.log(`Bridge listening on :${PORT}`));

async function connectOpenAI(){
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const headers = {"Authorization":`Bearer ${OPENAI_API_KEY}`,"OpenAI-Beta":"realtime=v1"};
  return new Promise((resolve,reject)=>{
    const ws = new WebSocket(url, "realtime", { headers });
    ws.on("open", ()=>{ console.log("OpenAI WS connected"); resolve(ws); });
    ws.on("error",(e)=> reject(e));
  });
}

// send μ-law to Twilio as 20 ms (160B) frames — NOTE: no `track` field for Connect/Stream
function sendUlawFrames(wsTwilio, streamSid, ulawBytes, label="ulaw"){
  let frames=0;
  for (let i=0; i+160<=ulawBytes.length; i+=160) {
    const frame = ulawBytes.subarray(i, i+160);
    wsTwilio.send(JSON.stringify({ event:"media", streamSid, media:{ payload: bytesToB64(frame) } }));
    frames++;
  }
  if (frames) console.log(`▶ sent ${frames} ${label} frames`);
}

function handleTwilio(wsTwilio){
  console.log("Twilio stream connected");
  let streamSid=null, openaiWS=null;
  let keepalive=null, silencePump=null;
  let sessionReady=false;

  wsTwilio.on("message", async (msg)=>{
    let data; try { data = JSON.parse(msg.toString("utf8")); } catch { return; }
    const ev = data.event;

    // For <Connect><Stream>, Twilio can send "connected" first; then "start"
    if (ev === "connected" || ev === "start") {
      streamSid = data.streamSid || (data.start && data.start.streamSid) || streamSid;
      console.log(`Twilio ${ev}`, streamSid, `ECHO_TEST:${ECHO_TEST} TONE_TEST:${TONE_TEST}`);

      // keepalive marks
      keepalive = setInterval(()=> {
        try { wsTwilio?.send(JSON.stringify({ event:"mark", streamSid, name:"tick" })); } catch {}
      }, 15000);

      // send a brief tone or silence to prove outbound path immediately
      if (TONE_TEST) {
        const tone = genToneUlaw(1500, 440, 8000);
        sendUlawFrames(wsTwilio, streamSid, tone, "tone");
        return;
      } else {
        // light keepalive until real audio
        silencePump = setInterval(()=> sendUlawFrames(wsTwilio, streamSid, ULAW_SILENCE_20MS, "silence"), 250);
      }

      if (!ECHO_TEST) {
        // OpenAI path
        openaiWS = await connectOpenAI().catch(e=>console.log("OpenAI WS error", e?.message));
        if (!openaiWS) return;

        openaiWS.on("message",(raw)=>{
          let pkt; try { pkt = JSON.parse(raw.toString("utf8")); } catch { return; }
          if (pkt.type === "error") { console.log("OpenAI ERROR:", JSON.stringify(pkt, null, 2)); return; }
          if (pkt.type === "session.updated") { sessionReady = true; console.log("✔ Realtime session updated"); }
          if (pkt.type === "output_audio.delta" && pkt.delta) {
            const ulaw = b64ToBytes(pkt.delta);  // already μ-law
            if (silencePump) { clearInterval(silencePump); silencePump = null; }
            sendUlawFrames(wsTwilio, streamSid, ulaw, "openai");
          }
        });

        openaiWS.send(JSON.stringify({
          type:"session.update",
          session:{ voice:VOICE, instructions:INSTRUCTIONS, input_audio_format:"pcm16", output_audio_format:"g711_ulaw" }
        }));

        const greet = () => {
          if (!sessionReady) { setTimeout(greet, 80); return; }
          console.log("Sending initial greeting…");
          openaiWS.send(JSON.stringify({
            type:"response.create",
            response:{ modalities:["audio","text"], output_audio_format:"g711_ulaw",
              instructions:"Hi, it's Zander from MachineTrade calling for Martin at MJ Woodworking. Is now a quick time?"
            }
          }));
        };
        greet();
      }
    }

    if (ev === "media") {
      const ulaw = Buffer.from(data.media.payload, "base64");
      if (ECHO_TEST) {
        sendUlawFrames(wsTwilio, streamSid, ulaw, "echo");
      } else if (!TONE_TEST && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
        const pcm8 = muLawToPCM16(ulaw);
        const pcm16 = linearResamplePCM16(pcm8, 8000, 16000);
        const buf = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
        openaiWS.send(JSON.stringify({ type:"input_audio_buffer.append", audio: bytesToB64(buf) }));
      }
    }

    if (ev === "stop") {
      console.log("Twilio stop");
      wsTwilio.close();
    }
  });

  wsTwilio.on("close", ()=>{
    console.log("Twilio stream closed");
    clearInterval(keepalive);
    clearInterval(silencePump);
    try { openaiWS?.close(); } catch {}
  });
}
