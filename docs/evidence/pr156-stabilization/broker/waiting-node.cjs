const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
fs.writeFileSync(path.join(dir, 'node-ready.json'), JSON.stringify({pid:process.pid,parentPid:process.ppid,execPath:process.execPath,time:new Date().toISOString()}, null, 2));
const timer = setInterval(() => { if(fs.existsSync(path.join(dir,'stop-probe'))) {clearInterval(timer);process.exit(0);} }, 250);
setTimeout(()=>process.exit(2),600000);
