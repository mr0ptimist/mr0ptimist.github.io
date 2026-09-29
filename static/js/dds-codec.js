// Shared DDS container and CPU decoding for the page and Worker.
(function () {
  var S = self.ImageCodecShared;
  if (!S) throw new Error('ImageCodecShared not loaded');
  var api = {lastError: null};
  function fail(message) { api.lastError = message; return null; }
  function mipSize(w, h, fmt) {
    if (fmt.isComp) return Math.ceil(w/4)*Math.ceil(h/4)*((fmt.family==='BC1'||fmt.family==='BC4')?8:16);
    if (fmt.family==='RGBG'||fmt.family==='GRGB') return Math.ceil(w/2)*4*h;
    return w*h*fmt.bpp/8;
  }
  function parse(buf) {
    api.lastError = null;
    try {
      var view = new Uint8Array(buf);
      if (view.length<128 || S.str4(view,0)!=='DDS ' || S.r32(view,4)!==124 || S.r32(view,76)!==32) return fail('Invalid DDS header');
      var dx10=S.str4(view,84)==='DX10', dataOff=dx10?148:128;
      if(view.length<dataOff) return fail('Truncated DX10 header');
      var w=S.r32(view,16), h=S.r32(view,12), flags=S.r32(view,8), caps2=S.r32(view,112);
      var depth=Math.max(1,S.r32(view,24)), resDim=dx10?S.r32(view,132):((flags&0x800000||caps2&0x200000)?4:3);
      var arraySize=dx10?S.r32(view,140):1, misc=dx10?S.r32(view,136):0;
      if(!w||!h||w>16384||h>16384||depth>16384||!arraySize||arraySize>4096||resDim<2||resDim>4) return fail('Unsupported DDS dimensions');
      if(resDim===2&&h!==1 || resDim===4&&(arraySize!==1||misc&4)) return fail('Invalid DDS resource layout');
      if(resDim!==4) depth=1;
      if(misc&4) arraySize*=6;
      else if(!dx10&&(caps2&0x200)) {
        arraySize=0;
        for(var bit=0;bit<6;bit++) if(caps2&(0x400<<bit)) arraySize++;
        if(!arraySize) return fail('Cubemap has no faces');
      }
      var fmt=S.detectFmt(view);
      var families=['BC1','BC2','BC3','BC4','BC5','BC6H','BC7','RGBG','GRGB','RGBA8','BGRA8','R10G10B10A2','R11G11B10','RGB9E5','R8G8','R8G8S','R8','R8S','R16G16','R16G16F','R16','R16F','D32S8','R32F','RGBA16','RGBA64F','RGBA128F','RGB96F','R32G32F','D24S8','RGBA8S','RGBA16S','R16G16S','R16S','B5G6R5','B5G5R5A1','ARGB4'];
      if(families.indexOf(fmt.family)<0 || !fmt.isComp&&!fmt.bpp) return fail('Unsupported DDS format: '+fmt.type);
      var mips=S.r32(view,28)||1, maxMips=Math.floor(Math.log2(Math.max(w,h,depth)))+1;
      if(mips>maxMips) return fail('Invalid mip count');
      var mipList=[], off=dataOff;
      for(var n=0;n<mips;n++) {
        var mw=Math.max(1,w>>n), mh=Math.max(1,h>>n), md=Math.max(1,depth>>n), bytes=mipSize(mw,mh,fmt), size=bytes*md;
        if(!Number.isSafeInteger(size)||size<=0||off+size>view.length) return fail('Truncated DDS mip payload');
        mipList.push({off:off,size:size,w:mw,h:mh,depth:md,sliceSize:bytes}); off+=size;
      }
      var faceByteSize=off-dataOff;
      if(dataOff+faceByteSize*arraySize>view.length) return fail('Truncated DDS array payload');
      return {w:w,h:h,mips:mips,fmt:fmt,raw:view,mipList:mipList,arraySize:arraySize,faceByteSize:faceByteSize,resDim:resDim,depth:depth,alphaMode:dx10?S.r32(view,144)&7:0};
    } catch(e) { return fail('DDS parse failed: '+e.message); }
  }
  function slice(dds,n,s) {
    n=n===undefined?0:n; s=s===undefined?0:s;
    if(!Number.isInteger(n)||!Number.isInteger(s)||n<0||n>=dds.mips||s<0) return null;
    var m=dds.mipList[n];
    if(s>=(dds.resDim===4?m.depth:dds.arraySize)) return null;
    var off=m.off+s*(dds.resDim===4?m.sliceSize:dds.faceByteSize);
    return {w:m.w,h:m.h,fmt:dds.fmt,data:dds.raw.subarray(off,off+m.sliceSize)};
  }
  function fromRaw(raw,w,h,channels) {
    var lo=Infinity,hi=-Infinity;
    for(var i=0;i<raw.length;i+=4) for(var c=0;c<Math.min(3,channels||3);c++) {
      var v=raw[i+c]; if(isFinite(v)){lo=Math.min(lo,v);hi=Math.max(hi,v);}
    }
    if(!(hi>lo)){lo=Math.min(0,isFinite(lo)?lo:0);hi=Math.max(1,isFinite(hi)?hi:1);}
    var px=new Uint8ClampedArray(raw.length), range=hi-lo;
    for(var i=0;i<raw.length;i+=4) {
      for(var c=0;c<3;c++) px[i+c]=isFinite(raw[i+c])?(raw[i+c]-lo)/range*255:0;
      px[i+3]=isFinite(raw[i+3])?raw[i+3]*255:255;
    }
    return {w:w,h:h,pixels:px,rawPixels:raw,normMin:lo,normMax:hi};
  }
  var floatLayouts={R16F:[1,2],R32F:[1,4],D32S8:[1,4,8],R16G16F:[2,2],R32G32F:[2,4],RGBA64F:[4,2],RGBA128F:[4,4],RGB96F:[3,4]};
  function floatFrame(part,step) {
    var packed=part.fmt.family==='R11G11B10'||part.fmt.family==='RGB9E5';
    var lay=packed?[3,4,4]:floatLayouts[part.fmt.family];
    if(!lay) return null;
    var w=Math.ceil(part.w/step),h=Math.ceil(part.h/step),raw=new Float32Array(w*h*4);
    var dv=new DataView(part.data.buffer,part.data.byteOffset,part.data.byteLength), stride=lay[2]||lay[0]*lay[1];
    for(var y=0;y<h;y++) for(var x=0;x<w;x++) {
      var src=(y*step*part.w+x*step)*stride,dst=(y*w+x)*4;
      if(packed) {
        var p=dv.getUint32(src,true);
        if(part.fmt.family==='RGB9E5') {
          var scale=Math.pow(2,(p>>>27)-24);
          raw[dst]=(p&511)*scale;raw[dst+1]=((p>>>9)&511)*scale;raw[dst+2]=((p>>>18)&511)*scale;
        } else {
          raw[dst]=S.h2f_r11g11b10(p&2047);raw[dst+1]=S.h2f_r11g11b10((p>>>11)&2047);raw[dst+2]=S.h2f_r10(p>>>22);
        }
      } else for(var c=0;c<lay[0];c++) raw[dst+c]=lay[1]===2?S.halfToFloat(dv.getUint16(src+c*2,true)):dv.getFloat32(src+c*4,true);
      if(lay[0]===1) raw[dst+1]=raw[dst+2]=raw[dst];
      if(lay[0]<4) raw[dst+3]=1;
    }
    return fromRaw(raw,w,h,lay[0]);
  }
  var _rawF = null, _normMin = undefined, _normMax = undefined;

  function decodeDDS(dds, step) {
    var w = dds.w, h = dds.h, data = dds.data, fam = dds.fmt.family;
    step = step || 1;
    var outW = step > 1 ? Math.ceil(w / step) : w;
    var outH = step > 1 ? Math.ceil(h / step) : h;
    var px = new Uint8ClampedArray(outW * outH * 4);
    _rawF = null; _normMin = undefined; _normMax = undefined;

    if (step === 1) {
    if (fam==='RGBG') {
      for (var j=0;j<w*h;j+=2) {
        var si=j*2, r0=data[si], g0=data[si+1], b1=data[si+2], g1=data[si+3];
        px[j*4]=r0; px[j*4+1]=g0; px[j*4+2]=b1; px[j*4+3]=255;
        if (j+1<w*h) { px[(j+1)*4]=r0; px[(j+1)*4+1]=g1; px[(j+1)*4+2]=b1; px[(j+1)*4+3]=255; }
      } return px;
    }
    if (fam==='GRGB') {
      for (var j=0;j<w*h;j+=2) {
        var si=j*2, g0=data[si], r0=data[si+1], g1=data[si+2], b1=data[si+3];
        px[j*4]=r0; px[j*4+1]=g0; px[j*4+2]=b1; px[j*4+3]=255;
        if (j+1<w*h) { px[(j+1)*4]=r0; px[(j+1)*4+1]=g1; px[(j+1)*4+2]=b1; px[(j+1)*4+3]=255; }
      } return px;
    }
    if (fam==='RGBA8') { for (var j=0;j<px.length;j++) px[j]=data[j]; return px; }
    if (fam==='BGRA8') {
      var sw = dds.fmt.swizzle || 'bgra';
      for (var j=0;j<px.length;j+=4) {
        if (sw==='argb') { px[j]=data[j+1]; px[j+1]=data[j+2]; px[j+2]=data[j+3]; px[j+3]=data[j]; }
        else if (sw==='abgr') { px[j]=data[j+3]; px[j+1]=data[j+2]; px[j+2]=data[j+1]; px[j+3]=data[j]; }
        else { px[j]=data[j+2]; px[j+1]=data[j+1]; px[j+2]=data[j]; px[j+3]=data[j+3]; }
      }
      return px;
    }
    if (fam==='R10G10B10A2') {
      var s32 = new Uint32Array(data.buffer, data.byteOffset, w*h);
      for (var j=0;j<w*h;j++) { var p=s32[j]; px[j*4]=(p&0x3FF)*255/1023; px[j*4+1]=((p>>>10)&0x3FF)*255/1023; px[j*4+2]=((p>>>20)&0x3FF)*255/1023; px[j*4+3]=(p>>>30)*255/3; }
      if (dds.fmt.swapRB) { for (var j=0;j<px.length;j+=4) { var t=px[j]; px[j]=px[j+2]; px[j+2]=t; } }
      return px;
    }
    if (fam==='R11G11B10') {
      var s32b = new Uint32Array(data.buffer, data.byteOffset, w*h);
      for (var j=0;j<w*h;j++) {
        var p = s32b[j];
        var r = S.h2f_r11g11b10(p & 0x7FF);
        var g = S.h2f_r11g11b10((p >>> 11) & 0x7FF);
        var b = S.h2f_r10((p >>> 22) & 0x3FF);
        px[j*4]=Math.min(255,Math.max(0,r*255));
        px[j*4+1]=Math.min(255,Math.max(0,g*255));
        px[j*4+2]=Math.min(255,Math.max(0,b*255));
        px[j*4+3]=255;
      }
      return px;
    }
    if (fam==='R8G8') { for (var j=0;j<w*h;j++) { px[j*4]=data[j*2]; px[j*4+1]=data[j*2+1]; px[j*4+2]=0; px[j*4+3]=255; } return px; }
    if (fam==='R8G8S') {
      var fminR=1e9, fmaxR=-1e9, fminG=1e9, fmaxG=-1e9, n=w*h;
      for (var j=0;j<n;j++) {
        var sr = data[j*2] > 127 ? (data[j*2] - 256) / 127.0 : data[j*2] / 127.0;
        var sg = data[j*2+1] > 127 ? (data[j*2+1] - 256) / 127.0 : data[j*2+1] / 127.0;
        if (sr<fminR) fminR=sr; if (sr>fmaxR) fmaxR=sr;
        if (sg<fminG) fminG=sg; if (sg>fmaxG) fmaxG=sg;
      }
      var frR = fmaxR>fminR ? 255/(fmaxR-fminR) : 1;
      var frG = fmaxG>fminG ? 255/(fmaxG-fminG) : 1;
      for (var j=0;j<n;j++) {
        var sr = data[j*2] > 127 ? (data[j*2] - 256) / 127.0 : data[j*2] / 127.0;
        var sg = data[j*2+1] > 127 ? (data[j*2+1] - 256) / 127.0 : data[j*2+1] / 127.0;
        px[j*4]=(sr-fminR)*frR; px[j*4+1]=(sg-fminG)*frG; px[j*4+2]=0; px[j*4+3]=255;
      }
      return px;
    }
    if (fam==='R8') { for (var j=0;j<w*h;j++) { var v=data[j]; px[j*4]=v; px[j*4+1]=v; px[j*4+2]=v; px[j*4+3]=255; } return px; }
    if (fam==='R8S') {
      var fmin=1e9, fmax=-1e9, n=w*h;
      for (var j=0;j<n;j++) {
        var sv = data[j] > 127 ? (data[j] - 256) / 127.0 : data[j] / 127.0;
        if (sv<fmin) fmin=sv; if (sv>fmax) fmax=sv;
      }
      var fr = fmax>fmin ? 255/(fmax-fmin) : 1;
      for (var j=0;j<n;j++) {
        var sv = data[j] > 127 ? (data[j] - 256) / 127.0 : data[j] / 127.0;
        var vv = (sv-fmin)*fr;
        px[j*4]=vv; px[j*4+1]=vv; px[j*4+2]=vv; px[j*4+3]=255;
      }
      return px;
    }
    if (fam==='R16G16') {
      var s16 = new Uint16Array(data.buffer, data.byteOffset, w*h*2);
      for (var j=0;j<w*h;j++) { px[j*4]=s16[j*2]*255/65535; px[j*4+1]=s16[j*2+1]*255/65535; px[j*4+2]=0; px[j*4+3]=255; }
      return px;
    }

    if (fam==='R16') {
      var su = new Uint16Array(data.buffer, data.byteOffset, w*h);
      var mn=65535, mx=0;
      for (var j=0;j<su.length;j++) { if(su[j]<mn)mn=su[j]; if(su[j]>mx)mx=su[j]; }
      var rng = mx>mn ? 255/(mx-mn) : 1;
      _normMin = mn/65535; _normMax = mx/65535;
      for (var j=0;j<w*h;j++) { var vv=(su[j]-mn)*rng; px[j*4]=vv; px[j*4+1]=vv; px[j*4+2]=vv; px[j*4+3]=255; }
      return px;
    }



    if (fam==='RGBA16') {
      var u16w = new Uint16Array(data.buffer, data.byteOffset, w*h*4);
      for (var j=0;j<w*h;j++) { px[j*4]=u16w[j*4]*255/65535; px[j*4+1]=u16w[j*4+1]*255/65535; px[j*4+2]=u16w[j*4+2]*255/65535; px[j*4+3]=u16w[j*4+3]*255/65535; }
      return px;
    }

    if (fam==='RGB9E5') {
      var s32e = new Uint32Array(data.buffer, data.byteOffset, w*h);
      var emnR=1e9,emxR=-1e9,emnG=1e9,emxG=-1e9,emnB=1e9,emxB=-1e9;
      for (var j=0;j<w*h;j++) {
        var p=s32e[j], exp=(p>>>27)&0x1F, sc=Math.pow(2,exp-15);
        var r=(p&0x1FF)*sc, g=((p>>>9)&0x1FF)*sc, b=((p>>>18)&0x1FF)*sc;
        if(isFinite(r)){if(r<emnR)emnR=r;if(r>emxR)emxR=r;} if(isFinite(g)){if(g<emnG)emnG=g;if(g>emxG)emxG=g;} if(isFinite(b)){if(b<emnB)emnB=b;if(b>emxB)emxB=b;}
      }
      var erR=emxR>emnR?255/(emxR-emnR):1, erG=emxG>emnG?255/(emxG-emnG):1, erB=emxB>emnB?255/(emxB-emnB):1;
      _normMin=Math.min(emnR,emnG,emnB); _normMax=Math.max(emxR,emxG,emxB);
      for (var j=0;j<w*h;j++) {
        var p=s32e[j], exp=(p>>>27)&0x1F, sc=Math.pow(2,exp-15);
        px[j*4]=Math.min(255,Math.max(0,((p&0x1FF)*sc-emnR)*erR)); px[j*4+1]=Math.min(255,Math.max(0,(((p>>>9)&0x1FF)*sc-emnG)*erG)); px[j*4+2]=Math.min(255,Math.max(0,(((p>>>18)&0x1FF)*sc-emnB)*erB)); px[j*4+3]=255;
      }
      return px;
    }



    if (fam==='D24S8') {
      var s32d = new Uint32Array(data.buffer, data.byteOffset, w*h);
      for (var j=0;j<w*h;j++) { var d=(s32d[j]&0xFFFFFF)/0xFFFFFF*255; px[j*4]=d; px[j*4+1]=d; px[j*4+2]=d; px[j*4+3]=255; }
      return px;
    }
    if (fam==='RGBA8S') {
      for (var j=0;j<w*h;j++) {
        var sr=data[j*4]>127?(data[j*4]-256)/127.0:data[j*4]/127.0;
        var sg=data[j*4+1]>127?(data[j*4+1]-256)/127.0:data[j*4+1]/127.0;
        var sb=data[j*4+2]>127?(data[j*4+2]-256)/127.0:data[j*4+2]/127.0;
        var sa=data[j*4+3]>127?(data[j*4+3]-256)/127.0:data[j*4+3]/127.0;
        px[j*4]=(sr*0.5+0.5)*255; px[j*4+1]=(sg*0.5+0.5)*255;
        px[j*4+2]=(sb*0.5+0.5)*255; px[j*4+3]=(sa*0.5+0.5)*255;
      } return px;
    }
    if (fam==='RGBA16S') {
      var si16 = new Int16Array(data.buffer, data.byteOffset, w*h*4);
      for (var j=0;j<w*h;j++) {
        px[j*4]=(si16[j*4]/32767.0*0.5+0.5)*255;
        px[j*4+1]=(si16[j*4+1]/32767.0*0.5+0.5)*255;
        px[j*4+2]=(si16[j*4+2]/32767.0*0.5+0.5)*255;
        px[j*4+3]=(si16[j*4+3]/32767.0*0.5+0.5)*255;
      } return px;
    }
    if (fam==='R16G16S') {
      var si16g = new Int16Array(data.buffer, data.byteOffset, w*h*2);
      var fminR=1e9, fmaxR=-1e9, fminG=1e9, fmaxG=-1e9;
      for (var j=0;j<w*h;j++) { var fr=si16g[j*2]/32767.0, fg=si16g[j*2+1]/32767.0; if(fr<fminR)fminR=fr; if(fr>fmaxR)fmaxR=fr; if(fg<fminG)fminG=fg; if(fg>fmaxG)fmaxG=fg; }
      var rr=fmaxR>fminR?255/(fmaxR-fminR):1, rg=fmaxG>fminG?255/(fmaxG-fminG):1;
      for (var j=0;j<w*h;j++) { px[j*4]=(si16g[j*2]/32767.0-fminR)*rr; px[j*4+1]=(si16g[j*2+1]/32767.0-fminG)*rg; px[j*4+2]=0; px[j*4+3]=255; }
      return px;
    }
    if (fam==='R16S') {
      var si16v = new Int16Array(data.buffer, data.byteOffset, w*h);
      var fmin=1e9, fmax=-1e9;
      for (var j=0;j<si16v.length;j++) { var v=si16v[j]/32767.0; if(v<fmin)fmin=v; if(v>fmax)fmax=v; }
      var rr=fmax>fmin?255/(fmax-fmin):1;
      for (var j=0;j<w*h;j++) { var vv=(si16v[j]/32767.0-fmin)*rr; px[j*4]=vv; px[j*4+1]=vv; px[j*4+2]=vv; px[j*4+3]=255; }
      return px;
    }
    if (fam==='B5G6R5') {
      var su16b = new Uint16Array(data.buffer, data.byteOffset, w*h);
      for (var j=0;j<w*h;j++) { var p=su16b[j]; px[j*4]=((p>>>11)&0x1F)*255/31; px[j*4+1]=((p>>>5)&0x3F)*255/63; px[j*4+2]=(p&0x1F)*255/31; px[j*4+3]=255; }
      return px;
    }
    if (fam==='B5G5R5A1') {
      var su16a = new Uint16Array(data.buffer, data.byteOffset, w*h);
      for (var j=0;j<w*h;j++) { var p=su16a[j]; px[j*4]=((p>>>10)&0x1F)*255/31; px[j*4+1]=((p>>>5)&0x1F)*255/31; px[j*4+2]=(p&0x1F)*255/31; px[j*4+3]=(p>>>15)?255:0; }
      return px;
    }
    if (fam==='ARGB4') {
      var su16c = new Uint16Array(data.buffer, data.byteOffset, w*h);
      for (var j=0;j<w*h;j++) { var p=su16c[j]; px[j*4+3]=(p>>>12)&0xF; px[j*4]=((p>>>8)&0xF)*17; px[j*4+1]=((p>>>4)&0xF)*17; px[j*4+2]=(p&0xF)*17; px[j*4+3]*=17; }
      return px;
    }

    // BC1-5 software decode (worker-safe)
    if (fam==='BC1'||fam==='BC3'||fam==='BC4'||fam==='BC5') {
      return S.decodeBC(data, w, h, dds.fmt);
    }

    // BC6H/BC7: no WebGL in worker → return null
    if (fam==='BC6H'||fam==='BC7') return null;

    // Fallback: raw copy for unrecognized uncompressed formats (e.g. R32_UINT)
    for (var j=0;j<Math.min(px.length,data.length);j++) px[j]=data[j];
    return px;
    } // end if (step === 1)

    // === step > 1: subsampled decode ===

    if (fam==='RGBA8') {
      for (var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=(oy*step*w+ox*step)*4,di=(oy*outW+ox)*4;
        px[di]=data[si];px[di+1]=data[si+1];px[di+2]=data[si+2];px[di+3]=data[si+3];
      } return px;
    }
    if (fam==='BGRA8') {
      var sw=dds.fmt.swizzle||'bgra';
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=(oy*step*w+ox*step)*4,di=(oy*outW+ox)*4;
        if(sw==='argb'){px[di]=data[si+1];px[di+1]=data[si+2];px[di+2]=data[si+3];px[di+3]=data[si];}
        else if(sw==='abgr'){px[di]=data[si+3];px[di+1]=data[si+2];px[di+2]=data[si+1];px[di+3]=data[si];}
        else{px[di]=data[si+2];px[di+1]=data[si+1];px[di+2]=data[si];px[di+3]=data[si+3];}
      } return px;
    }
    if (fam==='R10G10B10A2') {
      var s32=new Uint32Array(data.buffer,data.byteOffset,w*h);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,p=s32[si];
        px[di]=(p&0x3FF)*255/1023;px[di+1]=((p>>>10)&0x3FF)*255/1023;
        px[di+2]=((p>>>20)&0x3FF)*255/1023;px[di+3]=(p>>>30)*255/3;
      }
      if (dds.fmt.swapRB) { for (var j=0;j<px.length;j+=4) { var t=px[j]; px[j]=px[j+2]; px[j+2]=t; } }
      return px;
    }
    if (fam==='R11G11B10') {
      var s32b=new Uint32Array(data.buffer,data.byteOffset,w*h);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,p=s32b[si];
        var r=S.h2f_r11g11b10(p&0x7FF),g=S.h2f_r11g11b10((p>>>11)&0x7FF),b=S.h2f_r10((p>>>22)&0x3FF);
        px[di]=Math.min(255,Math.max(0,r*255));px[di+1]=Math.min(255,Math.max(0,g*255));
        px[di+2]=Math.min(255,Math.max(0,b*255));px[di+3]=255;
      } return px;
    }
    if (fam==='R8G8') {
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=data[si*2];px[di+1]=data[si*2+1];px[di+2]=0;px[di+3]=255;
      } return px;
    }
    if (fam==='R8G8S') {
      var n=w*h,fminR=1e9,fmaxR=-1e9,fminG=1e9,fmaxG=-1e9;
      for(var j=0;j<n;j++){var sr=data[j*2]>127?(data[j*2]-256)/127.0:data[j*2]/127.0,sg=data[j*2+1]>127?(data[j*2+1]-256)/127.0:data[j*2+1]/127.0;if(sr<fminR)fminR=sr;if(sr>fmaxR)fmaxR=sr;if(sg<fminG)fminG=sg;if(sg>fmaxG)fmaxG=sg;}
      var frR=fmaxR>fminR?255/(fmaxR-fminR):1,frG=fmaxG>fminG?255/(fmaxG-fminG):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        var sr=data[si*2]>127?(data[si*2]-256)/127.0:data[si*2]/127.0,sg=data[si*2+1]>127?(data[si*2+1]-256)/127.0:data[si*2+1]/127.0;
        px[di]=(sr-fminR)*frR;px[di+1]=(sg-fminG)*frG;px[di+2]=0;px[di+3]=255;
      } return px;
    }
    if (fam==='R8') {
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,v=data[si];
        px[di]=v;px[di+1]=v;px[di+2]=v;px[di+3]=255;
      } return px;
    }
    if (fam==='R8S') {
      var n=w*h,fmin=1e9,fmax=-1e9;
      for(var j=0;j<n;j++){var sv=data[j]>127?(data[j]-256)/127.0:data[j]/127.0;if(sv<fmin)fmin=sv;if(sv>fmax)fmax=sv;}
      var fr=fmax>fmin?255/(fmax-fmin):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,sv=data[si]>127?(data[si]-256)/127.0:data[si]/127.0;
        var vv=(sv-fmin)*fr;px[di]=vv;px[di+1]=vv;px[di+2]=vv;px[di+3]=255;
      } return px;
    }
    if (fam==='R16G16') {
      var s16=new Uint16Array(data.buffer,data.byteOffset,w*h*2);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=s16[si*2]*255/65535;px[di+1]=s16[si*2+1]*255/65535;px[di+2]=0;px[di+3]=255;
      } return px;
    }

    if (fam==='R16') {
      var su=new Uint16Array(data.buffer,data.byteOffset,w*h),mn=65535,mx=0;
      for(var j=0;j<su.length;j++){if(su[j]<mn)mn=su[j];if(su[j]>mx)mx=su[j];}
      var rng=mx>mn?255/(mx-mn):1;
      _normMin=mn/65535; _normMax=mx/65535;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,vv=(su[si]-mn)*rng;
        px[di]=vv;px[di+1]=vv;px[di+2]=vv;px[di+3]=255;
      } return px;
    }



    if (fam==='RGBA16') {
      var u16w=new Uint16Array(data.buffer,data.byteOffset,w*h*4);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=u16w[si*4]*255/65535;px[di+1]=u16w[si*4+1]*255/65535;
        px[di+2]=u16w[si*4+2]*255/65535;px[di+3]=u16w[si*4+3]*255/65535;
      } return px;
    }

    if (fam==='RGB9E5') {
      var s32e=new Uint32Array(data.buffer,data.byteOffset,w*h),emnR=1e9,emxR=-1e9,emnG=1e9,emxG=-1e9,emnB=1e9,emxB=-1e9;
      for(var j=0;j<w*h;j++){var p=s32e[j],exp=(p>>>27)&0x1F,sc=Math.pow(2,exp-15);var r=(p&0x1FF)*sc,g=((p>>>9)&0x1FF)*sc,b=((p>>>18)&0x1FF)*sc;if(isFinite(r)){if(r<emnR)emnR=r;if(r>emxR)emxR=r;}if(isFinite(g)){if(g<emnG)emnG=g;if(g>emxG)emxG=g;}if(isFinite(b)){if(b<emnB)emnB=b;if(b>emxB)emxB=b;}}
      var erR=emxR>emnR?255/(emxR-emnR):1,erG=emxG>emnG?255/(emxG-emnG):1,erB=emxB>emnB?255/(emxB-emnB):1;
      _normMin=Math.min(emnR,emnG,emnB); _normMax=Math.max(emxR,emxG,emxB);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,p=s32e[si],exp=(p>>>27)&0x1F,sc=Math.pow(2,exp-15);
        px[di]=Math.min(255,Math.max(0,((p&0x1FF)*sc-emnR)*erR));px[di+1]=Math.min(255,Math.max(0,(((p>>>9)&0x1FF)*sc-emnG)*erG));
        px[di+2]=Math.min(255,Math.max(0,(((p>>>18)&0x1FF)*sc-emnB)*erB));px[di+3]=255;
      } return px;
    }



    if (fam==='D24S8') {
      var s32d=new Uint32Array(data.buffer,data.byteOffset,w*h);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,d=(s32d[si]&0xFFFFFF)/0xFFFFFF*255;
        px[di]=d;px[di+1]=d;px[di+2]=d;px[di+3]=255;
      } return px;
    }
    if (fam==='RGBA8S') {
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=(oy*step*w+ox*step)*4,di=(oy*outW+ox)*4;
        var sr=data[si]>127?(data[si]-256)/127.0:data[si]/127.0;
        var sg=data[si+1]>127?(data[si+1]-256)/127.0:data[si+1]/127.0;
        var sb=data[si+2]>127?(data[si+2]-256)/127.0:data[si+2]/127.0;
        var sa=data[si+3]>127?(data[si+3]-256)/127.0:data[si+3]/127.0;
        px[di]=(sr*0.5+0.5)*255;px[di+1]=(sg*0.5+0.5)*255;
        px[di+2]=(sb*0.5+0.5)*255;px[di+3]=(sa*0.5+0.5)*255;
      } return px;
    }
    if (fam==='RGBA16S') {
      var si16=new Int16Array(data.buffer,data.byteOffset,w*h*4);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=(si16[si*4]/32767.0*0.5+0.5)*255;px[di+1]=(si16[si*4+1]/32767.0*0.5+0.5)*255;
        px[di+2]=(si16[si*4+2]/32767.0*0.5+0.5)*255;px[di+3]=(si16[si*4+3]/32767.0*0.5+0.5)*255;
      } return px;
    }
    if (fam==='R16G16S') {
      var si16g=new Int16Array(data.buffer,data.byteOffset,w*h*2),fminR=1e9,fmaxR=-1e9,fminG=1e9,fmaxG=-1e9;
      for(var j=0;j<w*h;j++){var fr=si16g[j*2]/32767.0,fg=si16g[j*2+1]/32767.0;if(fr<fminR)fminR=fr;if(fr>fmaxR)fmaxR=fr;if(fg<fminG)fminG=fg;if(fg>fmaxG)fmaxG=fg;}
      var rr=fmaxR>fminR?255/(fmaxR-fminR):1,rg=fmaxG>fminG?255/(fmaxG-fminG):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=(si16g[si*2]/32767.0-fminR)*rr;px[di+1]=(si16g[si*2+1]/32767.0-fminG)*rg;px[di+2]=0;px[di+3]=255;
      } return px;
    }
    if (fam==='R16S') {
      var si16v=new Int16Array(data.buffer,data.byteOffset,w*h),fmin=1e9,fmax=-1e9;
      for(var j=0;j<si16v.length;j++){var v=si16v[j]/32767.0;if(v<fmin)fmin=v;if(v>fmax)fmax=v;}
      var rr=fmax>fmin?255/(fmax-fmin):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,vv=(si16v[si]/32767.0-fmin)*rr;
        px[di]=vv;px[di+1]=vv;px[di+2]=vv;px[di+3]=255;
      } return px;
    }
    if (fam==='B5G6R5') {
      var su16b=new Uint16Array(data.buffer,data.byteOffset,w*h);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,p=su16b[si];
        px[di]=((p>>>11)&0x1F)*255/31;px[di+1]=((p>>>5)&0x3F)*255/63;px[di+2]=(p&0x1F)*255/31;px[di+3]=255;
      } return px;
    }
    if (fam==='B5G5R5A1') {
      var su16a=new Uint16Array(data.buffer,data.byteOffset,w*h);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,p=su16a[si];
        px[di]=((p>>>10)&0x1F)*255/31;px[di+1]=((p>>>5)&0x1F)*255/31;px[di+2]=(p&0x1F)*255/31;px[di+3]=(p>>>15)?255:0;
      } return px;
    }
    if (fam==='ARGB4') {
      var su16c=new Uint16Array(data.buffer,data.byteOffset,w*h);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,p=su16c[si];
        px[di+3]=(p>>>12)&0xF;px[di]=((p>>>8)&0xF)*17;px[di+1]=((p>>>4)&0xF)*17;px[di+2]=(p&0xF)*17;px[di+3]*=17;
      } return px;
    }

    // BC1-5 with step>1: block-level skip sampling
    if (fam==='BC1'||fam==='BC3'||fam==='BC4'||fam==='BC5') {
      return S.decodeBC(data, w, h, dds.fmt, step);
    }

    return null;
  }

  // ---- Normalize params helper ----
  // Scan RGBA8 bytes to find the effective normalization range used during decode.
  // For formats that auto-normalized (float/SNORM/depth), scan actual byte min/max
  // and reverse-quantize to find the original data range.
  // For formats with fixed [0,1] mapping, return nMin=0, nMax=1.
  function normParams(dds) {
    var fam = dds.fmt.family;
    var famType = dds.fmt.type || '';
    var isSNorm = famType.indexOf('SNORM') >= 0 || fam === 'R8S' || fam === 'R8G8S' || fam === 'RGBA8S' || fam === 'RGBA16S' || fam === 'R16S' || fam === 'R16G16S';
    if (isSNorm) return {nMin: -1, nMax: 1};
    if (_rawF) {
      var lo = 1e9, hi = -1e9;
      for (var j = 0; j < _rawF.length; j += 4) {
        var v = _rawF[j];
        if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      if (lo >= hi) { lo = 0; hi = 1; }
      return {nMin: lo, nMax: hi};
    }
    if (_normMin !== undefined) return {nMin: _normMin, nMax: _normMax};
    return {nMin: 0, nMax: 1};
  }


  function decodeCPU(dds,n,s,step) {
    var part=slice(dds,n,s);
    if(!part) return fail('Invalid DDS mip or slice');
    if(part.fmt.family==='BC6H'||part.fmt.family==='BC7') return fail('DDS format requires WebGL decoding');
    step=step===undefined?1:step;
    if(!Number.isInteger(step)||step<1) return fail('Invalid sampling step');
    var frame=floatFrame(part,step);
    if(frame) return frame;
    if(part.data.byteOffset%4) part.data=new Uint8Array(part.data);
    var w=Math.ceil(part.w/step),h=Math.ceil(part.h/step),pixels;
    if(part.fmt.family==='RGBG'||part.fmt.family==='GRGB') {
      pixels=new Uint8ClampedArray(w*h*4);
      var rgbg=part.fmt.family==='RGBG',pitch=Math.ceil(part.w/2)*4;
      for(var y=0;y<h;y++) for(var x=0;x<w;x++) {
        var xx=x*step,off=y*step*pitch+Math.floor(xx/2)*4,dst=(y*w+x)*4;
        pixels[dst]=part.data[off+(rgbg?0:1)];
        pixels[dst+1]=part.data[off+(rgbg?(xx%2?3:1):(xx%2?2:0))];
        pixels[dst+2]=part.data[off+(rgbg?2:3)];pixels[dst+3]=255;
      }
      return {w:w,h:h,pixels:pixels,rawPixels:null,normMin:0,normMax:1};
    }
    pixels=decodeDDS(part,step);
    if(!pixels) return fail('Unsupported CPU DDS format: '+part.fmt.type);
    if(part.fmt.opaque||part.fmt.dxgi===88||part.fmt.dxgi===93) for(var a=3;a<pixels.length;a+=4) pixels[a]=255;
    var np=normParams(part);
    return {w:w,h:h,pixels:pixels,rawPixels:_rawF,normMin:np.nMin,normMax:np.nMax};
  }
  api.parse=parse; api.slice=slice; api.decodeCPU=decodeCPU; api.fromRaw=fromRaw; api.mipSize=mipSize;
  self.ImageCodecDDS=api;
})();
