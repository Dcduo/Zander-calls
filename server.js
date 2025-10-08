import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const VOICE          = process.env.VOICE || "verse";
const ECHO_TEST      = (process.env.ECHO_TEST || "").toLowerCase() === "true";

const INSTRUCTIONS = `
You are Zander from MachineTrade, calling for Martin at MJ Woodworking.
Keep it warm, brief and conversational. Gather budget, location, intended use.
Answer simple spec questions; if unsure, promise a quick follow-up. No transfers.
Close with next steps (pass notes to Martin / arrange callback / send quote outline).
`;

const bytesToB64 = b => Buffer.from(b).toString("base64");
const b64ToBytes = b => Buffer.from(b, "base64");

// μ-law helpers (8k) + simple 8k→16k resample for OpenAI input
const MULAW_MAX=0x1FFF,SIGN_BIT=0x80,QUANT_MASK=0x0F,SEG_SHIFT=4,SEG_MASK=0x70;
function ulawDecode(s){s=~s&255;let t=((s&QUANT_MASK)<<3)+132;t<<=((s&SEG_MASK)>>>SEG_SHIFT);return(s&SIGN_BIT)?(132-t):(t-132)}
function muLawToPCM16(b){const o=new Int16Array(b.length);for(let i=0;i<b.length;i++)o[i]=ulawDecode(b[i]);return o}
function linearResamplePCM16(a,fi,fo){if(fi===fo)return a;const r=fo/fi,o=new Int16Array(Math.floor(a.length*r));for(let i=0;i<o.length;i++){const s=i/r,i0=Math.floor(s),i1=Math.min(i0+1,a.length-1),f=s-i0;o[i]=(a[i0]*(1-f)+a[i1]*f)|0;}return o}

// 20 ms μ-law silence (160 bytes)
const ULAW_SILENCE_20MS = new Uint8Array(160).fill(0xFF);

const server = http.createServer((req,res)=>{
  if(req.url.startsWith("/twiml")){
    res.writeHead(200,{"content-type":"text/xml"});
    const host=req.headers.host;
    res.end(`
<Response>
  <Start>
    <Stream url="wss://${host}/ws/twilio" track="both_tracks"/>
  </Start>
  <Pause length="3600"/>
</Response>`.trim());
    return;
  }
  res.writeHead(200,{"content-type":"text/plain"});res.end("OK");
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade",(req,sock,head)=>{
  if(req.url.startsWith("/ws/twilio")) wss.handleUpgrade(req,sock,head,ws=>handleTwilio(ws));
  else sock.destroy();
});
server.listen(PORT,()=>console.log(`Bridge listening on :${PORT}`));

async function connectOpenAI(){
  const url=`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const headers={"Authorization":`Bearer ${OPENAI_API_KEY}`,"OpenAI-Beta":"realtime=v1"};
  return new Promise((ok,fail)=>{
    const ws=new WebSocket(url,"realtime",{headers});
    ws.on("open",()=>{console.log("OpenAI WS connected");ok(ws);});
    ws.on("error",(e)=>{console.log("OpenAI WS error",e?.message);fail(e);});
  });
}

// send μ-law to Twilio, chunked into 160-byte (20ms) frames
function sendUlawChunkedToTwilio(wsTwilio, streamSid, ulawBytes){
  for(let i=0;i+160<=ulawBytes.length;i+=160){
    const frame=ulawBytes.subarray(i,i+160);
    wsTwilio.send(JSON.stringify({
      event:"media",
      streamSid,
      track:"outbound",
      media:{ payload: bytesToB64(frame) }
    }));
  }
}

function handleTwilio(wsTwilio){
  console.log("Twilio stream connected");
  let streamSid=null, openaiWS=null, open=true;
  let keepalive=null, silencePump=null;
  let gotOpenAIAudio=false, inResponse=false, sessionReady=false;
  let outboundFrames=0, inboundFrames=0, openaiFrames=0;

  wsTwilio.on("message", async msg=>{
    let data; try{ data=JSON.parse(msg.toString("utf8")); } catch { return; }
    const ev=data.event;

    if(ev==="start"){
      streamSid=data.start.streamSid;
      console.log("Twilio start",streamSid,"tracks:",data.start.tracks, "ECHO_TEST:", ECHO_TEST);

      keepalive=setInterval(()=>{
        try{ wsTwilio?.send(JSON.stringify({event:"mark",streamSid,name:"tick"})); }catch{}
      },15000);

      // keep Twilio alive until real audio
      silencePump=setInterval(()=> sendUlawChunkedToTwilio(wsTwilio, streamSid, ULAW_SILENCE_20MS), 40);

      if(!ECHO_TEST){
        openaiWS = await connectOpenAI();

        openaiWS.on("message",(raw)=>{
          let pkt; try{ pkt=JSON.parse(raw.toString("utf8")); } catch { return; }
          // console.log("OA:", pkt.type);

          if(pkt.type==="error"){ console.log("OpenAI ERROR:", JSON.stringify(pkt,null,2)); return; }
          if(pkt.type==="session.updated"){ sessionReady=true; console.log("✔ Realtime session updated"); }
          if(pkt.type==="response.started") inResponse=true;
          if(pkt.type==="response.completed"||pkt.type==="response.failed") inResponse=false;

          if(pkt.type==="response.output_text.delta"&&pkt.delta) console.log("🗣 Zander:",pkt.delta);

          if(pkt.type==="output_audio.delta"&&pkt.delta){
            if(!gotOpenAIAudio){ gotOpenAIAudio=true; clearInterval(silencePump); silencePump=null; console.log("✔ OpenAI audio started"); }
            const ulaw = b64ToBytes(pkt.delta); // already μ-law @8k
            openaiFrames += Math.floor(ulaw.length/160);
            sendUlawChunkedToTwilio(wsTwilio, streamSid, ulaw);
          }
        });

        // configure realtime
        openaiWS.send(JSON.stringify({
          type:"session.update",
          session:{
            voice:VOICE,
            instructions:INSTRUCTIONS,
            input_audio_format:"pcm16",
            output_audio_format:"g711_ulaw"
          }
        }));

        // greet once session ready
        const greet=()=>{
          if(!sessionReady){ setTimeout(greet,80); return; }
          console.log("Sending initial greeting...");
          openaiWS.send(JSON.stringify({
            type:"response.create",
            response:{
              modalities:["audio","text"],
              output_audio_format:"g711_ulaw",
              instructions:"Hi, it's Zander from MachineTrade calling for Martin at MJ Woodworking. Is now a quick time?"
            }
          }));
        };
        greet();
      }
    }

    if(ev==="media"){
      // inbound frame from caller (μ-law 20ms chunks from Twilio are typically 160B)
      inboundFrames++;
      const ulaw = Buffer.from(data.media.payload,"base64");

      if(ECHO_TEST){
        // loop back caller audio immediately
        sendUlawChunkedToTwilio(wsTwilio, streamSid, ulaw);
        outboundFrames += Math.floor(ulaw.length/160);
      } else if (openaiWS && openaiWS.readyState===WebSocket.OPEN){
        // decode μ-law → PCM16(8k) → upsample to 16k → append to OpenAI
        const pcm8k = muLawToPCM16(ulaw);
        const pcm16k = linearResamplePCM16(pcm8k,8000,16000);
        const buf = Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength);
        openaiWS.send(JSON.stringify({ type:"input_audio_buffer.append", audio: bytesToB64(buf) }));
      }
    }

    if(ev==="mark" && data.name==="tick"){
      // periodic stats
      // console.log(`Frames — inbound:${inboundFrames} outbound:${outboundFrames} openai:${openaiFrames}`);
    }

    if(ev==="stop"){
      console.log("Twilio stop");
      wsTwilio.close();
    }
  });

  wsTwilio.on("close",()=>{
    open=false;
    console.log("Twilio stream closed");
    if(keepalive) clearInterval(keepalive);
    if(silencePump) clearInterval(silencePump);
  });
}
