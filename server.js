// server.js — Twilio Media Streams <-> OpenAI Realtime bridge + TwiML endpoint
// Node 20+, dependency: ws

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "verse";

const INSTRUCTIONS = `
You are Zander from MachineTrade, calling for Martin at MJ Woodworking.
Keep it warm, brief and conversational. Gather budget, location, intended use, etc.
Answer simple spec questions; if unsure, promise a quick follow-up. No transfers.
Close with a clear next step (you’ll pass notes to Martin / arrange callback / send quote outline).
`;

const bytesToB64 = b => Buffer.from(b).toString("base64");
const ULAW_SILENCE_20MS = new Uint8Array(160).fill(0xFF);

// μ-law decode + resampler
const MULAW_MAX = 0x1FFF, SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_SHIFT = 4, SEG_MASK = 0x70;
function ulawDecode(sample){ sample=~sample&0xFF; let t=((sample&QUANT_MASK)<<3)+0x84; t<<=((sample&SEG_MASK)>>>SEG_SHIFT); return ((sample&SIGN_BIT)?(0x84-t):(t-0x84)); }
function muLawToPCM16(ulawBytes){ const out=new Int16Array(ulawBytes.length); for(let i=0;i<ulawBytes.length;i++) out[i]=ulawDecode(ulawBytes[i]); return out; }
function linearResamplePCM16(int16In,inRate,outRate){
  if(inRate===outRate) return int16In;
  const ratio=outRate/inRate,outLen=Math.floor(int16In.length*ratio);
  const out=new Int16Array(outLen);
  for(let i=0;i<outLen;i++){const src=i/ratio;const i0=Math.floor(src),i1=Math.min(i0+1,int16In.length-1);const f=src-i0;
    out[i]=(int16In[i0]*(1-f)+int16In[i1]*f)|0;}
  return out;
}

// HTTP TwiML
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
  res.writeHead(200,{"content-type":"text/plain"});
  res.end("OK");
});

// WS bridge
const wss=new WebSocketServer({noServer:true});
server.on("upgrade",(req,socket,head)=>{
  if(req.url.startsWith("/ws/twilio")) wss.handleUpgrade(req,socket,head,ws=>handleTwilio(ws));
  else socket.destroy();
});
server.listen(PORT,()=>console.log(`Bridge listening on :${PORT}`));

async function connectOpenAI(){
  const url=`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const headers={"Authorization":`Bearer ${OPENAI_API_KEY}`,"OpenAI-Beta":"realtime=v1"};
  return new Promise((res,rej)=>{
    const ws=new WebSocket(url,"realtime",{headers});
    ws.on("open",()=>{console.log("OpenAI WS connected");res(ws);});
    ws.on("error",e=>rej(e));
  });
}

function handleTwilio(wsTwilio){
  console.log("Twilio stream connected");
  let streamSid=null, openaiWS=null, open=true;
  let keepalive=null, silencePump=null;
  let gotAudio=false, inResponse=false, sessionReady=false;
  let outboundMarkSent=false;

  function sendToTwilio(ulawBytes){
    if(!open||wsTwilio.readyState!==WebSocket.OPEN)return;
    // group into 320-byte (40 ms) frames
    for(let i=0;i<ulawBytes.length;i+=320){
      const frame=ulawBytes.subarray(i,i+320);
      wsTwilio.send(JSON.stringify({
        event:"media",
        streamSid,
        track:"outbound",
        media:{payload:bytesToB64(frame)}
      }));
    }
    if(!outboundMarkSent){ // nudge Twilio to start playback
      outboundMarkSent=true;
      wsTwilio.send(JSON.stringify({event:"mark",streamSid,name:"outbound_start"}));
    }
  }

  wsTwilio.on("message",async msg=>{
    let data;try{data=JSON.parse(msg.toString("utf8"));}catch{return;}
    const event=data.event;

    if(event==="start"){
      streamSid=data.start.streamSid;
      console.log("Twilio start",streamSid,"tracks:",data.start.tracks);
      openaiWS=await connectOpenAI();

      keepalive=setInterval(()=>{
        try{openaiWS?.ping?.();}catch{}
        try{wsTwilio?.send(JSON.stringify({event:"mark",streamSid,name:"tick"}));}catch{}
      },15000);

      silencePump=setInterval(()=>sendToTwilio(ULAW_SILENCE_20MS),40);

      openaiWS.on("message",raw=>{
        let pkt;try{pkt=JSON.parse(raw.toString("utf8"));}catch{return;}
        if(pkt.type==="error"){console.log("OpenAI ERROR:",JSON.stringify(pkt,null,2));return;}
        if(pkt.type==="session.updated"){sessionReady=true;console.log("✔ Realtime session updated");}
        if(pkt.type==="response.started")inResponse=true;
        if(pkt.type==="response.completed"||pkt.type==="response.failed")inResponse=false;

        if(pkt.type==="response.output_text.delta"&&pkt.delta)console.log("🗣 Zander:",pkt.delta);
        if(pkt.type==="input_text"&&pkt.text)console.log("👤 Caller:",pkt.text);

        if(pkt.type==="output_audio.delta"&&pkt.delta){
          if(!gotAudio){gotAudio=true;clearInterval(silencePump);silencePump=null;console.log("✔ OpenAI audio started");}
          const ulaw=Buffer.from(pkt.delta,"base64");
          sendToTwilio(ulaw);
        }
      });

      openaiWS.send(JSON.stringify({
        type:"session.update",
        session:{
          voice:VOICE,
          instructions:INSTRUCTIONS,
          input_audio_format:"pcm16",
          output_audio_format:"g711_ulaw"
        }
      }));

      const greet=()=>{
        if(!sessionReady){setTimeout(greet,80);return;}
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

    if(event==="media"&&openaiWS&&openaiWS.readyState===WebSocket.OPEN){
      const ulaw=Buffer.from(data.media.payload,"base64");
      const pcm16_8k=muLawToPCM16(ulaw);
      const pcm16_16k=linearResamplePCM16(pcm16_8k,8000,16000);
      const buf=Buffer.from(pcm16_16k.buffer,pcm16_16k.byteOffset,pcm16_16k.byteLength);
      openaiWS.send(JSON.stringify({type:"input_audio_buffer.append",audio:bytesToB64(buf)}));
    }

    if(event==="stop"){console.log("Twilio stop");wsTwilio.close();}
  });

  wsTwilio.on("close",()=>{
    open=false;
    console.log("Twilio stream closed");
    clearInterval(keepalive);
    clearInterval(silencePump);
    try{openaiWS?.close();}catch{}
  });
}
