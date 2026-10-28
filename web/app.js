'use strict';
// OX-SCOPE 1.4: offline personal audio player; no external requests/libraries.
// PCM WAV scope reads original stereo samples from File byte slices, preserving
// high-rate X/Y art. Other codecs use the browser's time-domain audio graph.
const $ = id => document.getElementById(id);
const audio = $('audio');
const canvas = $('scope'), g = canvas.getContext('2d', {alpha: false});
const fileInput = $('audioInput');
let files = [], index = -1, playbackURL = null, coverURL = null;
let ac = null, mediaSource = null, splitter = null, analyserL = null, analyserR = null;
const prefs={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};
let mode = 'bars', theme = prefs.get('ox.theme') || 'classic';
let phosphor = prefs.get('ox.phosphor') || '#68e384';
let rawWav = null, loadID = 0, rawBusy = false, traceData = null, latestPosition = -1;
let fftL = null, fftR = null, waveL = null, waveR = null;
let spec = document.createElement('canvas'), specCtx = spec.getContext('2d', {alpha:false});
let lastSpec = 0, lastFrame = 0, width = 0, height = 0, shownEmpty = true;
let gain = 1, zoom = 1, ms = 20, persistence = .1, grid = true;
let sourceMode = 'system', sysCapturing = false, sysRate = 48000;
let nowPlaying = null, customSystemCover = null, fileCoverData = null;
let metadataError = '';
let sysL = null, sysR = null, sysSpectrum = null, sysSeen = 0;
const nativeBridge = () => window.webkit?.messageHandlers?.native;
function sendNative(command){if(nativeBridge()){nativeBridge().postMessage(command);return true}return false}
function systemLabel(heading, detail){text('tracktitle',heading);text('trackinfo',detail)}
function setSourceMode(next){
  if(!['system','file'].includes(next))return;
  if(sourceMode==='system'&&next!=='system')sendNative('stopSystemAudio');
  sourceMode=next;document.body.dataset.input=next;$('sourceMode').value=next;
  if(next==='system'){
    audio.pause();text('format','SYSTEM / LIVE');text('scopeSource','CAPTURE L/R');
    text('timeNow','LIVE');text('timeTotal','--:--');$('seek').value=0;
    text('audioDetails','SCREEN CAPTURE KIT · SYSTEM AUDIO ONLY');
    if(nowPlaying) applyNowPlaying(nowPlaying); else {systemLabel('SYSTEM AUDIO',metadataError||'Waiting for macOS Now Playing information');setCover(customSystemCover)}
    $('captureBtn').disabled=false;$('captureBtn').textContent=sysCapturing?'STOP CAPTURE':'START CAPTURE';
    $('dropMessage').hidden=sysCapturing;
    if(!sysCapturing){$('dropMessage').querySelector('b').textContent='SYSTEM AUDIO';$('dropMessage').querySelector('span').textContent='CLICK START CAPTURE TO MONITOR MAC AUDIO';}
    status(sysCapturing?'SYSTEM AUDIO CAPTURING':'SYSTEM AUDIO READY · CLICK START CAPTURE');
  }else{
    sysCapturing=false;$('captureBtn').textContent='START CAPTURE';
    $('captureBtn').disabled=true;text('audioDetails','LOCAL FILE / LOSSLESS PCM SCOPE');
    $('dropMessage').hidden=!!files.length;
    if(index>=0){text('tracktitle',files[index].name.replace(/\.[^.]+$/,''));text('trackinfo',`${fileType(files[index])} · ${(files[index].size/1048576).toFixed(1)} MB`);text('format',`${fileType(files[index])} / FILE`);if(fileCoverData)setCover(fileCoverData,true);else setCover(null);updateTime()}
    else{setCover(null);systemLabel('Drop audio files to start','WAV · M4A · MP3 · FLAC*');text('format','NO FILE');text('timeNow','0:00');text('timeTotal','0:00')}
    status('LOCAL FILE PLAYER');
  }
  text('scopeSub',next==='system'?'SYSTEM L/R / LIVE':'FILE L/R / PCM');
}
function fftSystem(l,r){
  const N=2048,real=new Float64Array(N),imag=new Float64Array(N),mag=new Uint8Array(N/2);
  const n=Math.min(N,l.length,r.length);
  for(let i=0;i<n;i++){const t=l.length-n+i;real[i]=((l[t]||0)+(r[t]||0))*.5*(.5-.5*Math.cos(2*Math.PI*i/Math.max(1,n-1)))}
  for(let i=1,j=0;i<N;i++) {let bit=N>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){const v=real[i];real[i]=real[j];real[j]=v}}
  for(let len=2;len<=N;len<<=1){const ang=-2*Math.PI/len;const wR=Math.cos(ang),wI=Math.sin(ang);
    for(let start=0;start<N;start+=len){let ar=1,ai=0;for(let j=0;j<len/2;j++){const p=start+j,q=p+len/2;
       const tr=real[q]*ar-imag[q]*ai,ti=real[q]*ai+imag[q]*ar;
       real[q]=real[p]-tr;imag[q]=imag[p]-ti;real[p]+=tr;imag[p]+=ti;
       const nr=ar*wR-ai*wI;ai=ar*wI+ai*wR;ar=nr;
    }}
  }
  const norm=2/Math.max(1,n*.5);for(let k=0;k<mag.length;k++){
    const amp=Math.hypot(real[k],imag[k])*norm;mag[k]=Math.round(clamp((20*Math.log10(Math.max(amp,1e-8))+92)/84,0,1)*255);
  }return mag;
}
function receiveSystemAudio(data){
  if(sourceMode!=='system'||!data||!Array.isArray(data.l)||!Array.isArray(data.r))return;
  const n=Math.min(data.l.length,data.r.length);if(n<2)return;
  sysL=Float32Array.from(data.l);sysR=Float32Array.from(data.r);
  sysRate=Number(data.rate)||48000;sysSeen=performance.now();sysSpectrum=fftSystem(sysL,sysR);
  if(!sysCapturing){sysCapturing=true;$('captureBtn').textContent='STOP CAPTURE';}
  $('dropMessage').hidden=true;shownEmpty=false;
}
function applyNowPlaying(info){
  if(!info || sourceMode!=='system')return;
  const name=String(info.title||'SYSTEM AUDIO');
  text('tracktitle',name);
  text('play',info.playing===false?'▶':'Ⅱ');
  text('trackinfo',[info.artist,info.album].filter(Boolean).join(' — ')||String(info.source||'Live from another app'));
  text('format',String(info.source||'NOW PLAYING').toUpperCase().slice(0,30));
  text('timeNow',Number.isFinite(Number(info.elapsed))?fmt(Number(info.elapsed)):'LIVE');
  text('timeTotal',Number.isFinite(Number(info.duration))?fmt(Number(info.duration)):'--:--');
  if(Number(info.duration)>0&&Number(info.elapsed)>=0)$('seek').value=Math.min(1000,Math.floor(1000*Number(info.elapsed)/Number(info.duration)));
  if(info.artworkData){setCover(`data:${info.artworkMimeType||'image/jpeg'};base64,${info.artworkData}`)}
  else if(info.keepArtwork && $('artwork').getAttribute('src')){}
  else if(info.artworkURL && /^https:\/\//.test(info.artworkURL))setCover(info.artworkURL);
  else setCover(customSystemCover);
  status('NOW PLAYING: '+String(info.source||'MACOS').toUpperCase());
}
function receiveNowPlaying(info){
  if(info?.error){metadataError=String(info.error);if(sourceMode==='system'){status('METADATA: '+metadataError);if(!nowPlaying)systemLabel('SYSTEM AUDIO',metadataError)}return}
  metadataError='';
  const previous=nowPlaying;nowPlaying=info?.title?info:null;
  if(nowPlaying?.keepArtwork&&previous?.artworkData){nowPlaying.artworkData=previous.artworkData;nowPlaying.artworkMimeType=previous.artworkMimeType}
  if(nowPlaying?.keepArtwork&&previous?.artworkURL)nowPlaying.artworkURL=previous.artworkURL;
  if(sourceMode==='system'){
    if(nowPlaying)applyNowPlaying(nowPlaying);
    else {systemLabel('SYSTEM AUDIO',metadataError|| (sysCapturing?'Audio active · no track metadata available':'Waiting for track information'));text('timeNow','LIVE');text('timeTotal','--:--');setCover(customSystemCover)}
  }
}
function nativeEvent(event){
  if(!event||typeof event!=='object')return;
  if(event.state==='started'){sysCapturing=true;$('captureBtn').textContent='STOP CAPTURE';$('captureBtn').classList.add('active');$('dropMessage').hidden=true;status('SYSTEM CAPTURE ACTIVE / WAITING FOR AUDIO')}
  if(event.state==='stopped'){sysL=null;sysR=null;sysSpectrum=null;sysCapturing=false;$('captureBtn').textContent='START CAPTURE';$('captureBtn').classList.remove('active');if(sourceMode==='system'){$('dropMessage').hidden=false;status('SYSTEM CAPTURE STOPPED')}}
  if(event.state==='error'){sysL=null;sysR=null;sysSpectrum=null;sysCapturing=false;$('captureBtn').textContent='START CAPTURE';$('captureBtn').classList.remove('active');$('dropMessage').hidden=false;status('CAPTURE ERROR: '+String(event.message||'Check Screen & System Audio Recording permission'));}
}
window.oxscopeNative = {receiveSystemAudio,nativeEvent,receiveNowPlaying};

const fmt = sec => {if(!Number.isFinite(sec)||sec<0)return '--:--';sec=Math.floor(sec);const h=Math.floor(sec/3600),m=Math.floor(sec/60)%60,s=sec%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`};
const clamp=(v,a,b)=>Math.max(a,Math.min(v,b));
const status=(s)=>{$('status').textContent=s};
const text=(id,val)=>{$(id).textContent=val};
function savePrefs(){prefs.set('ox.theme',theme);prefs.set('ox.phosphor',phosphor);prefs.set('ox.mode',mode)}
function applyTheme(){document.body.dataset.theme=theme;$('theme').value=theme;$('phosphor').value=phosphor;document.body.style.setProperty('--scope-color',phosphor);savePrefs()}
function rgb(hex){const v=hex.replace('#','');return [parseInt(v.slice(0,2),16),parseInt(v.slice(2,4),16),parseInt(v.slice(4,6),16)]}
function setupAudio(){if(ac)return;ac = new (window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'});
 mediaSource=ac.createMediaElementSource(audio);splitter=ac.createChannelSplitter(2);
 analyserL=ac.createAnalyser();analyserR=ac.createAnalyser();
 for(let a of [analyserL,analyserR]){a.fftSize=8192;a.smoothingTimeConstant=.48;a.minDecibels=-96;a.maxDecibels=-12}
 mediaSource.connect(ac.destination);mediaSource.connect(splitter);
 splitter.connect(analyserL,0);splitter.connect(analyserR,1);
 fftL=new Uint8Array(analyserL.frequencyBinCount);fftR=new Uint8Array(analyserR.frequencyBinCount);
 waveL=new Float32Array(analyserL.fftSize);waveR=new Float32Array(analyserR.fftSize);
}
async function wakeAudio(){try{setupAudio();if(ac.state!=='running')await ac.resume()}catch(err){status('AUDIO ENGINE: '+err.message)}}
function drawQueue(){let out='';if(!files.length){$('playlist').innerHTML='<div class="emptyqueue">OPEN FILES OR DRAG HERE</div>'}else{
 $('playlist').replaceChildren();files.forEach((file,n)=>{const row=document.createElement('div');row.className='queue-row'+(n===index?' selected':'');row.role='option';row.tabIndex=0;row.setAttribute('aria-selected',n===index?'true':'false');const a=document.createElement('span');a.className='qindex';a.textContent=String(n+1).padStart(2,'0');const b=document.createElement('span');b.className='qtitle';b.textContent=file.name.replace(/\.[^.]+$/,'');const c=document.createElement('span');c.className='qduration';c.textContent=file._duration?fmt(file._duration):'';row.append(a,b,c);row.addEventListener('dblclick',()=>selectTrack(n,true));row.addEventListener('click',()=>selectTrack(n,false));row.addEventListener('keydown',ev=>{if(ev.key==='Enter'){selectTrack(n,true)}});$('playlist').append(row)})}
 text('queueCount',`${files.length} FILE${files.length===1?'':'S'}`);
}
function setCover(dataURL, isObjectURL=false){if(dataURL&&coverURL===dataURL)return;/* Keep per-track Blob URLs alive while switching sources. */coverURL=null;const img=$('artwork');if(dataURL){img.src=dataURL;img.parentElement.classList.add('filled');if(isObjectURL)coverURL=dataURL}else{img.removeAttribute('src');img.parentElement.classList.remove('filled')}}
// Embedded artwork reader, entirely local. Reads ID3/APIC, FLAC PICTURE, MP4 covr
// (including files with their moov atom at the END), using file slices, not full
// multi-hour recordings. Does not upload or alter the music file.
const imageBlobURL=(bytes,type)=>URL.createObjectURL(new Blob([bytes],{type}));
function detectedMime(bytes){
  if(bytes.length>8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e)return'image/png';
  if(bytes.length>3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return'image/jpeg';
  if(bytes.length>12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return'image/webp';
  return null;
}
const u32=(a,p)=>(a[p]*16777216+a[p+1]*65536+a[p+2]*256+a[p+3])>>>0;
const text4=(a,p)=>String.fromCharCode(a[p],a[p+1],a[p+2],a[p+3]);
async function id3Cover(file){
  const head=new Uint8Array(await file.slice(0,10).arrayBuffer());
  if(head.length<10||text4(head,0).slice(0,3)!=='ID3')return null;
  const version=head[3];if(![3,4].includes(version))return null;
  const syn=(a,p)=>((a[p]&127)<<21)|((a[p+1]&127)<<14)|((a[p+2]&127)<<7)|(a[p+3]&127);
  const tagSize=syn(head,6);if(tagSize>48*1024*1024)return null;
  const a=new Uint8Array(await file.slice(0,Math.min(file.size,10+tagSize)).arrayBuffer());
  let at=10,limit=a.length;
  if((head[5]&0x40)!==0){ // ID3 extended header
    if(at+4>limit)return null;
    const ext=version===4?syn(a,at):u32(a,at);
    at+=version===4?ext:ext+4;
  }
  for(;at+10<=limit;){
    const id=text4(a,at),size=version===4?syn(a,at+4):u32(a,at+4);
    if(!size||at+10+size>limit)break;
    if(id==='APIC'){
      const start=at+10,end=start+size;const encoding=a[start];let p=start+1;
      while(p<end&&a[p])p++;p++; // MIME null terminator
      p++; // picture type
      if(encoding===1||encoding===2){while(p+1<end){if(a[p]===0&&a[p+1]===0){p+=2;break}p+=2}}
      else {while(p<end&&a[p])p++;p++}
      if(p<end){const payload=a.subarray(p,end);const mime=detectedMime(payload);if(mime)return imageBlobURL(payload,mime)}
    }
    at+=10+size;
  }
  return null;
}
async function flacCover(file){
  const hdr=new Uint8Array(await file.slice(0,4).arrayBuffer());
  if(hdr.length<4||text4(hdr,0)!=='fLaC')return null;
  let off=4;
  for(let block=0;block<64;block++){
    const h=new Uint8Array(await file.slice(off,off+4).arrayBuffer());if(h.length<4)return null;
    const isLast=!!(h[0]&128),type=h[0]&127,size=h[1]*65536+h[2]*256+h[3];off+=4;
    if(type===6&&size<32*1024*1024){
      const a=new Uint8Array(await file.slice(off,off+size).arrayBuffer());let p=0;
      if(a.length<32)return null;
      p+=4;const mimeLength=u32(a,p);p+=4+mimeLength;if(p+4>a.length)return null;
      const descLength=u32(a,p);p+=4+descLength+16;if(p+4>a.length)return null;
      const picLength=u32(a,p);p+=4;if(picLength>0&&picLength<16*1024*1024&&p+picLength<=a.length){
        const payload=a.subarray(p,p+picLength),mime=detectedMime(payload);
        if(mime)return imageBlobURL(payload,mime);
      }
    }
    off+=size;if(isLast||off>60*1024*1024)break;
  }
  return null;
}
async function mp4Cover(file){
  // The 'covr' atom may reside at the beginning OR at the end of a large m4a.
  // Scan in 2MiB windows, checking MP4 atom layout + actual JPEG/PNG magic.
  const ranges=[[0,Math.min(file.size,36*1024*1024)]];
  if(file.size>36*1024*1024)ranges.push([Math.max(0,file.size-36*1024*1024),file.size]);
  const step=2*1024*1024;
  for(const [begin,end] of ranges){
    for(let at=begin;at<end;at+=step){
      const a=new Uint8Array(await file.slice(at,Math.min(end,at+step+256)).arrayBuffer());
      for(let cursor=4;cursor+36<a.length;){
        const p=a.indexOf(99,cursor);if(p<0||p+36>=a.length)break;
        cursor=p+1;
        if(text4(a,p)!=='covr')continue;
        // p is ATOM TYPE; immediately followed by a child 'data' atom.
        const boxStart=p-4,boxSize=u32(a,boxStart);
        if(boxSize<24||boxSize>24*1024*1024)continue;
        const dataAt=p+4;
        if(dataAt+16>a.length||text4(a,dataAt+4)!=='data')continue;
        const dataSize=u32(a,dataAt);
        if(dataSize<20||dataSize>12*1024*1024)continue;
        const payloadStart=at+dataAt+16;
        if(payloadStart+dataSize-16>file.size)continue;
        const payload=new Uint8Array(await file.slice(payloadStart,payloadStart+dataSize-16).arrayBuffer());
        const mime=detectedMime(payload);if(mime)return imageBlobURL(payload,mime);
      }
    }
  }
  return null;
}
async function autoCover(file){
  const ext=file.name.toLowerCase().split('.').pop();
  try{if(['mp3','mp2'].includes(ext))return await id3Cover(file);
  if(ext==='flac')return await flacCover(file);
  if(['m4a','mp4','aac','m4b','alac'].includes(ext))return await mp4Cover(file);
  return await id3Cover(file)}
  catch(e){console.warn('Artwork extraction failed',e);return null}
}
function fileType(file){const m=file.name.toLowerCase().split('.').pop();return (m||'FILE').toUpperCase()}
async function loadFiles(list, add=true){setSourceMode('file');const arr=Array.from(list||[]).filter(f=>f instanceof File||f?.size!==undefined);if(!arr.length)return;
 if(!add){files=arr;index=-1}else files.push(...arr);
 drawQueue();await selectTrack(add?files.length-arr.length:0,false);
}
async function selectTrack(n,autoplay){if(n<0||n>=files.length)return;const seq=++loadID;audio.pause();if(playbackURL){URL.revokeObjectURL(playbackURL);playbackURL=null}
 index=n;rawWav=null;traceData=null;latestPosition=-1;rawBusy=false;
 const file=files[n], basename=file.name.replace(/\.[^.]+$/,'');text('tracktitle',basename);text('trackinfo',`${fileType(file)} · ${(file.size/(1024*1024)).toFixed(1)} MB`);text('format',`${fileType(file)} / FILE`);text('timeNow','0:00');text('timeTotal','--:--');
 $('seek').value=0;$('dropMessage').hidden=true;shownEmpty=false;status(`LOADING: ${file.name}`);drawQueue();fileCoverData=null;setCover(null);
 const maybeArtwork=await autoCover(file);if(seq!==loadID){if(maybeArtwork)URL.revokeObjectURL(maybeArtwork);return}if(maybeArtwork){fileCoverData=maybeArtwork;setCover(maybeArtwork,true)}
 else {status('NO EMBEDDED COVER FOUND · USE ART TO CHOOSE AN IMAGE')}
 try{rawWav=await readWaveHeader(file)}catch(e){status('PCM PARSER: '+e.message);rawWav=null}
 if(seq!==loadID)return;
 playbackURL=URL.createObjectURL(file);audio.src=playbackURL;audio.load();
 text('scopeSource',rawWav?'PCM L/R':'DECODED L/R');text('audioDetails',rawWav?`PCM ${rawWav.bits}-BIT / ${rawWav.channels}CH / ${(rawWav.rate/1000).toFixed(1)}kHz`:`${fileType(file)} / LIVE DECODED AUDIO`);
 status(rawWav?'PCM SCOPE READY':`DECODED SCOPE / ${fileType(file)}`);
 if(autoplay){await wakeAudio();try{await audio.play()}catch(e){status('PLAY: '+e.message)}}
 drawQueue();
}
async function readWaveHeader(file){const bytes=new Uint8Array(await file.slice(0,Math.min(file.size,1048576)).arrayBuffer());if(bytes.length<44)return null;
 const dv=new DataView(bytes.buffer),word=(pos)=>String.fromCharCode(...bytes.subarray(pos,pos+4));
 if(word(0)!=='RIFF'||word(8)!=='WAVE')return null;
 let fmtInfo=null,dataAt=-1,dataBytes=0,at=12;
 while(at+8<=bytes.length){const tag=word(at),size=dv.getUint32(at+4,true),pos=at+8;
  if(tag==='fmt '&&pos+16<=bytes.length){let format=dv.getUint16(pos,true);
   if(format===0xfffe&&size>=40&&pos+26<=bytes.length)format=dv.getUint16(pos+24,true);
   fmtInfo={format,channels:dv.getUint16(pos+2,true),rate:dv.getUint32(pos+4,true),block:0,bits:dv.getUint16(pos+14,true)};
   fmtInfo.block=dv.getUint16(pos+12,true);
  }
  if(tag==='data'){dataAt=pos;dataBytes=Math.min(size,file.size-pos);break}
  at=pos+size+(size%2);
 }
 if(dataAt<0||!fmtInfo)return null;
 const f=fmtInfo;if(![1,3].includes(f.format)||![8,16,24,32,64].includes(f.bits)||f.channels<1||f.channels>16||!f.rate||!f.block)return null;
 return {...f,file,dataAt,dataBytes,frameCount:Math.floor(dataBytes/f.block)};
}
function decodeWavSample(view,offset,format,bits){if(format===3){if(bits===32)return view.getFloat32(offset,true);if(bits===64)return view.getFloat64(offset,true);return 0}
 if(bits===8)return(view.getUint8(offset)-128)/128;
 if(bits===16)return view.getInt16(offset,true)/32768;
 if(bits===24){let s=view.getUint8(offset)|(view.getUint8(offset+1)<<8)|(view.getUint8(offset+2)<<16);if(s&0x800000)s-=0x1000000;return s/8388608}
 if(bits===32)return view.getInt32(offset,true)/2147483648;return 0}
async function readRawTrace(){if(!rawWav||rawBusy||audio.readyState<1||mode==='bars'||mode==='spectrogram')return;
 const f=rawWav,msActual=ms/1000,at=audio.currentTime;
 if(Math.abs(latestPosition-at)<.009&&traceData)return;
 rawBusy=true;const id=loadID;
 try{
   // Centered window. For long 192 kHz tracks read only a few KB per frame.
   const sampleCount=Math.min(35000,Math.max(64,Math.round(f.rate*msActual)));
   const frameStart=clamp(Math.floor((at-msActual/2)*f.rate),0,Math.max(0,f.frameCount-sampleCount));
   const count=Math.min(sampleCount,f.frameCount-frameStart);if(count<2)return;
   const start=f.dataAt+frameStart*f.block;
   const buf=await f.file.slice(start,start+count*f.block).arrayBuffer();if(id!==loadID)return;
   const v=new DataView(buf),l=new Float32Array(count),r=new Float32Array(count),bytes=f.bits/8;
   for(let i=0;i<count;i++){
    let p=i*f.block;l[i]=decodeWavSample(v,p,f.format,f.bits);
    r[i]=f.channels>1?decodeWavSample(v,p+bytes,f.format,f.bits):l[i];
   }
   traceData={l,r};latestPosition=at;
 }catch(e){status('PCM DRAW: '+e.message)}finally{rawBusy=false}
}
function getTrace(){if(sourceMode==='system'){if(!sysL||!sysR)return null;const n=Math.min(sysL.length,sysR.length,Math.floor(sysRate*ms/1000));return {l:sysL.subarray(sysL.length-n),r:sysR.subarray(sysR.length-n)}}if(rawWav&&traceData)return traceData;if(!analyserL)return null;
 analyserL.getFloatTimeDomainData(waveL);analyserR.getFloatTimeDomainData(waveR);
 const available=Math.min(waveL.length,Math.max(128,Math.floor((ac?.sampleRate||48000)*ms/1000)));
 return {l:waveL.subarray(waveL.length-available),r:waveR.subarray(waveR.length-available)};
}
function fitCanvas(){const rect=canvas.getBoundingClientRect();const dpr=Math.min(2,window.devicePixelRatio||1);
 const w=Math.round(Math.max(1,rect.width)*dpr),h=Math.round(Math.max(1,rect.height)*dpr);
 if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;width=w;height=h;g.fillStyle=vizBackground();g.fillRect(0,0,w,h);spec.width=Math.max(200,Math.min(2400,w));spec.height=h;specCtx.fillStyle='#08120b';specCtx.fillRect(0,0,spec.width,spec.height)} }
const vizBackground=()=>getComputedStyle(document.body).getPropertyValue('--viz').trim()||'#070f09';
function clearScreen(preserve=false){g.fillStyle=vizBackground();if(!preserve||persistence===0||mode==='bars'||mode==='spectrogram')g.fillRect(0,0,width,height);else{g.fillStyle=`rgba(5,15,9,${1-persistence})`;g.fillRect(0,0,width,height)}}
function drawGrid(){if(!grid)return;g.save();g.strokeStyle='rgba(104,165,111,.16)';g.lineWidth=1;g.beginPath();for(let i=1;i<10;i++){const x=Math.round(i*width/10)+.5;g.moveTo(x,0);g.lineTo(x,height)}for(let j=1;j<8;j++){const y=Math.round(j*height/8)+.5;g.moveTo(0,y);g.lineTo(width,y)}g.stroke();g.strokeStyle='rgba(141,220,157,.26)';g.beginPath();g.moveTo(width/2+.5,0);g.lineTo(width/2+.5,height);g.moveTo(0,height/2+.5);g.lineTo(width,height/2+.5);g.stroke();g.restore()}
function drawXY(data){clearScreen(true);drawGrid();if(!data)return;
 let {l,r}=data;const n=Math.min(l.length,r.length);if(n<2)return;
 const k=Math.min(width,height)*.43*gain*zoom;
 g.save();const [red,green,blue]=rgb(phosphor);g.shadowColor=phosphor;g.shadowBlur=4;g.lineWidth=Math.max(1.1,width/850);
 g.strokeStyle=`rgba(${red},${green},${blue},.86)`;g.beginPath();const step=Math.max(1,Math.floor(n/20000));
 for(let i=0;i<n;i+=step){const x=width/2+l[i]*k,y=height/2-r[i]*k;if(i===0)g.moveTo(x,y);else g.lineTo(x,y)}g.stroke();g.restore();
}
function drawWave(data){clearScreen(true);drawGrid();if(!data)return;const {l,r}=data,n=Math.min(l.length,r.length);if(n<2)return;
 const [red,green,blue]=rgb(phosphor);const k=height*.19*gain*zoom;
 g.save();g.lineWidth=Math.max(1,width/1100);g.shadowBlur=2;g.shadowColor=phosphor;
 for(const [a,base,alpha] of [[l,height*.29,.88],[r,height*.72,.61]]){
  g.beginPath();g.strokeStyle=`rgba(${red},${green},${blue},${alpha})`;
  const step=Math.max(1,Math.floor(n/(width*1.6)));
  for(let i=0;i<n;i+=step){const x=i/(n-1)*width,y=base-a[i]*k;if(i===0)g.moveTo(x,y);else g.lineTo(x,y)}g.stroke();
 }
 g.shadowBlur=0;g.fillStyle=`rgba(${red},${green},${blue},.68)`;g.font=`${Math.max(10,Math.floor(height/45))}px monospace`;g.fillText('L',9,height*.29-9);g.fillText('R',9,height*.72-9);g.restore();
}
function fetchFFT(){if(sourceMode==='system')return !!sysSpectrum;if(!analyserL)return false;analyserL.getByteFrequencyData(fftL);analyserR.getByteFrequencyData(fftR);return true}
function freqAtLog(t){const rate=ac?.sampleRate||48000;const max=Math.min(20000,rate/2);const lo=25;const freq=lo*Math.pow(max/lo,t);const bin=Math.round(freq/(rate/8192));return Math.min(bin,fftL.length-1)}
function sampleFFT(t){
 if(sourceMode==='system'){
  if(!sysSpectrum)return 0;
  const lo=25,max=Math.min(20000,sysRate/2),freq=lo*Math.pow(max/lo,t);
  const bin=clamp(Math.round(freq/(sysRate/2048)),0,sysSpectrum.length-1);
  return clamp(sysSpectrum[bin]/255*gain,0,1);
 }
 const bin=freqAtLog(t);let v=(fftL[bin]+fftR[bin])*.5/255;return clamp(v*gain,0,1)}
function drawBars(){clearScreen();drawGrid();if(!fetchFFT())return;
 const [rr,gg,bb]=rgb(phosphor);const bands=Math.max(22,Math.min(160,Math.round(width/10)));const gap=Math.max(1,Math.round(width/600));const bw=width/bands;
 for(let i=0;i<bands;i++){
  let v=0;for(let k=0;k<3;k++)v=Math.max(v,sampleFFT((i+(k+.5)/3)/bands));
  const h=Math.min(height*.87,Math.pow(v,1.25)*height*.86*zoom);
  g.fillStyle=`rgba(${rr},${gg},${bb},${(.4+.6*v).toFixed(2)})`;
  g.fillRect(Math.round(i*bw),height-h,Math.max(1,Math.ceil(bw-gap)),h);
 }
}
function spectralColor(v){v=clamp(v,0,1);const [r,gr,b]=rgb(phosphor);return [Math.floor(6+(r-6)*Math.pow(v,.84)),Math.floor(12+(gr-12)*Math.pow(v,.8)),Math.floor(9+(b-9)*Math.pow(v,1.2))]}
function drawSpectro(t){if(!fetchFFT())return;
 if(t-lastSpec>32){lastSpec=t;const ww=spec.width,hh=spec.height;const strip=specCtx.getImageData(2,0,Math.max(1,ww-2),hh);specCtx.putImageData(strip,0,0);
  const im=specCtx.createImageData(2,hh);
  for(let y=0;y<hh;y++){
   const v=sampleFFT(1-y/Math.max(1,hh-1));const [r,gr,b]=spectralColor(clamp(v*zoom,0,1));
   for(let col=0;col<2;col++){const k=(y*2+col)*4;im.data[k]=r;im.data[k+1]=gr;im.data[k+2]=b;im.data[k+3]=255}
  }specCtx.putImageData(im,ww-2,0);
 }
 clearScreen();g.imageSmoothingEnabled=false;g.drawImage(spec,0,0,width,height);g.imageSmoothingEnabled=true;
}
function selectMode(m){if(!['bars','spectrogram','o','l'].includes(m))return;mode=m;savePrefs();
 document.querySelectorAll('[data-mode]').forEach(b=>{const a=b.dataset.mode===mode;b.classList.toggle('active',a);b.setAttribute('aria-selected',a?'true':'false')});
 const captions={bars:'STEREO FFT / BARS',spectrogram:'SPECTROGRAM / LOG FREQ',o:'OSCILLOSCOPE / L + R',l:'STEREO X/Y / L → X · R → Y'};
 text('scopeCaption',captions[m]);text('scopeSub',m==='l'?'TRUE X/Y':m==='o'?'TIME DOMAIN':m==='bars'?'20 Hz - 20 kHz':'TIME →');
 $('window').disabled=m==='bars'||m==='spectrogram';$('trail').disabled=m==='bars'||m==='spectrogram';
 g.fillStyle=vizBackground();g.fillRect(0,0,canvas.width,canvas.height);
}
function animate(ts){requestAnimationFrame(animate);if(ts-lastFrame<16)return;lastFrame=ts;fitCanvas();
 if(sourceMode==='system'){
   if(!sysCapturing){if(!shownEmpty){clearScreen();shownEmpty=true}return}
   if(mode==='bars')drawBars();else if(mode==='spectrogram')drawSpectro(ts);else{const d=getTrace();if(mode==='o')drawWave(d);else drawXY(d)}
   text('vizStatus',ts-sysSeen<1500?'SYS / LIVE':'SYS / SILENT');return;
 }
 if(!files.length||index<0){if(!shownEmpty){clearScreen();shownEmpty=true}return}
 if(mode==='bars')drawBars();else if(mode==='spectrogram')drawSpectro(ts);else{if(rawWav)void readRawTrace();const d=getTrace();if(mode==='o')drawWave(d);else drawXY(d)}
 text('vizStatus',audio.paused?'SIGNAL / PAUSED':`SIGNAL / ${rawWav?'PCM':'LIVE'}`);
}
function updateTime(){text('timeNow',fmt(audio.currentTime));text('timeTotal',fmt(audio.duration));$('seek').value=Number.isFinite(audio.duration)&&audio.duration>0?Math.floor(audio.currentTime/audio.duration*1000):0}
function updatePlay(){text('play',audio.paused?'▶':'Ⅱ');if(audio.paused)status('PAUSED');else status(rawWav?'PLAYING / RAW PCM SCOPE':'PLAYING / DECODED SCOPE')}
function next(delta){if(!files.length)return;selectTrack(clamp(index+delta,0,files.length-1),true)}
function stop(){audio.pause();audio.currentTime=0;updateTime();status('STOPPED')}
function toggleFS(){if(window.webkit?.messageHandlers?.native){window.webkit.messageHandlers.native.postMessage('fullscreen');return}if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen?.()}
$('play').addEventListener('click',async()=>{if(sourceMode==='system'){sendNative('media:2');return;}if(!files.length){fileInput.click();return}await wakeAudio();if(audio.paused){try{await audio.play()}catch(e){status('PLAYBACK ERROR: '+e.message)}}else audio.pause()});
$('stop').addEventListener('click',()=>{if(sourceMode==='file')stop();else sendNative('media:3')});$('prev').addEventListener('click',()=>sourceMode==='file'?next(-1):sendNative('media:5'));$('next').addEventListener('click',()=>sourceMode==='file'?next(1):sendNative('media:4'));
$('loadbtn').addEventListener('click',()=>fileInput.click());$('openfiles').addEventListener('click',()=>fileInput.click());
$('openart').addEventListener('click',()=>$('artInput').click());$('cover').addEventListener('click',()=>$('artInput').click());
$('artInput').addEventListener('change',ev=>{const f=ev.target.files?.[0];if(f){const u=URL.createObjectURL(f);if(sourceMode==='system')customSystemCover=u;else fileCoverData=u;setCover(u,true)}ev.target.value=''});
fileInput.addEventListener('change',async ev=>{await loadFiles(ev.target.files,true);ev.target.value=''});
$('clearQueue').addEventListener('click',()=>{audio.pause();audio.removeAttribute('src');audio.load();++loadID;files=[];index=-1;rawWav=null;traceData=null;fileCoverData=null;if(playbackURL)URL.revokeObjectURL(playbackURL);playbackURL=null;setCover(null);text('tracktitle','Drop audio files to start');text('trackinfo','WAV · MP3 · M4A · AIFF*');text('timeNow','0:00');text('timeTotal','0:00');text('format','NO SOURCE');$('dropMessage').hidden=false;drawQueue();status('READY.');shownEmpty=false});
$('seek').addEventListener('input',ev=>{if(sourceMode==='system'){const duration=Number(nowPlaying?.duration);if(duration>0)sendNative('mediaSeek:'+String(duration*Number(ev.target.value)/1000));return}if(sourceMode==='file'&&Number.isFinite(audio.duration)){audio.currentTime=audio.duration*Number(ev.target.value)/1000;traceData=null;latestPosition=-1;updateTime()}});
$('volume').addEventListener('input',()=>{audio.volume=Number($('volume').value)/100;text('volumeText',`${$('volume').value}%`)});audio.volume=.75;
$('sourceMode').addEventListener('change',()=>setSourceMode($('sourceMode').value));
$('captureBtn').addEventListener('click',()=>{
  if(sourceMode!=='system')setSourceMode('system');
  if(sysCapturing){sendNative('stopSystemAudio');nativeEvent({state:'stopped'});return}
  if(!sendNative('startSystemAudio')){nativeEvent({state:'error',message:'SYSTEM AUDIO REQUIRES THE MAC APP, NOT THE BROWSER PREVIEW'});return}
  status('REQUESTING SYSTEM AUDIO PERMISSION…');
});
$('theme').addEventListener('change',()=>{theme=$('theme').value;applyTheme()});$('phosphor').addEventListener('input',()=>{phosphor=$('phosphor').value;applyTheme()});
$('fullscreen').addEventListener('click',toggleFS);
for(const b of document.querySelectorAll('[data-mode]'))b.addEventListener('click',()=>selectMode(b.dataset.mode));
for(const [key,fn] of [['gain',v=>{gain=v/100;text('gainVal',`${gain.toFixed(2)}×`)}],['zoom',v=>{zoom=v/100;text('zoomVal',`${zoom.toFixed(1)}×`)}],['window',v=>{ms=v;text('windowVal',`${v}ms`);traceData=null;latestPosition=-1}],['trail',v=>{persistence=v/100;text('trailVal',`${v}%`)}]]){
 $(key).addEventListener('input',()=>fn(Number($(key).value)));
}
$('gridlines').addEventListener('change',()=>grid=$('gridlines').checked);
audio.addEventListener('timeupdate',updateTime);audio.addEventListener('durationchange',()=>{updateTime();if(index>=0){files[index]._duration=audio.duration;drawQueue()}});
audio.addEventListener('play',updatePlay);audio.addEventListener('pause',updatePlay);audio.addEventListener('ended',()=>{if(index<files.length-1)next(1);else{status('PLAYLIST COMPLETE');updatePlay()}});
audio.addEventListener('error',()=>status('PLAYBACK UNSUPPORTED — TRY WAV/MP3/M4A'));
const dragHasFile=e=>Array.from(e.dataTransfer?.types||[]).includes('Files');
let dragDepth=0;document.addEventListener('dragenter',e=>{if(dragHasFile(e)){e.preventDefault();dragDepth++;document.body.classList.add('dragover')}});
document.addEventListener('dragover',e=>{if(dragHasFile(e)){e.preventDefault();e.dataTransfer.dropEffect='copy'}});
document.addEventListener('dragleave',e=>{if(dragHasFile(e)){dragDepth--;if(dragDepth<=0){dragDepth=0;document.body.classList.remove('dragover')}}});
document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.body.classList.remove('dragover');const f=Array.from(e.dataTransfer?.files||[]).filter(x=>/\.(wav|wave|aiff?|mp3|m4a|aac|flac|ogg|opus)$/i.test(x.name));if(f.length)loadFiles(f,true)});
document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(e.key===' '&&sourceMode==='file'){e.preventDefault();$('play').click()}else if(e.key==='ArrowRight'){audio.currentTime=clamp(audio.currentTime+5,0,audio.duration||0)}else if(e.key==='ArrowLeft'){audio.currentTime=clamp(audio.currentTime-5,0,audio.duration||0)}else if(e.key.toLowerCase()==='f'&&!e.metaKey&&!e.ctrlKey){toggleFS()}});
window.oxscope = {loadFiles,selectMode,setSourceMode,receiveSystemAudio,nativeEvent,receiveNowPlaying,version:'1.3'};

function applyCustomSkin(css){$('customSkin').textContent=css||'';prefs.set('ox.customCss',css||'');status(css?'CUSTOM CSS SKIN APPLIED':'CUSTOM SKIN RESET')}
$('importskin').addEventListener('click',()=>$('skinInput').click());
$('resetskin').addEventListener('click',()=>applyCustomSkin(''));
$('skinInput').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;
 if(f.size>65536){status('SKIN TOO LARGE (MAX 64 KB)');return}
 const css=await f.text();
 // Prohibit CSS network imports; skins are strictly offline, color/layout only.
 if(/@import\b|url\s*\(/i.test(css)){status('SKIN REJECTED: EXTERNAL URL / IMPORT');return}
 applyCustomSkin(css);e.target.value='';
});
$('customSkin').textContent=prefs.get('ox.customCss')||'';

applyTheme();selectMode(prefs.get('ox.mode')||'bars');drawQueue();setSourceMode('system');requestAnimationFrame(animate);
