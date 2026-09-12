const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {execFileSync} = require('node:child_process');
const root = "C:\\_WorktreeArchive\\Herder-2026-09-12\\worktrees\\job_01M21Z4M10PGMW2N12MNTC3EN3";
const dir = __dirname;
fs.writeFileSync(path.join(dir,'node-ready.json'),JSON.stringify({pid:process.pid,parentPid:process.ppid,execPath:process.execPath,time:new Date().toISOString()},null,2));
(async()=>{
 const deadline=Date.now()+600000;
 while(!fs.existsSync(path.join(dir,'allow-field'))) { if(Date.now()>deadline || fs.existsSync(path.join(dir,'stop'))) process.exit(2); await new Promise(r=>setTimeout(r,250)); }
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
 if(head!=='fb982677c96d6d365ea06bd1d1a2d430b09873dc') throw new Error('HEAD changed');
 const dirty=execFileSync('git',['diff','HEAD','--','core'],{cwd:root,encoding:'utf8',windowsHide:true});
 if(dirty.trim()) throw new Error('Product source dirty');
 process.chdir(path.join(root,'core'));
 const entry=path.join(root,'core','scripts','dxgi-replay-ab-field-check.mjs');
 process.argv=[process.execPath,entry,'--trials=3','--fps=15','--duration-seconds=30','--target=primary','--artifacts-dir='+path.join(dir,'artifacts')];
 process.env.CAPTUREPACK_DESKTOP_INTERACTIVE='1';
 fs.writeFileSync(path.join(dir,'invocation.json'),JSON.stringify({head,argv:process.argv,cwd:process.cwd(),time:new Date().toISOString()},null,2));
 await import(pathToFileURL(entry).href);
})().catch(e=>{console.error(e);process.exitCode=1;});
