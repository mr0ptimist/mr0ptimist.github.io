// =============================================================================
// export-texture.js — 图片查看器导出工具（TGA 编码 + Blob 落盘）
// =============================================================================
// 依赖：无（经典 script，window.ExportTexture + module.exports 双暴露，
//       后者供 node 单测；不触碰 worker/importScripts 链）
//
// 导出像素语义：调用方传入原始解码帧 RGBA8（top-down），本模块不做任何
// remap/染色/翻转烘焙。TGA 为未压缩 truecolor（24/32bit，bottom-up + BGRA）。
// 落盘：showSaveFilePicker 另存为对话框优先，取消静默，失败降级 <a download>。
// =============================================================================
(function(){
  function encodeTGA(rgba, w, h, bpp) {
    bpp = bpp === 32 ? 32 : 24;
    var bytesPerPx = bpp >> 3;
    var out = new Uint8Array(18 + w * bytesPerPx * h);
    out[2] = 2;                            // image type: uncompressed truecolor
    out[12] = w & 255; out[13] = (w >> 8) & 255;   // width LE
    out[14] = h & 255; out[15] = (h >> 8) & 255;   // height LE
    out[16] = bpp;
    out[17] = bpp === 32 ? 8 : 0;          // descriptor: alpha bits
    var o = 18;
    for (var y = h - 1; y >= 0; y--) {     // TGA origin bottom-left：自末行起
      var row = y * w * 4;
      for (var x = 0; x < w; x++) {
        var i = (row + x * 4) | 0;
        out[o++] = rgba[i + 2];            // B
        out[o++] = rgba[i + 1];            // G
        out[o++] = rgba[i];                // R
        if (bpp === 32) out[o++] = rgba[i + 3];
      }
    }
    return out;
  }

  function download(blob, fname) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
  }

  // cb(status): 'saved'(另存为成功) | 'downloaded'(降级下载已触发)
  //            | 'cancelled'(用户取消，调用方不反馈)
  //            | 'failed'(另存为以外的错误且降级也失败)
  // accept: {'image/png': ['.png']} 或 {'image/x-tga': ['.tga']}
  function saveBlob(blob, fname, accept, cb) {
    var picker = window.showSaveFilePicker;
    if (picker) {
      try {
        picker.call(window, {
          suggestedName: fname,
          types: [{ description: fname.slice(-4) === '.tga' ? 'TGA 图像' : 'PNG 图像',
                    accept: accept }]
        }).then(function(handle) {
          // ⚠️ close 的是 createWritable() 返回的流（flush 落盘）；
          //    FileSystemFileHandle 没有 close()，调用会 TypeError
          return handle.createWritable().then(function(w) {
            return w.write(blob).then(function() { return w.close(); });
          });
        }).then(function() { cb && cb('saved'); })
        .catch(function(e) {
          if (e && e.name === 'AbortError') { cb && cb('cancelled'); return; }
          try { download(blob, fname); cb && cb('downloaded'); }
          catch (err2) { cb && cb('failed'); }
        });
        return;
      } catch (e) { /* picker 调用同步抛错 → 走降级 */ }
    }
    try { download(blob, fname); cb && cb('downloaded'); }
    catch (e) { cb && cb('failed'); }
  }

  var ExportTexture = { encodeTGA: encodeTGA, saveBlob: saveBlob };
  if (typeof window !== 'undefined') window.ExportTexture = ExportTexture;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExportTexture;
})();
