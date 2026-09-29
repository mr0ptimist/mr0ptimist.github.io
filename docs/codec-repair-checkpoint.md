# DDS/EXR repair — completed acceptance

The user resumed the checkpoint `51fdeda` on 2026-09-29. The identified fixes and their integration are complete. This supersedes the unfinished status recorded in that commit.

## Final structure and behavior

- `dds-codec.js` owns DDS container validation, mip/array/volume addressing and CPU decoding for both the page and Worker.
- `dds-parser.js` is the main-thread adapter for GPU decoding. `getFrame(mip,slice,step)` returns display pixels, actual dimensions, original floats and normalization; `getMip` retains its RGBA8 compatibility contract.
- `decode-worker.js` only dispatches codec calls and settles each request with a frame or explicit error. GPU formats are rejected before CPU allocation.
- The viewer consumes frames instead of reconstructing floats from DDS bytes. Mip changes replace all frame state together; sampled cache dimensions are retained.
- BC1–5 alpha/interpolation/TYPELESS fixes, EXR offset/alpha validation and GPU BC6H/BC7 fixes are integrated. Packed RGB9E5 raw values now include the mantissa scale.
- Unsigned 32-bit mask reading and legacy R16/RGBX detection are corrected; unknown masks/formats fail explicitly.
- Page script URLs, Worker imports and thumbnail cache versions are updated.

## Acceptance

- `node scripts/test-dds-codec.js`: 23 passed.
- `node scripts/test-exr-codec.js`: 38 passed, including malformed-input mutation checks.
- `node scripts/test-codec-worker.js`: 11 passed, covering shared page/Worker output, mip/array addressing, alpha, packed rows, unsigned masks and error recovery.
- `node scripts/test-export-texture.js`: passed.
- Independent `.tmp-localcheck/codec-repair/acceptance.js`: 20 passed.
- Independent browser acceptance: zero failures on the source hashes below. Actual Worker error/recovery and constructor/load/silent-timeout cases settled; mip remapping and sampled-cache reuse passed. BC7 RGBA and sRGB matched a native reference exactly. BC6H raw endpoints +65504 and -65504 survived through the frame API.
- JavaScript syntax checks and `git diff --check`: passed. No IDE tools were exposed.
- `hugo --destination .tmp-localcheck/codec-repair/site`: exit 0, 205 pages. Generated HTML loads the shared codec before the DDS adapter.
- Real DDS corpus: 221 of 223 parse successfully. The two deliberate rejections below are damaged inputs, not silent success.
- Real EXR corpus from the previous phase: all 15 supported images retained byte-identical raw floats; one already-unsupported file remained unsupported. That historical run used the same EXR source hash; the subsequent unsigned DDS reader change does not affect EXR's DataView/half-float path.

## Two damaged DDS inputs

Both claim DX10 BGRA8 images but contain 20 fewer bytes than their headers require:
- `content/local/DeltaForce/Overview_dx12_frame602_deepseek-v4-pro/images/D9608_tex0_1256.dds`: 262272 bytes; required 148 + 256×256×4 = 262292.
- `content/local/DeltaForce/Overview_dx12_frame602_deepseek-v4-pro/images/D9608_tex8_1361.dds`: 33177728 bytes; required 148 + 3840×2160×4 = 33177748.

The old Worker read from byte 128 to compensate, treating the DX10 extension as pixels. The new code rejects these files with `Truncated DDS mip payload`; re-export them to restore their previews. Assets were not changed. The unchanged strict historical-comparison harness exits 1 for these two reviewed differences; it was not weakened to hide them.

## Evidence and limits

Final local evidence is gitignored under `.tmp-localcheck/codec-repair/`: `final-browser.log`, `final-unit-tests.log`, `final-dds-corpus.json`, and `final-exr-corpus.json`. Logs record source/input hashes, commands and environment. Earlier mixed-revision results remain historical.

Environment: Node 24.14.0, Chrome 154, ANGLE/Vulkan SwiftShader with BPTC and float framebuffer extensions, Hugo 0.160.1 extended, Windows. Physical GPU/browser-driver coverage was not performed. EXR still intentionally supports only uncompressed scanline images.

Final source SHA-256:
- `worker-shared.js`: `21b418fa00028f2ef7c2f8ed5138e7d904526e96883b71241081b49a4231fa7d`
- `dds-codec.js`: `d54885d91354fe0fda7c419db7833abc8423bf9d31b96a812b16c1af1919acee`
- `dds-parser.js`: `0761977c464644d5a54ee7b8b7cfff91ea5f32e9d16e12de705856443c453db0`
- `decode-worker.js`: `68f48895ca21acc1825b9a041d507509ff43e61e7547960a10533558d49adae1`
- `exr-parser.js`: `9e75d7ae438ed6df4da12941b9d173bc2fc78e8dad27a959f3c979ed02e01794`
- `image-viewer.js`: `b838f3b69ddb82215b1d7f4be8535c7c45884d2a7ed954d9bd06a5f9848ba4bb`
- `color-remap.js`: `52a9ded0db10dcea74936ea70a31cce29bcbe634943aa30b31ac97c84446bf95`

## Delegation continuity

The earlier DSH sessions remain released: DDS/UI `15f09133-29f7-4c99-bf3a-012d01a3ba21`, EXR `e9fa4ece-f462-430d-9d8c-c762e0cb36ce`. The resumed integration was performed directly by the caller; no paused executor was restarted. The original 60-minute cumulative allowance had approximately 47 active minutes consumed at pause; resumed implementation and acceptance used approximately 10 additional minutes. All 4 delegated review rounds had already been consumed. Token/cost usage is unknown.

Unrelated pre-existing changes under `content/` remain excluded. No remote push or deployment was performed.
