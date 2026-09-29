// DDS 容器校验 + CPU 解码共享模块（主线程 / Worker 共用）。必须在 worker-shared.js 之后加载。
(function () {
  var S = self.ImageCodecShared;
  if (!S) throw new Error('ImageCodecDDS: worker-shared.js 必须先加载');

  var MAX_DIM = 16384;   // 现有真实素材最大 11352²
  var MAX_MIPS = 32;
  var MAX_ARRAY = 4096;

  // 单 mip 单面字节数；未压缩格式需要 fmt.bpp（detectFmt 从 DXGI_BPP 取）
  function mipSize(w, h, fmt) {
    var mw = Math.max(1, w), mh = Math.max(1, h);
    if (fmt.isComp) {
      var bs = (fmt.family === 'BC1' || fmt.family === 'BC4') ? 8 : 16;
      return Math.max(1, (mw + 3) / 4 | 0) * Math.max(1, (mh + 3) / 4 | 0) * bs;
    }
    return fmt.bpp ? mw * mh * (fmt.bpp / 8) : 0;
  }

  // 返回错误串，''=通过
  function checkHeader(w, h, mips, arraySize) {
    if (!(w > 0) || !(h > 0)) return '宽高必须 > 0（' + w + '×' + h + '）';
    if (w > MAX_DIM || h > MAX_DIM) return '尺寸超上限 ' + MAX_DIM + '（' + w + '×' + h + '）';
    if (!(mips >= 1) || mips > MAX_MIPS) return 'mip 数非法（' + mips + '）';
    if (!(arraySize >= 1) || arraySize > MAX_ARRAY) return '数组/立方体面数非法（' + arraySize + '）';
    return '';
  }

  // 未知格式必须在解析期失败，不能当成「原样拷贝」的成功
  function checkFormat(fmt) {
    if (!fmt) return '未知格式';
    if (fmt.isComp) return '';
    if (!fmt.bpp) return '未知 DXGI 格式 ' + (fmt.dxgi != null ? fmt.dxgi : fmt.fourCC);
    return '';
  }

  // 仅 BC1/BC3/BC4/BC5 有 CPU 路径；其余压缩格式需要 WebGL
  function decodeCPU(data, w, h, fmt) {
    var err = checkFormat(fmt);
    if (err) throw new Error('DDS: ' + err);
    var fam = fmt.family;
    if (fam === 'BC1' || fam === 'BC3' || fam === 'BC4' || fam === 'BC5') return S.decodeBC(data, w, h, fmt);
    throw new Error('DDS: ' + (fmt.type || fam) + ' 需要 WebGL 解码');
  }

  self.ImageCodecDDS = {
    mipSize: mipSize, checkHeader: checkHeader, checkFormat: checkFormat, decodeCPU: decodeCPU,
    MAX_DIM: MAX_DIM
  };
  if (typeof window !== 'undefined') window.ImageCodecDDS = self.ImageCodecDDS;
})();
