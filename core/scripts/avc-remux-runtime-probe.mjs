// Opt-in native AVC probe: synthetic canvas, actual product renderer,
// explicit electron.exe, own profile. Installed app and desktop stay untouched.
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
const core=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const args=process.argv.slice(2)
const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]}
const electron=option('--electron',null), artifacts=resolve(option('--artifacts',resolve(core,'out/issue-243/runtime-'+Date.now())))
const seconds=Number(option('--seconds','4')), highEntropy=args.includes('--high-entropy')
assert.ok(electron&&basename(electron).toLowerCase()==='electron.exe'&&existsSync(electron),'explicit existing electron.exe required')
assert.ok(Number.isFinite(seconds)&&seconds>=2&&seconds<=10800,'bounded 2s..3h probe')
mkdirSync(artifacts,{recursive:true})
assert.equal(existsSync(resolve(artifacts,'result.json')),false,'fresh evidence directory')
const sourcePath=resolve(core,'src/renderer/capture/capture.ts')
const accessors=[
'globalThis.fixture={',
' install(acquiredStream){teardown();stream=acquiredStream;startPayload={displayId:"synthetic-runtime",fps:15,focused:false};segmentMs=30000;recorderFormat=pickRecorderFormat(t=>MediaRecorder.isTypeSupported(t));if(!installFreshReplayStorage(captureGeneration))throw Error("storage install failed")},',
' drain:()=>ingestQueue?.flush(),',
' async hold(id){const end=performance.now();if(!await flushRecorderSession(activeRecorder,end,false))throw Error("hold flush failed");if(!enterReplayHold(id,captureGeneration))throw Error("hold failed");const replay=replayRing?.assemble(end);if(!replay)throw Error("empty real replay");return {endAtMs:end,durationMs:replay.durationMs,buffer:replay.buffer}},',
' resume:id=>resumeHeldReplay(id,captureGeneration,"main"),settle:()=>recorderQueue,teardown,',
' snapshot:()=>({recorder:activeRecorder?.recorder,remuxes:Array.from(recorderRemuxers,r=>{const s=r.stats();return {...s,position:String(s.position),outputBytes:String(s.outputBytes),emittedSamples:String(s.emittedSamples)}}),ring:replayRing?.stats()??null,ingest:ingestQueue?.stats()??null})',
'};'].join('\n')
const compiled=buildSync({stdin:{contents:readFileSync(sourcePath,'utf8')+'\n'+accessors,resolveDir:dirname(sourcePath),loader:'ts'},bundle:true,platform:'browser',format:'iife',write:false}).outputFiles[0].text
writeFileSync(resolve(artifacts,'capture-fixture.js'),compiled)
writeFileSync(resolve(artifacts,'fixture.html'),'<!doctype html><meta charset=utf-8><title>Isolated synthetic AVC fixture</title>')
const body="async function(config){\nconst native={bytes:0,creates:0,starts:0,stops:0,events:0,emptyEvents:0,errors:[],options:[]}, raw=[], resumedRaw=[];\nconst Native=globalThis.MediaRecorder;\nglobalThis.MediaRecorder=class extends Native {\n constructor(stream,options){super(stream,options);native.creates++;native.options.push(options);this.addEventListener('dataavailable',e=>{native.bytes+=e.data.size;native.events++;if(!e.data.size)native.emptyEvents++;if(config.seconds<20&&native.creates===1)raw.push(e.data);else if(config.seconds<20&&native.creates===2)resumedRaw.push(e.data)});this.addEventListener('error',e=>native.errors.push(String(e.error)))}\n start(...args){native.starts++;return super.start(...args)} stop(){native.stops++;return super.stop()}\n};\nconst subscriptions=new Map(), errors=[];\nwindow.captureBridge=Object.fromEntries(['onStart','onReplayWorkload','onNativeFallbackFrame','onNativeFallbackError','onRequestReplay','onResumeReplay'].map(k=>[k,f=>subscriptions.set(k,f)]));\nwindow.captureBridge.sendError=e=>errors.push(e);\nconst canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;document.body.append(canvas);\nconst ctx=canvas.getContext('2d'),stream=canvas.captureStream(0),track=stream.getVideoTracks()[0];\n(0,eval)(config.bundle);\nfixture.install(stream);\nconst initialRecorder=fixture.snapshot().recorder;\nlet seed=0x12345678,frames=0,peakRemux=0,peakRing=0,peakQueue=0;\nconst noise=config.highEntropy?ctx.createImageData(canvas.width,canvas.height):null;\nconst started=performance.now(),targetEnd=started+config.seconds*1000;\nglobalThis.runtimeProgress=()=>{const s=fixture.snapshot();return {elapsedMs:performance.now()-started,frames,native:{...native,options:native.options.slice()},errors:errors.slice(),sameEncoder:s.recorder===initialRecorder,remuxes:s.remuxes,ring:s.ring,ingest:s.ingest,peakRemux,peakRing,peakQueue}};\nfunction draw(){\n if(noise){const p=new Uint32Array(noise.data.buffer);for(let i=0;i<p.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;p[i]=0xff000000|(seed&0x00ffffff)}ctx.putImageData(noise,0,0)}\n else{ctx.fillStyle='#202b48';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='#86d7bb';ctx.fillRect((frames*13)%1500,120,300,300)}\n ctx.fillStyle='#000000';ctx.fillRect(0,0,450,65);ctx.fillStyle='#ffffff';ctx.font='32px monospace';ctx.fillText(String(frames),20,45);track.requestFrame();frames++;\n const s=fixture.snapshot();for(const r of s.remuxes)peakRemux=Math.max(peakRemux,r.pendingBytes+r.sampleBytes);if(s.ring)peakRing=Math.max(peakRing,s.ring.retainedBytes);if(s.ingest)peakQueue=Math.max(peakQueue,s.ingest.activeBlobBytes+s.ingest.queuedBlobBytes+s.ingest.batchedBlobBytes)\n}\nwhile(performance.now()<targetEnd){draw();const target=started+frames*1000/15;await new Promise(r=>setTimeout(r,Math.max(0,target-performance.now())))}\nawait fixture.drain();\nconst before=runtimeProgress();\nif(!before.sameEncoder||native.creates!==1||native.starts!==1||native.stops!==0)throw Error('continuous encoder was replaced before explicit snapshot');\nif(errors.length||native.errors.length)throw Error('capture/native errors: '+JSON.stringify({errors,native:native.errors}));\nif(config.seconds>=7200&&(native.bytes<=4294967296||before.remuxes.length!==1||BigInt(before.remuxes[0].position)<=4294967296n||BigInt(before.remuxes[0].outputBytes)<=4294967296n))throw Error('real native/parser/fMP4 cumulative output did not cross 4GiB');\nconst replay=await fixture.hold('runtime-fixture');\nconst replayBytes=Array.from(new Uint8Array(replay.buffer));\nconst rawBytes=raw.length?Array.from(new Uint8Array(await new Blob(raw).arrayBuffer())):null;\nif(!fixture.resume('runtime-fixture'))throw Error('RESUME failed');\nawait fixture.settle();\nfor(let n=0;n<20;n++){draw();await new Promise(r=>setTimeout(r,67))}\nawait fixture.drain();\nconst afterResume=runtimeProgress();\nlet resumedReplay=null;try{const r=await fixture.hold('runtime-resumed');resumedReplay={durationMs:r.durationMs,endAtMs:r.endAtMs,bytes:Array.from(new Uint8Array(r.buffer))}}catch(e){errors.push(String(e))}\nfixture.teardown();\nawait new Promise(r=>setTimeout(r,50));\nconst resumedRawBytes=resumedRaw.length?Array.from(new Uint8Array(await new Blob(resumedRaw).arrayBuffer())):null;\nconst after=fixture.snapshot();\nif(after.remuxes.length||after.ring!==null||after.ingest!==null||stream.active)throw Error('teardown retained product owner');\nreturn {result:errors.length||native.errors.length||native.creates!==2||afterResume.ring===null?'FAIL':'PASS',scope:'real native MediaRecorder with synthetic canvas through actual renderer; installed application untouched',\n seconds:config.seconds,highEntropy:config.highEntropy,wallMs:performance.now()-started,frames,native,errors,before,\n resumed:native.creates===2&&afterResume.ring!==null,cleanup:{remuxOwners:after.remuxes.length,streamActive:stream.active},\n replay:{bytes:replayBytes,durationMs:replay.durationMs,endAtMs:replay.endAtMs},resumedReplay,rawBytes,resumedRawBytes}\n}"
const main=[
"const{app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path');",
"app.setName('CapturePack isolated native AVC integration');app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(path.join(__dirname,'profile','logs'),{recursive:true});app.setPath('logs',path.join(__dirname,'profile','logs'));",
"app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});let timer;",
"const save=(n,o)=>fs.writeFileSync(path.join(__dirname,n),JSON.stringify(o,null,2));",
"w.webContents.on('render-process-gone',(_e,d)=>{save('renderer-exit.json',d);app.exit(3)});",
"try{await w.loadFile(path.join(__dirname,'fixture.html'));timer=setInterval(async()=>{try{const progress=await w.webContents.executeJavaScript('globalThis.runtimeProgress?.()');if(progress)fs.appendFileSync(path.join(__dirname,'progress.jsonl'),JSON.stringify({at:new Date().toISOString(),progress,processes:app.getAppMetrics()})+'\\n')}catch(e){fs.appendFileSync(path.join(__dirname,'sampling-errors.txt'),String(e)+'\\n')}},15000);",
"const r=await w.webContents.executeJavaScript('('+"+JSON.stringify(body)+"+')('+JSON.stringify({bundle:fs.readFileSync(path.join(__dirname,'capture-fixture.js'),'utf8'),seconds:"+seconds+",highEntropy:"+highEntropy+"})+')');",
"if(r.replay?.bytes){fs.writeFileSync(path.join(__dirname,'replay.mp4'),Buffer.from(r.replay.bytes));r.replay.bytes=r.replay.bytes.length;}if(r.rawBytes){fs.writeFileSync(path.join(__dirname,'reference.mkv'),Buffer.from(r.rawBytes));r.rawBytes=r.rawBytes.length;}",
"if(r.resumedReplay?.bytes){fs.writeFileSync(path.join(__dirname,'resumed-replay.mp4'),Buffer.from(r.resumedReplay.bytes));r.resumedReplay.bytes=r.resumedReplay.bytes.length;}if(r.resumedRawBytes){fs.writeFileSync(path.join(__dirname,'resumed-reference.mkv'),Buffer.from(r.resumedRawBytes));r.resumedRawBytes=r.resumedRawBytes.length;}r.electron=process.versions.electron;r.chromium=process.versions.chrome;save('result.json',r);console.log(JSON.stringify(r));clearInterval(timer);w.destroy();app.exit(r.result==='PASS'?0:1)}catch(e){clearInterval(timer);save('error.json',{error:String(e),stack:e.stack});console.error(String(e));w.destroy();app.exit(2)}});",
].join('\n')
writeFileSync(resolve(artifacts,'main.cjs'),main)
const startedAt=new Date().toISOString()
const child=spawn(electron,[resolve(artifacts,'main.cjs')],{windowsHide:true,stdio:['ignore','pipe','pipe']})
const stdout=[],stderr=[]
child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b))
const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r)})
writeFileSync(resolve(artifacts,'runtime.stdout'),Buffer.concat(stdout));writeFileSync(resolve(artifacts,'runtime.stderr'),Buffer.concat(stderr))
const receipt={startedAt,finishedAt:new Date().toISOString(),code,electron,artifacts,seconds,highEntropy}
writeFileSync(resolve(artifacts,'receipt.json'),JSON.stringify(receipt,null,2))
console.log(JSON.stringify(receipt));assert.equal(code,0,'isolated real native product probe')
const probe=spawnSync('ffprobe',['-v','error','-show_streams','-show_packets','-select_streams','v:0','-of','json',resolve(artifacts,'replay.mp4')],{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:32*1024*1024})
writeFileSync(resolve(artifacts,'ffprobe.json'),probe.stdout);writeFileSync(resolve(artifacts,'ffprobe.stderr'),probe.stderr);assert.equal(probe.status,0)
const decode=path=>spawnSync('ffmpeg',['-v','error','-threads','1','-i',path,'-fps_mode','passthrough','-f','framemd5','-'],{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024})
const replayDecode=decode(resolve(artifacts,'replay.mp4'))
writeFileSync(resolve(artifacts,'replay-framemd5.txt'),replayDecode.stdout);writeFileSync(resolve(artifacts,'decode.stderr'),replayDecode.stderr)
assert.equal(replayDecode.status,0);assert.equal(replayDecode.stderr.trim(),'','decode errors')
const hashes=value=>value.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim())
const report={...receipt,decodedFrames:hashes(replayDecode.stdout).length,packets:JSON.parse(probe.stdout).packets.length}
assert.ok(report.decodedFrames>0)
if(existsSync(resolve(artifacts,'reference.mkv'))){
 const original=decode(resolve(artifacts,'reference.mkv'))
 writeFileSync(resolve(artifacts,'reference-framemd5.txt'),original.stdout);writeFileSync(resolve(artifacts,'reference-decode.stderr'),original.stderr)
 assert.equal(original.status,0);assert.equal(original.stderr.trim(),'')
 assert.deepEqual(hashes(replayDecode.stdout),hashes(original.stdout),'remux changed decoded source frames')
 report.referenceDecodedFrames=hashes(original.stdout).length;report.identicalDecodedFrames=true
}

if (existsSync(resolve(artifacts,'resumed-reference.mkv'))) {
 const replay = decode(resolve(artifacts,'resumed-replay.mp4'))
 const original = decode(resolve(artifacts,'resumed-reference.mkv'))
 writeFileSync(resolve(artifacts,'resumed-replay-framemd5.txt'),replay.stdout)
 writeFileSync(resolve(artifacts,'resumed-reference-framemd5.txt'),original.stdout)
 writeFileSync(resolve(artifacts,'resumed-decode.stderr'),replay.stderr + original.stderr)
 assert.equal(replay.status,0);assert.equal(original.status,0)
 assert.equal(replay.stderr.trim(),'');assert.equal(original.stderr.trim(),'')
 assert.deepEqual(hashes(replay.stdout),hashes(original.stdout),'RESUME remux changed decoded source frames')
 report.resumedDecodedFrames=hashes(replay.stdout).length
 report.resumedIdenticalDecodedFrames=true
}
if (existsSync(resolve(artifacts,'reference.mkv'))) {
 report.timing=[]
 for (const [originalName,replayName] of [['reference.mkv','replay.mp4'],['resumed-reference.mkv','resumed-replay.mp4']]) {
  const values=[originalName,replayName].map(name=>{
   const r=spawnSync('ffprobe',['-v','error','-show_packets','-show_streams','-select_streams','v:0','-of','json',resolve(artifacts,name)],{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:32*1024*1024})
   assert.equal(r.status,0);assert.equal(r.stderr.trim(),'')
   writeFileSync(resolve(artifacts,name+'.timing.json'),r.stdout)
   return JSON.parse(r.stdout)
  })
  assert.equal(values[0].streams[0].has_b_frames,0)
  assert.equal(values[1].streams[0].has_b_frames,0)
  const pts=values.map(v=>v.packets.map(p=>Number(p.pts_time)))
  assert.deepEqual(pts[1],pts[0],'remux changed native source presentation timestamps')
  report.timing.push({original:originalName,replay:replayName,samples:pts[0].length,exactPts:true})
 }
}

writeFileSync(resolve(artifacts,'decode-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
