const fs=require('fs'),path=require('path'),vm=require('vm'),cp=require('child_process'),crypto=require('crypto');
const {context,root}=require('./acceptance.js');
const before={console};before.self=before;vm.createContext(before);
for(const name of ['worker-shared.js','dds-parser.js','exr-parser.js'])vm.runInContext(cp.execFileSync('git',['show','a67d136959ccbe6c188e0a6cabf2e7e2c88f632a:static/js/'+name],{cwd:root,encoding:'utf8',maxBuffer:2**20}),before);
const current=context(), results=[], regressions=[], unsupported=[];
const sourceHashes=Object.fromEntries(['worker-shared.js','dds-codec.js','dds-parser.js','exr-parser.js'].filter(n=>fs.existsSync(path.join(root,'static/js',n))).map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'static/js',n))).digest('hex')]));
const isExr=process.argv.includes('--exr'), type=isExr?'EXR':'DDS';
function visit(dir){for(const f of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())visit(p);else if(p.endsWith(isExr?'.exr':'.dds')){
  const b=fs.readFileSync(p),ab=b.buffer.slice(b.byteOffset,b.byteOffset+b.length),old=before[type].parse(ab);let now,error;
  try{now=current[type].parse(ab);}catch(e){error=e.message;}
  const info={path:path.relative(root,p),bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),format:old?.fmt?.type,size:old?[old.w,old.h]:null,oldMips:old?.mips,newMips:now?.mips,error};
  if(old&&!now)regressions.push(info);
  if(isExr&&old&&now&&!Buffer.from(old.pixels.buffer).equals(Buffer.from(now.pixels.buffer)))regressions.push({...info,error:'raw pixel output changed'});
  if(!old&&!now)unsupported.push(info);
  results.push(info);
}}}
visit(path.join(root,'content/local'));
console.log(JSON.stringify({time:new Date().toISOString(),environment:process.version,platform:process.platform,sourceHashes,type,total:results.length,regressions,unsupported,formats:[...new Set(results.map(x=>x.format))],inputs:results},null,2));
if(regressions.length)process.exitCode=1;
