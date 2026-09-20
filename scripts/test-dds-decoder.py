#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""static/js/dds-parser.js 的 BC7/BC6H 解码回归检查（无头 Chrome + 页面内真实解码路径）。

用法:
    python scripts/test-dds-decoder.py                 # 默认取仓库里第一张 BC7 DDS
    python scripts/test-dds-decoder.py <path.dds> [期望 JSON]

期望 JSON（可选；缺省则只打印实测值，不判定）形如:
    {"size": [256, 256], "r": [0, 251, 11.1], "g": [12, 239, 58.7], "b": [0, 251, 39.7]}

判定：RGB 均值差 ≤ 1.0、极值差 ≤ 8。期望值应当来自 RenderDoc 自己的解码
（纹理查看器另存 TGA/PNG，或 GUI 的通道统计），不要用本脚本自我循环取证。

背景：2026-09 实测，WebGL 上下文默认 alpha:true 时画布按预乘 alpha 参与合成，
drawImage→getImageData 读回会把 RGB 压向 A（暗 alpha 贴图颜色整体塌掉，
曾表现为 R/G/B 全部趋同于 B 通道）。修法是渲染进 RGBA8 FBO 再 readPixels，
并保证 alpha:false。本脚本锁死这条路径的回归。
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def find_default_dds() -> Path:
    for p in sorted((ROOT / "content").rglob("*.dds")):
        head = p.read_bytes()[:148]
        if head[:4] != b"DDS " or head[84:88] != b"DX10":
            continue
        if int.from_bytes(head[128:132], "little") in (95, 96, 98, 99):  # BC6H / BC7
            return p
    raise SystemExit("仓库里没找到 BC7/BC6H 的 DDS，请显式给路径")


GOLDEN = {                      # 对照 RenderDoc 自己的解码（纹理查看器另存 TGA，逐通道统计）
    "size": [256, 256],         # 素材: content/local/Endfield/.../ResourceId-7281_SnowHeightGradientMap.dds
    "r": [0, 251, 11.1],
    "g": [12, 239, 58.7],
    "b": [0, 251, 39.7],
    "a": [0, 251, 39.7],
}


def main() -> int:
    args = sys.argv[1:]
    dds = Path(args[0]).resolve() if args else find_default_dds()
    expected = json.loads(Path(args[1]).read_text(encoding="utf-8")) if len(args) > 1 else GOLDEN
    if not dds.exists():
        raise SystemExit(f"找不到 {dds}")
    if dds.stat().st_size != 65684:
        print(f"注意: {dds.name} 不是 golden 素材（期望 65684 字节），跳过判定只打印实测", file=sys.stderr)
        expected = None

    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script src="/js/worker-shared.js"></script>
<script src="/js/dds-parser.js"></script>
<script>
window.RESULT = null;
(async function() {{
  try {{
    var buf = await (await fetch('/{dds.name}')).arrayBuffer();
    var p = DDS.parse(buf);
    var px = p.getMip(0, 0);
    var keys = ['r','g','b','a'], n = p.w * p.h, s = {{}};
    keys.forEach(function(k) {{ s[k] = {{min:255, max:0, sum:0}}; }});
    for (var i = 0; i < n; i++) for (var c = 0; c < 4; c++) {{
      var o = s[keys[c]], v = px[i*4+c];
      if (v < o.min) o.min = v; if (v > o.max) o.max = v; o.sum += v;
    }}
    var out = {{size: [p.w, p.h], fmt: p.fmt.type}};
    keys.forEach(function(k) {{ out[k] = [s[k].min, s[k].max, +(s[k].sum/n).toFixed(1)]; }});
    window.RESULT = out;
  }} catch (e) {{ window.RESULT = {{error: String(e)}}; }}
}})();
</script></body></html>
"""

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        (tmp / "js").mkdir()
        for f in ("worker-shared.js", "dds-parser.js"):
            (tmp / "js" / f).write_bytes((ROOT / "static" / "js" / f).read_bytes())
        (tmp / dds.name).write_bytes(dds.read_bytes())
        (tmp / "page.html").write_text(html, encoding="utf-8")
        srv = subprocess.Popen([sys.executable, "-m", "http.server", "8933", "--directory", str(tmp)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            script = """const { openPage } = require('%s');
(async () => {
  const page = await openPage('http://127.0.0.1:8933/page.html', {waitSelector: null});
  for (let i = 0; i < 80; i++) {
    const r = await page.evaluate('JSON.stringify(window.RESULT)');
    if (r && r !== 'null') { console.log(r); break; }
    await new Promise(res => setTimeout(res, 250));
  }
  await page.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });""" % (ROOT / "scripts" / "cdp" / "cdp.js").as_posix()
            js = tmp / "run.js"
            js.write_text(script, encoding="utf-8")
            out = subprocess.run(["node", str(js)], capture_output=True, text=True, timeout=180)
            if out.returncode != 0:
                print(out.stdout.strip() or out.stderr.strip(), file=sys.stderr)
                return 1
            got = json.loads([l for l in out.stdout.strip().splitlines() if l.startswith("{")][-1])
        finally:
            srv.terminate()

    if "error" in got:
        print(f"解码失败: {got['error']}", file=sys.stderr)
        return 1
    print(f"文件: {dds}")
    print(f"尺寸: {got['size'][0]}x{got['size'][1]}  格式: {got.get('fmt')}")
    for k in "rgba":
        lo, hi, mean = got[k]
        print(f"  {k.upper()}: min={lo:>3} max={hi:>3} mean={mean}")

    if expected is None:
        print("\n（未给期望值，仅打印实测；判定请对照 RenderDoc 解码结果）")
        return 0
    bad = []
    for k in "rgb":
        if k not in expected:
            continue
        e_lo, e_hi, e_mean = expected[k]
        a_lo, a_hi, a_mean = got[k]
        if abs(a_mean - e_mean) > 1.0 or abs(a_lo - e_lo) > 8 or abs(a_hi - e_hi) > 8:
            bad.append(f"{k.upper()}: 期望 {expected[k]} 实测 {got[k]}")
    if bad:
        print("\n不一致（对照 RenderDoc）:", file=sys.stderr)
        for b in bad:
            print("  " + b, file=sys.stderr)
        return 1
    print("\n与期望一致（对照 RenderDoc 解码）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
