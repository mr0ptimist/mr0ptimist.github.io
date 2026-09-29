// Worker transport; all format logic lives in the shared codecs.
(function(){
  var base=self.location.href.replace(/[^/]+$/, '');
  importScripts(base+'worker-shared.js?v=24',base+'dds-codec.js?v=1',base+'exr-parser.js?v=1');
  var D=self.ImageCodecDDS;
  self.onmessage=function(e){
    var msg=e.data||{},result;
    try {
      if(msg.type==='dds'){
        var dds=D.parse(msg.buffer);
        if(!dds) throw new Error(D.lastError);
        if(msg.typeOverride==='R16'&&dds.fmt.family==='R16F'){dds.fmt.type='R16_UNORM';dds.fmt.family='R16';}
        var step=1;
        if(msg.targetDim>0&&Math.max(dds.w,dds.h)>1024) step=Math.max(1,Math.ceil(Math.max(dds.w,dds.h)/msg.targetDim));
        result=D.decodeCPU(dds,0,0,step);
        if(!result) throw new Error(D.lastError);
      } else if(msg.type==='exr'){
        var exr=EXR.parse(msg.buffer);
        if(!exr) throw new Error(EXR.lastError);
        result=D.fromRaw(exr.pixels,exr.w,exr.h,3);
        result.pixels=EXR.toRGBA8(exr);
        if(!result.pixels) throw new Error('EXR display conversion failed');
      } else throw new Error('Unknown decode request');
      var transfer=[result.pixels.buffer];
      if(result.rawPixels) transfer.push(result.rawPixels.buffer);
      result.id=msg.id;result.ok=true;
      self.postMessage(result,transfer);
    } catch(e){self.postMessage({id:msg.id,ok:false,error:e.message||String(e)});}
  };
})();
