const fs=require('fs'),http=require('http'),path=require('path'),crypto=require('crypto');
const {dds,exr,floats,root}=require('./acceptance.js');
const {openPage,sleep}=require(path.join(root,'scripts/cdp/cdp.js'));
const fixtures={
  '/mip.dds':Buffer.from(dds(41,2,1,floats([.1,.9,.5]),2)),
  '/good.exr':Buffer.from(exr().buffer),
  '/bad.dds':Buffer.from(dds(41,16,1,new Uint8Array(4))),
  '/alpha.dds':Buffer.from(dds(71,4,4,new Uint8Array([0,0,255,255,255,255,255,255]))),
  '/large.dds':Buffer.from(dds(28,2048,4,new Uint8Array(2048*4*4).fill(255)))
};
function bc6Constant(endpoint){let bits=3n;for(let i=0;i<6;i++)bits|=BigInt(endpoint)<<BigInt(5+10*i);return Uint8Array.from({length:16},(_,i)=>Number((bits>>BigInt(i*8))&255n));}
fixtures['/hdr-unsigned.dds']=Buffer.from(dds(95,4,4,bc6Constant(1023)));
fixtures['/hdr-signed.dds']=Buffer.from(dds(96,4,4,bc6Constant(513)));
const gpuFile=process.env.CODEC_GPU_FILE;
if(gpuFile){
  const input=fs.readFileSync(gpuFile);fixtures['/gpu.dds']=input;
  if([98,99].includes(input.readUInt32LE(128))){const srgb=Buffer.from(input);srgb.writeUInt32LE(99,128);fixtures['/gpu-srgb.dds']=srgb;}
  const native=require('child_process').spawnSync('python',['-c',`import sys,struct,texture2ddecoder as t
b=sys.stdin.buffer.read();h,w=struct.unpack_from('<II',b,12);dx=struct.unpack_from('<I',b,128)[0]
if dx in (98,99):
 p=bytearray(t.decode_bc7(b[148:],w,h));p[0::4],p[2::4]=p[2::4],p[0::4];sys.stdout.buffer.write(p)
`],{input,maxBuffer:32*1024*1024});
  if(native.status!==0)throw new Error(native.stderr.toString());
  fixtures['/gpu-ref.bin']=native.stdout;
}
function html(ui){
  const names=['worker-shared.js','dds-codec.js','dds-parser.js','exr-parser.js','color-remap.js','export-texture.js'];
  return '<!doctype html><html><head><meta charset="utf-8"></head><body>'+
    (ui?'<main class="post-content"><p><img id="mip" src="/mip.dds"></p><p><img id="exr" src="/good.exr"></p><p><img id="alpha" src="/alpha.dds"></p></main>':'')+
    names.filter(n=>fs.existsSync(path.join(root,'static/js',n))).map(n=>`<script src="/js/${n}"></script>`).join('')+
    (ui?'<script src="/js/image-viewer.js"></script>':'')+'</body></html>';
}
async function main(){
  let failures=0; const check=(name,ok)=>{console.log((ok?'PASS ':'FAIL ')+name);if(!ok)failures++;};
  const server=http.createServer((req,res)=>{
    const parsed=new URL(req.url,'http://localhost'),url=parsed.pathname;
    res.setHeader('Cache-Control','no-store');
    if(fixtures[url]){res.end(fixtures[url]);return;}
    if(url==='/js/decode-worker.js'&&parsed.searchParams.has('fault')){res.setHeader('Content-Type','text/javascript');res.end(parsed.searchParams.get('fault')==='silent'?'self.onmessage=function(){};':'throw new Error("acceptance worker load failure");');return;}
    if(url.endsWith('.json')){res.setHeader('Content-Type','application/json');res.end('{}');return;}
    if(url==='/ui'||url==='/'){res.setHeader('Content-Type','text/html');res.end(html(url==='/ui'));return;}
    if(url==='/cache'){res.setHeader('Content-Type','text/html');res.end(html(true).replace(/<main[\s\S]*?<\/main>/,'<main class="post-content"><p><img src="/large.dds"></p><div style="height:3000px"></div><p><img src="/large.dds"></p></main>'));return;}
    if(/^\/js\/[a-z0-9-]+\.js$/.test(url)) {const p=path.join(root,'static',url);if(fs.existsSync(p)){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(p));return;}}
    res.statusCode=404;res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  let page;
  try{
    page=await openPage(base+'/',{waitSelector:false});
    console.log('ENV '+await page.evaluate(`JSON.stringify((()=>{const gl=document.createElement('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return{ua:navigator.userAgent,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'',bptc:!!gl.getExtension('EXT_texture_compression_bptc'),float:!!gl.getExtension('EXT_color_buffer_float')}})())`));
    const worker=JSON.parse(await page.evaluate(`(async()=>{const w=new Worker('/js/decode-worker.js');let id=0;async function run(url){const b=await(await fetch(url)).arrayBuffer();return new Promise(resolve=>{const timer=setTimeout(()=>resolve({timeout:true}),3000);w.onmessage=e=>{clearTimeout(timer);const r=e.data;resolve({ok:r.ok,w:r.w,h:r.h,pixel:r.pixels?Array.from(r.pixels.slice(0,4)):null,error:r.error});};w.onerror=e=>{clearTimeout(timer);resolve({uncaught:e.message});};w.postMessage({id:++id,type:url.endsWith('.exr')?'exr':'dds',buffer:b});});}try{return JSON.stringify({valid:await run('/alpha.dds'),invalid:await run('/bad.dds'),recovered:await run('/good.exr')});}finally{w.terminate();}})()`));
    console.log('WORKER '+JSON.stringify(worker));check('real Worker BC1 alpha',worker.valid.ok&&worker.valid.pixel[3]===0);check('real Worker malformed request settles',worker.invalid.ok===false);check('real Worker handles next EXR request',worker.recovered.ok&&worker.recovered.pixel[3]===255);
    for(const [url,expected] of [['/hdr-unsigned.dds',65504],['/hdr-signed.dds',-65504]]){
      const hdr=JSON.parse(await page.evaluate(`(async()=>{const d=DDS.parse(await(await fetch('${url}')).arrayBuffer()),f=d?.getFrame?d.getFrame(0):null,raw=f?.rawPixels||d?.getMip(0);return JSON.stringify({hasFrame:!!f,first:raw instanceof Float32Array?Array.from(raw.slice(0,4)):null,pixels:f?.pixels?Array.from(f.pixels.slice(0,4)):null});})()`));
      check('BC6H '+url+' exposes coherent frame API',hdr.hasFrame);
      console.log('HDR '+url+' '+JSON.stringify(hdr));check('BC6H '+url+' preserves spec endpoint',hdr.first?.[0]===expected&&hdr.first?.[1]===expected&&hdr.first?.[2]===expected&&hdr.first?.[3]===1);
    }
    if(gpuFile){const gpu=JSON.parse(await page.evaluate(`(async()=>{const b=await(await fetch('/gpu.dds')).arrayBuffer(),d=DDS.parse(b),f=d.getFrame?d.getFrame(0):null,p=f?f.pixels:d.getMip(0),ref=new Uint8Array(await(await fetch('/gpu-ref.bin')).arrayBuffer());let maxError=0,flippedMaxError=0,sum=0,rawMin=Infinity,rawMax=-Infinity;for(let i=0;i<p.length&&i<ref.length;i++){const e=Math.abs(p[i]-ref[i]);maxError=Math.max(maxError,e);sum+=e;const row=Math.floor(i/(d.w*4)),x=i%(d.w*4);flippedMaxError=Math.max(flippedMaxError,Math.abs(p[i]-ref[(d.h-1-row)*d.w*4+x]));}if(f?.rawPixels)for(let i=0;i<f.rawPixels.length;i++)if(i%4!==3){rawMin=Math.min(rawMin,f.rawPixels[i]);rawMax=Math.max(rawMax,f.rawPixels[i]);}return JSON.stringify({fmt:d.fmt,w:d.w,h:d.h,maxError,flippedMaxError,meanError:sum/ref.length,referenceBytes:ref.length,rawMin,rawMax,normMin:f?.normMin,normMax:f?.normMax});})()`));console.log('GPU '+JSON.stringify(gpu));if(gpu.referenceBytes)check('BC7 RGBA matches independent native decoder',gpu.maxError<=1);else check('BC6H preserves values above one',gpu.rawMax>1);}
    if(fixtures['/gpu-srgb.dds']){
      const srgb=JSON.parse(await page.evaluate(`(async()=>{const d=DDS.parse(await(await fetch('/gpu-srgb.dds')).arrayBuffer()),p=d.getMip(0),r=new Uint8Array(await(await fetch('/gpu-ref.bin')).arrayBuffer());let e=0;for(let i=0;i<r.length;i++)e=Math.max(e,Math.abs(p[i]-r[i]));return JSON.stringify({maxError:e})})()`));
      console.log('SRGB '+JSON.stringify(srgb));check('BC7 SRGB retains encoded display values consistently with BC1-5',srgb.maxError<=1);
    }
    await page.send('Page.navigate',{url:base+'/ui'});
    for(let i=0;i<40;i++){if(await page.evaluate("document.querySelectorAll('.channel-canvas').length >= 3"))break;await sleep(100);}
    console.log('UI '+await page.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.channel-container')).map(e=>({img:e.querySelector('img')?.id,canvas:[e.querySelector('canvas')?.width,e.querySelector('canvas')?.height],sliders:Array.from(e.querySelectorAll('input[type=range]')).map(s=>({title:s.title,min:s.min,max:s.max,value:s.value,context:s.parentElement.textContent}))})))`));
    const mip=JSON.parse(await page.evaluate(`JSON.stringify((()=>{const e=document.querySelectorAll('.channel-container')[0];const m=Array.from(e.querySelectorAll('input[type=range]')).find(s=>s.parentElement.textContent.includes('Lv.'));if(!m)return{error:'no mip slider'};m.value=1;m.dispatchEvent(new Event('input',{bubbles:true}));const lo=e.querySelector('input[title="Black point (Lo)"]'),hi=e.querySelector('input[title="White point (Hi)"]');lo.value=0;lo.dispatchEvent(new Event('input',{bubbles:true}));hi.value=.5;hi.dispatchEvent(new Event('input',{bubbles:true}));e.querySelector('[data-ch="R"]').click();const cv=e.querySelector('canvas');return{w:cv.width,h:cv.height,pixel:Array.from(cv.getContext('2d').getImageData(0,0,1,1).data),range:[lo.min,hi.max,lo.value,hi.value]};})())`));console.log('MIP '+JSON.stringify(mip));check('mip change uses current raw pixels for remapping',mip.w===1&&mip.h===1&&mip.pixel[0]===255);
    console.log('ALPHA '+await page.evaluate(`JSON.stringify((()=>{const e=document.querySelectorAll('.channel-container')[2];e.querySelector('[data-ch="A"]').click();return Array.from(e.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data)})())`));
    await page.send('Page.navigate',{url:base+'/cache'});
    for(let i=0;i<40;i++){if(await page.evaluate("document.querySelectorAll('.channel-container').length >= 1"))break;await sleep(100);}
    await page.evaluate('window.scrollTo(0,document.body.scrollHeight)');
    for(let i=0;i<40;i++){if(await page.evaluate("document.querySelectorAll('.channel-container canvas').length >= 2"))break;await sleep(100);}
    const cache=JSON.parse(await page.evaluate("JSON.stringify(Array.from(document.querySelectorAll('.channel-container canvas')).map(c=>[c.width,c.height]))"));console.log('CACHE '+JSON.stringify(cache));check('cached preview preserves sampled dimensions',cache.length===2&&cache[0][0]<2048&&cache[1][0]===cache[0][0]&&cache[1][1]===cache[0][1]);
    await page.close();page=null;
    for(const fault of ['constructor','load','silent']){
      const code=fault==='constructor'?'window.Worker=function(){throw new Error("acceptance unavailable worker")};':`{const Native=window.Worker;window.Worker=function(url,options){const u=new URL(url,location.href);u.searchParams.set("fault","${fault}");return new Native(u,options)}}`;
      page=await openPage(base+'/ui',{waitSelector:false,initScript:code});
      for(let i=0;i<(fault==='silent'?180:30);i++){if(await page.evaluate("document.querySelectorAll('.channel-canvas').length >= 3"))break;await sleep(100);}
      const settled=await page.evaluate("document.querySelectorAll('.channel-canvas').length");console.log('FAULT '+fault+' settled='+settled);check('Worker '+fault+' failure settles all images',settled===3);
      await page.close();page=null;
    }
    console.log('HASHES '+JSON.stringify(Object.fromEntries(Object.entries(fixtures).map(([k,v])=>[k,crypto.createHash('sha256').update(v).digest('hex')]))));
    console.log('SOURCE_HASHES '+JSON.stringify(Object.fromEntries(['worker-shared.js','dds-codec.js','dds-parser.js','exr-parser.js','decode-worker.js','image-viewer.js','color-remap.js'].filter(n=>fs.existsSync(path.join(root,'static/js',n))).map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'static/js',n))).digest('hex')]))));
    console.log(JSON.stringify({failures,time:new Date().toISOString()}));if(failures)process.exitCode=1;
  }finally{if(page)await page.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
