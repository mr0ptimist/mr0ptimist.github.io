const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const dir=path.join(__dirname,'../static/js');
function context(worker){const c={console,ArrayBuffer,SharedArrayBuffer,Uint8Array,Uint8ClampedArray,Float32Array};c.self=c;c.window=c;c.location={href:'http://local/js/decode-worker.js'};vm.createContext(c);
c.importScripts=(...urls)=>urls.forEach(u=>vm.runInContext(fs.readFileSync(path.join(dir,u.split('/').pop().split('?')[0]),'utf8'),c));
c.importScripts(...(worker?['decode-worker.js']:['worker-shared.js','dds-codec.js','dds-parser.js']));return c;}
const main=context(false),worker=context(true);let count=0;
function test(name,fn){fn();count++;console.log('PASS '+name);}
function dds(dx,w,h,data,mips=1,array=1){const b=new ArrayBuffer(148+data.length),v=new DataView(b),u=new Uint8Array(b);u.set([68,68,83,32]);u.set([68,88,49,48],84);for(const [p,n]of [[4,124],[8,0x2100f],[12,h],[16,w],[28,mips],[76,32],[80,4],[128,dx],[132,3],[140,array]])v.setUint32(p,n,true);u.set(data,148);return b;}
const floats=a=>new Uint8Array(new Float32Array(a).buffer);
function decode(buffer,extra={}){let r;worker.postMessage=x=>r=x;worker.onmessage({data:{id:17,type:'dds',buffer,...extra}});assert.ok(r);assert.equal(r.id,17);return r;}
test('unsigned header masks',()=>assert.equal(main.ImageCodecShared.r32(new Uint8Array([0,0,0,255]),0),0xff000000));
test('legacy RGBA mask detection',()=>{const b=new Uint8Array(128),v=new DataView(b.buffer);for(const [p,n]of [[88,32],[92,255],[96,65280],[100,16711680],[104,4278190080]])v.setUint32(p,n,true);assert.equal(main.ImageCodecShared.detectFmt(b).family,'RGBA8');});
test('array and mip frame offsets',()=>{const p=main.DDS.parse(dds(41,2,1,floats([.1,.9,.5,.2,.8,.75]),2,2));assert.ok(p);assert.equal(p.getFrame(1,1).rawPixels[0],.75);assert.equal(p.getFrame(1,0).rawPixels[0],.5);assert.equal(p.getFrame(-1),null);assert.equal(p.getFrame(0,2),null);});
test('RGBA float alpha remains linear',()=>{const f=main.DDS.parse(dds(2,1,1,floats([2,1,.5,.25]))).getFrame(0);assert.equal(f.pixels[3],64);assert.deepEqual(Array.from(f.rawPixels),[2,1,.5,.25]);});
test('RGB9E5 raw shared exponent includes mantissa scale',()=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,(16<<27)|256|(128<<9)|(64<<18),true);assert.deepEqual(Array.from(main.DDS.parse(dds(67,1,1,b)).getFrame(0).rawPixels),[1,.5,.25,1]);});
test('worker and page share sampled pixels and floats',()=>{const a=Float32Array.from({length:2048},(_,i)=>i/100),b=dds(41,2048,1,new Uint8Array(a.buffer)),r=decode(b,{targetDim:1000}),f=main.DDS.parse(b).getFrame(0,0,3);assert.equal(r.ok,true);assert.equal(r.w,683);assert.deepEqual(Array.from(r.pixels),Array.from(f.pixels));assert.deepEqual(Array.from(r.rawPixels),Array.from(f.rawPixels));});
test('truncated DX10 payload never treated as pixels',()=>{const b=dds(28,8,1,new Uint8Array(12));assert.equal(main.DDS.parse(b),null);assert.equal(decode(b).ok,false);});
test('truncated later array rejected',()=>assert.equal(main.DDS.parse(dds(41,1,1,floats([1]),1,2)),null));
test('unknown and short inputs fail then worker recovers',()=>{for(const b of [new ArrayBuffer(0),new ArrayBuffer(127),dds(999,1,1,new Uint8Array(4))])assert.equal(decode(b).ok,false);assert.equal(decode(dds(28,1,1,new Uint8Array([1,2,3,4]))).ok,true);});
test('packed odd-width rows remain separate',()=>{const f=main.DDS.parse(dds(68,1,2,new Uint8Array([10,20,30,40,50,60,70,80]))).getFrame(0);assert.deepEqual(Array.from(f.pixels),[10,20,30,255,50,60,70,255]);});
test('GPU failure is not a successful purple image',()=>{const p=main.DDS.parse(dds(98,4,4,new Uint8Array(16)));assert.ok(p);assert.equal(p.getMip(0),null);assert.ok(main.DDS.lastError);});
console.log(count+' shared codec/Worker tests passed');
