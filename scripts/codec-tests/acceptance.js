const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const cp = require('child_process'), crypto = require('crypto');
const root = path.resolve(__dirname, '../..');
const sourceHashes={};
function context() {
  const c = {console,ArrayBuffer,SharedArrayBuffer}; c.self = c; c.window = c; vm.createContext(c);
  for (const f of ['worker-shared.js', 'dds-codec.js', 'dds-parser.js', 'exr-parser.js', 'color-remap.js']) {
    const p = path.join(root, 'static/js', f);
    let source;
    if(process.env.CODEC_BASELINE){
      if(f==='dds-codec.js')continue;
      source=cp.execFileSync('git',['show','a67d136959ccbe6c188e0a6cabf2e7e2c88f632a:static/js/'+f],{cwd:root,encoding:'utf8',maxBuffer:2**20});
    }else if(fs.existsSync(p))source=fs.readFileSync(p,'utf8');
    if(source){sourceHashes[f]=crypto.createHash('sha256').update(source).digest('hex');vm.runInContext(source, c, {filename:f});}
  }
  return c;
}
function dds(dxgi, w, h, payload, mips = 1, arraySize = 1) {
  const a = new ArrayBuffer(148 + payload.length), v = new DataView(a), b = new Uint8Array(a);
  b.set([68,68,83,32]); b.set([68,88,49,48],84);
  for (const [o,n] of [[4,124],[8,0x2100f],[12,h],[16,w],[20,w*4],[28,mips],[76,32],[80,4],[108,mips>1?0x401008:0x1000],[128,dxgi],[132,3],[140,arraySize]]) v.setUint32(o,n,true);
  b.set(payload,148); return a;
}
function floats(values) { return new Uint8Array(new Float32Array(values).buffer); }
function indices3(values) {
  let n=0n; values.forEach((v,i)=>n|=BigInt(v)<<BigInt(i*3));
  return Array.from({length:6},(_,i)=>Number((n>>BigInt(i*8))&255n));
}
const z=s=>Buffer.from(s+'\0'), u=n=>{const b=Buffer.alloc(4);b.writeInt32LE(n);return b;};
const f=n=>{const b=Buffer.alloc(4);b.writeFloatLE(n);return b;};
const cat=(...a)=>Buffer.concat(a), attr=(n,t,b)=>cat(z(n),z(t),u(b.length),b);
function exr(y=0, names=['B','G','R'], rows=[[.25,.5,1]], options={}) {
  const types=options.types||names.map(()=>2);
  const ch=cat(...names.map((n,i)=>cat(z(n),u(types[i]),Buffer.alloc(4),u(1),u(1))),Buffer.alloc(1));
  const box=cat(u(0),u(y),u(0),u(y+rows.length-1));
  const header=cat(Buffer.from([0x76,0x2f,0x31,0x01]),u(options.version||2),attr('channels','chlist',ch),attr('compression','compression',Buffer.from([0])),attr('dataWindow','box2i',box),attr('displayWindow','box2i',box),attr('lineOrder','lineOrder',Buffer.from([0])),attr('pixelAspectRatio','float',f(1)),attr('screenWindowCenter','v2f',cat(f(0),f(0))),attr('screenWindowWidth','float',f(1)),Buffer.alloc(1));
  const chunks=rows.map((values,i)=>{
    const data=cat(...values.map((v,j)=>types[j]===2?f(v):types[j]===0?u(v):Buffer.from([v&255,v>>>8])));
    return cat(u(y+i),u(data.length),data);
  });
  let offset=header.length+rows.length*8; const offsets=[];
  const order=options.reverse?chunks.map((_,i)=>i).reverse():chunks.map((_,i)=>i);
  for(const i of order){offsets[i]=offset;offset+=chunks[i].length;}
  const b=cat(header,...offsets.map(n=>cat(u(n),u(0))),...order.map(i=>chunks[i]));
  return {buffer:b.buffer.slice(b.byteOffset,b.byteOffset+b.length),offset:offsets[0],headerLength:header.length};
}
function run() {
  const c=context(), S=c.ImageCodecShared; let failed=0, passed=0;
  const test=(name,fn)=>{try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}};
  const first=(data,dxgi)=>Array.from(S.decodeBC(data,4,4,{fourCC:'DX10',dxgi,type:S.DXGI_MAP[dxgi],family:S.fmtFamily(S.DXGI_MAP[dxgi]),isComp:true}).slice(0,4));
  test('BC1 transparent black survives dispatch',()=>{const d=new Uint8Array([0,0,255,255,255,255,255,255]);assert.deepEqual(first(d,71),[0,0,0,0]);});
  test('BC2 retains explicit zero alpha',()=>{const d=new Uint8Array(16);d[9]=248;assert.deepEqual(first(d,74),[255,0,0,0]);});
  test('BC2 uses four colors for ascending endpoints',()=>{const d=new Uint8Array(16).fill(255);d[8]=d[9]=0;assert.deepEqual(first(d,74),[170,170,170,255]);});
  test('BC3 uses four colors for ascending endpoints',()=>{const d=new Uint8Array(16);d[0]=255;d[10]=d[11]=255;d.fill(255,12);assert.deepEqual(first(d,77),[170,170,170,255]);});
  test('BC4 SNORM all indices including cross-byte boundary',()=>{
    const ids=Array.from({length:16},(_,i)=>i%8),d=Uint8Array.from([129,127,...indices3(ids)]);
    const actual=S.decodeBC(d,4,4,{fourCC:'BC4S',dxgi:81,type:'BC4_SNORM',isComp:true,family:'BC4'}), expected=[0,255,51,102,153,204,0,255];
    ids.forEach((n,i)=>assert.ok(Math.abs(actual[i*4]-expected[n])<=1,`${i}: ${actual[i*4]} != ${expected[n]}`));
  });
  test('BC5 SNORM R and G interpolate independently',()=>{const d=Uint8Array.from([129,127,...indices3(Array(16).fill(2)),129,127,...indices3(Array(16).fill(5))]);assert.deepEqual(first(d,84),[51,204,0,255]);});
  test('DDS complete BC1 accepted; truncated payload rejected',()=>{
    assert.ok(c.DDS.parse(dds(71,4,4,new Uint8Array(8))));
    let rejected=false;try{const p=c.DDS.parse(dds(71,4,4,new Uint8Array(7)));rejected=!p||!p.getMip(0);}catch(_){rejected=true;}assert.ok(rejected);
  });
  test('DDS zero width rejected',()=>{let p;try{p=c.DDS.parse(dds(71,0,4,new Uint8Array(8)));}catch(_){return;}assert.ok(!p);});
  test('DDS BC2 TYPELESS decodes explicit alpha',()=>{const d=new Uint8Array(16);d[9]=248;const p=c.DDS.parse(dds(73,4,4,d));assert.deepEqual(Array.from(p.getMip(0).slice(0,4)),[255,0,0,0]);});
  test('DDS unknown DXGI rejected rather than raw-copy success',()=>{assert.ok(!c.DDS.parse(dds(999,1,1,new Uint8Array([1,2,3,255]))));});
  test('float range remapping preserves linear alpha',()=>{const src=new Uint8ClampedArray([155,155,155,128]),raw=new Float32Array([.5,.5,.5,.5]);assert.deepEqual(Array.from(c.ColorRemap.remapPixels(src,0,.5,0,1,raw)),[255,255,255,128]);});
  test('EXR RGB defaults alpha to one',()=>assert.deepEqual(Array.from(c.EXR.parse(exr().buffer).pixels),[1,.5,.25,1]));
  test('EXR single Z channel remains visible as grayscale',()=>assert.deepEqual(Array.from(c.EXR.parse(exr(0,['Z'],[[.25]]).buffer).pixels),[.25,.25,.25,1]));
  test('EXR offset-table collision cannot become scanline',()=>{const a=exr();assert.deepEqual(Array.from(c.EXR.parse(exr(a.offset).buffer).pixels),[1,.5,.25,1]);});
  test('EXR negative dataWindow and reversed physical chunks',()=>{
    const p=c.EXR.parse(exr(-3,['B','G','R'],[[.25,.5,1],[1,.5,.25]],{reverse:true}).buffer);
    assert.deepEqual(Array.from(p.pixels),[1,.5,.25,1,.25,.5,1,1]);
  });
  test('EXR alpha is linear coverage',()=>{const out=c.EXR.toRGBA8({w:2,h:1,pixels:new Float32Array([1,1,1,1,1,1,1,.5])});assert.deepEqual([out[3],out[7]],[255,128]);});
  test('EXR retains independent RGB tone mapping and brightness',()=>{
    const p=c.EXR.toRGBA8({w:3,h:1,pixels:new Float32Array([1,.5,.25,1,.5,.5,.5,1,.1,.1,.1,1])});
    assert.deepEqual(Array.from(p.slice(0,8)),[186,155,123,255,155,155,155,255]);assert.ok(p[8]<p[4]);
  });
  test('EXR HALF RGB values and opaque default',()=>assert.deepEqual(Array.from(c.EXR.parse(exr(0,['B','G','R'],[[0x3400,0x3800,0x3c00]],{types:[1,1,1]}).buffer).pixels),[1,.5,.25,1]));
  test('EXR unsupported tiled flag rejected',()=>{let p;try{p=c.EXR.parse(exr(0,undefined,undefined,{version:514}).buffer);}catch(_){return;}assert.ok(!p);});
  test('EXR truncated chunk rejected',()=>{const a=exr().buffer;let p;try{p=c.EXR.parse(a.slice(0,a.byteLength-1));}catch(_){return;}assert.ok(!p);});
  console.log(JSON.stringify({passed,failed,environment:process.version,platform:process.platform,baseline:!!process.env.CODEC_BASELINE,sourceHashes,time:new Date().toISOString()}));process.exitCode=failed?1:0;
}
module.exports={context,dds,exr,floats,root};
if(require.main===module)run();
