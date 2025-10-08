import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const VOICE          = process.env.VOICE || "verse";

const INSTRUCTIONS = `
You are **Zander** from **MachineTrade**, calling on behalf of **Martin** at **MJ Woodworking**.
Martin is busy today; you’re gathering quick details and answering immediate questions.
Be warm, brief, and genuinely conversational. Collect budget, location/postcode, and what the machine will be used to make.
Handle quick spec questions politely; if unsure, promise to get back. No transfers.
End with a clear next step (you’ll pass info to Martin or arrange callback).
`;

// -------- µ-law helpers --------
const MULAW_MAX = 0x1FFF, SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_SHIFT = 4, SEG_MASK = 0x70;
function ulawDecode(s){s=~s&255;let t=((s&QUANT_MASK)<<3)+132;t<<=((s&SEG_MASK)>>SEG_SHIFT);return(s&SIGN_BIT)?(132-t):(t-132);}
function muLawToPCM16(b){const o=new Int16Array(b.length);for(let i=0;i<b.length;i++)o[i]=ulawDecode(b[i]);return o;}
function linearResamplePCM16(a,fi,fo){if(fi===fo)return a;const r=fo/fi,o=new Int16Array(Math.floor(a.length*r));for(let i=0;i<o.length;i++){const s=i/r,i0=Math.floor(s),i1=Math.min(i0+1,a.length-1),f=s-i0;o[i]=(a[i0]*(1-f)+a[i1]*f)|0;}return o;}
function pcm16ToMuLaw(a){const o=new Uint8Array(a.length);for(let i=0;i<a.length;i++){let s=a[i],sgn=(s>>8)&128;if(sgn)s=-s;if(s>MULAW_MAX)s=MULAW_MAX;s+=132;let e=7;for(let m=16384;(s&m)===0&&e>0;m>>=1)e--;const mnt=(s>>((e===0)?4:(e+3)))&15;o[i]=~(sgn|(e<<4)|mnt)&255;}return o;}
const b64ToBytes=b=>Buffer.from(b,"base64"),bytesToB64=b=>Buffer.from(b).toString("base64");

// -------- HTTP TwiML --------
const server=http.createServer((req,res)=>{
  if(req.url.startsWith("/twiml")){
    res.writeHead(200,{"content-type":"text/xml"});
    const host=req.headers.host;
    res.end(`<Response><Start><Stream url="wss://${host}/ws/twilio" track="both_tracks"/></Start><Pause length="3600"/></Response>`);
    return;
  }
  res.writeHead(200,{"content-type":"text/plain"});res.end("OK");
});

// -------- WS bridge --------
const wss=new WebSocketServer({noServer:true});
server.on("upgrade",(req,sock,head)=>{
  if(req.url.startsWith("/ws/twilio"))wss.handleUpgrade(req,sock,head,ws=>handleTwilio(ws));
  else sock.destroy();
});
server.listen(PORT,()=>console.log("Bridge listening on",PORT));

async function connectOpenAI(){
  const url=`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const headers={"Authorization":`Bearer ${OPENAI_API_KEY}`,"OpenAI-Beta":"realtime=v1"};
  return new Promise((ok,fail)=>{
    const ws=new WebSocket(url,"realtime",{headers});
    ws.on("open",()=>{console.log("OpenAI WS connected");ok(ws);});
    ws.on("error",e=>{console.log("OpenAI WS error",e?.message);fail(e);});
  });
}

function handleTwilio(wsTwilio){
  console.log("Twilio stream connected");
  let streamSid=null,openaiWS=null,open=true;
  let appendedSamples=0,readyToCommit=false,inResponse=false;
  let keepaliveTimer=null;

  const sendToTwilio=u=>{
    if(open&&wsTwilio.readyState===WebSocket.OPEN)
      wsTwilio.send(JSON.stringify({event:"media",streamSid,media:{payload:bytesToB64(u)}}));
  };

  wsTwilio.on("message",async m=>{
    let d;try{d=JSON.parse(m.toString("utf8"));}catch{return;}
    const ev=d.event;

    if(ev==="start"){
      streamSid=d.start.streamSid;
      console.log("Twilio start",streamSid,"tracks:",d.start.tracks);
      openaiWS=await connectOpenAI();

      keepaliveTimer=setInterval(()=>{
        try{openaiWS?.ping?.();}catch{}
        try{wsTwilio?.send(JSON.stringify({event:"mark",streamSid,name:"tick"}));}catch{}
      },15000);

      openaiWS.on("message",raw=>{
        let p;try{p=JSON.parse(raw);}catch{return;}
        if(p.type==="error"){console.log("OpenAI ERROR:",JSON.stringify(p,null,2));return;}

        // transcripts
        if(p.type==="response.output_text.delta"&&p.delta)console.log("🗣 Zander:",p.delta);
        if(p.type==="input_text"&&p.text)console.log("👤 Caller:",p.text);

        // response lifecycle
        if(p.type==="response.started")inResponse=true;
        if(p.type==="response.completed"||p.type==="response.failed")inResponse=false;

        // audio
        if(p.type==="output_audio.delta"&&p.delta){
          const b=Buffer.from(p.delta,"base64");
          const pcm16_16k=new Int16Array(b.buffer,b.byteOffset,b.byteLength/2);
          const pcm16_8k=linearResamplePCM16(pcm16_16k,16000,8000);
          const ulaw=pcm16ToMuLaw(pcm16_8k);
          sendToTwilio(ulaw);
        }
      });

      openaiWS.on("close",(c,r)=>console.log("OpenAI WS closed",c,r?.toString?.()));

      // configure
      openaiWS.send(JSON.stringify({type:"session.update",session:{voice:VOICE,instructions:INSTRUCTIONS}}));

      setTimeout(()=>{
        console.log("Sending initial greeting...");
        openaiWS.send(JSON.stringify({
          type:"response.create",
          response:{modalities:["audio","text"],
            instructions:"Hi, it's Zander from MachineTrade calling for Martin at MJ Woodworking. Is now a quick time?"}
        }));
      },200);
    }

    if(ev==="media"&&openaiWS&&openaiWS.readyState===WebSocket.OPEN){
      const ulaw=b64ToBytes(d.media.payload);
      const pcm16_8k=muLawToPCM16(ulaw);
      const pcm16_16k=linearResamplePCM16(pcm16_8k,8000,16000);
      const view=Buffer.from(pcm16_16k.buffer,pcm16_16k.byteOffset,pcm16_16k.byteLength);
      openaiWS.send(JSON.stringify({type:"input_audio_buffer.append",audio:bytesToB64(view)}));

      appendedSamples+=pcm16_16k.length;
      // commit if ≥100ms audio (≈1600 samples @16kHz)
      if(appendedSamples>=1600&&!inResponse){
        appendedSamples=0;
        openaiWS.send(JSON.stringify({type:"input_audio_buffer.commit"}));
        readyToCommit=true;
      }
      // after commit, request model response once
      if(readyToCommit&&!inResponse){
        readyToCommit=false;inResponse=true;
        openaiWS.send(JSON.stringify({type:"response.create",
          response:{modalities:["audio","text"]}}));
      }
    }

    if(ev==="stop"){
      console.log("Twilio stop");
      try{openaiWS?.send(JSON.stringify({type:"input_audio_buffer.commit"}));}catch{}
      wsTwilio.close();
    }
  });

  wsTwilio.on("close",()=>{
    open=false;
    console.log("Twilio stream closed");
    if(keepaliveTimer)clearInterval(keepaliveTimer);
    try{openaiWS?.close();}catch{}
  });
}
