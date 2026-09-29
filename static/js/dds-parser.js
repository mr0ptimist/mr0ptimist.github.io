// Main-thread DDS adapter; CPU decoding is shared with decode-worker.js.
var DDS = (function(){
  var D=self.ImageCodecDDS;
  if(!D) throw new Error('ImageCodecDDS not loaded');
  var _glCtx = null;
  function _getGL() {
    if (_glCtx && !_glCtx.isContextLost()) return _glCtx;
    _glCtx = document.createElement('canvas').getContext('webgl2', {alpha: false});
    return _glCtx;
  }

  function _decodeBC7_WebGL(data, w, h, fmt) {
    var gl, tex, fb, rb;
    function fail(message) {
      if (typeof DDS !== 'undefined' && DDS) DDS.lastError = message;
      return null;
    }
    try {
      gl = _getGL();
      if (!gl) return fail('WebGL2 unavailable');
      var ext = gl.getExtension('EXT_texture_compression_bptc');
      if (!ext) return fail('BPTC texture decoding unavailable');
      var hdr = fmt.family === 'BC6H';
      if (!hdr && fmt.family !== 'BC7') return fail('Unsupported GPU format');
      if (hdr && !gl.getExtension('EXT_color_buffer_float')) return fail('Floating-point framebuffer unavailable');
      if (w > gl.getParameter(gl.MAX_TEXTURE_SIZE) || h > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
          w > gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || h > gl.getParameter(gl.MAX_RENDERBUFFER_SIZE))
        return fail('Texture exceeds WebGL size limit');
      var internalFmt = hdr
        ? (fmt.dxgi === 96 ? ext.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT : ext.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT)
        : ext.COMPRESSED_RGBA_BPTC_UNORM_EXT; // 保留编码字节，与 CPU 的 sRGB 预览一致。
      if (!gl._bcProg) {
        var vs = gl.createShader(gl.VERTEX_SHADER), fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(vs, 'attribute vec2 p;varying vec2 t;void main(){gl_Position=vec4(p,0,1);t=p*0.5+0.5;}');
        gl.shaderSource(fs, 'precision highp float;varying vec2 t;uniform sampler2D s;void main(){gl_FragColor=texture2D(s,t);}');
        gl.compileShader(vs); gl.compileShader(fs);
        var prog = gl.createProgram();
        gl.attachShader(prog, vs); gl.attachShader(prog, fs);
        gl.bindAttribLocation(prog, 0, 'p'); gl.linkProgram(prog);
        gl.deleteShader(vs); gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          gl.deleteProgram(prog);
          return fail('GPU decode shader failed');
        }
        var vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
        gl._bcProg = prog;
        gl._bcProg._buf = vertexBuffer;
      }
      for (var errorCount = 0; errorCount < 8 && gl.getError() !== gl.NO_ERROR; errorCount++) {}
      tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.compressedTexImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, new Uint8Array(data));
      if (gl.getError() !== gl.NO_ERROR) return fail('Compressed texture upload failed');
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, hdr ? gl.RGBA32F : gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        return fail('GPU decode framebuffer incomplete');
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND); gl.disable(gl.DITHER);
      gl.useProgram(gl._bcProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl._bcProg._buf);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      var out = hdr ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, hdr ? gl.FLOAT : gl.UNSIGNED_BYTE, out); // shader 已使纹理行与回读行同向。
      if (gl.getError() !== gl.NO_ERROR) return fail('GPU decode readback failed');
      return out;
    } catch (e) {
      return fail('GPU decode failed: ' + e.message);
    } finally {
      if (gl) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (tex) gl.deleteTexture(tex);
        if (fb) gl.deleteFramebuffer(fb);
        if (rb) gl.deleteRenderbuffer(rb);
      }
    }
  }


  var api={parse:parse,lastError:null};
  function parse(buf) {
    var dds=D.parse(buf);
    api.lastError=D.lastError;
    if(!dds) return null;
    dds.getFrame=function(n,s,step) {
      api.lastError=null;
      try {
        if(dds.fmt.family!=='BC6H'&&dds.fmt.family!=='BC7') {
          var frame=D.decodeCPU(dds,n,s,step);
          if(!frame) api.lastError=D.lastError;
          return frame;
        }
        var part=D.slice(dds,n,s);
        if(!part){api.lastError='Invalid DDS mip or slice';return null;}
        var pixels=_decodeBC7_WebGL(part.data,part.w,part.h,part.fmt);
        if(!pixels) return null;
        if(dds.fmt.family==='BC6H') return D.fromRaw(pixels,part.w,part.h,3);
        return {w:part.w,h:part.h,pixels:new Uint8ClampedArray(pixels),rawPixels:null,normMin:0,normMax:1};
      } catch(e){api.lastError=e.message;return null;}
    };
    dds.getMip=function(n,s){var f=dds.getFrame(n,s);return f?f.pixels:null;};
    return dds;
  }
  return api;
})();
