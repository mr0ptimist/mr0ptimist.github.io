# DDS/EXR repair checkpoint — unfinished

Paused at the user's request on 2026-09-29. This is a work-in-progress snapshot, not a release or a completed acceptance result. Do not deploy this snapshot without completing integration.

## Implemented portions

- BC1 transparency, BC2 explicit alpha, BC2/BC3 four-color interpolation, BC4/BC5 SNORM interpolation and TYPELESS dispatch.
- EXR offset-table parsing and input validation, linear alpha, opaque default alpha, scalar-channel grayscale fallback. Existing RGB tone mapping is preserved.
- Worker-pool creation/load/timeout handling, sampled preview dimensions, mip/slice state work, and alpha preservation during range remapping.
- GPU readback preserves BC6H floating-point values and removes the extra BC7 row flip. BC7 sRGB previews retain encoded channel values consistently with the CPU path.

## Required before acceptance

1. Finish the shared DDS container/CPU decoder. `dds-codec.js` currently contains only partial helpers; main-thread and Worker parsing/decoding are still duplicated.
2. Wire `dds-codec.js` into the actual page and Worker loading chains. Header checks in `dds-parser.js` are currently conditional on that global being loaded.
3. Implement the coherent `getFrame` contract (display pixels, dimensions, raw floats, normalization). The current BC6H GPU function returns `Float32Array` through the old `getMip` path; existing consumers expecting RGBA8 can fail. GPU readback passing is not UI integration passing.
4. Finish Worker request-level error handling. The latest browser test still observed an uncaught error for a truncated DDS request.
5. Remove UI-side raw-float reconstruction once the shared frame API is connected. It is an interim workaround, not the intended architecture.
6. Finish cache-version updates for Worker imports, EXR and template scripts. Review `static/js/AGENTS.md`, whose intended architecture description is ahead of the implementation.
7. Run full browser/GPU regressions, the 223-file DDS corpus, syntax checks and Hugo build on the final integrated source hashes.

## Evidence collected before stopping

- EXR suite: 38 passed. Final EXR source SHA-256: `9e75d7ae438ed6df4da12941b9d173bc2fc78e8dad27a959f3c979ed02e01794`.
- Real EXR corpus: 15 supported files retained byte-identical raw float pixels versus the original revision; one already-unsupported file remained unsupported.
- Independent browser GPU probes: BC7 reference maximum byte error 0, including its sRGB variant; synthetic BC6H endpoints +65504 and -65504 retained with alpha 1.
- Worker constructor/load/silent-timeout settlement and sampled-cache dimensions passed. The browser run still had 3 failures: malformed DDS Worker response and the two missing BC6H frame-API cases.
- Tests ran in Node 24.14.0 and Chrome 154 using ANGLE/Vulkan SwiftShader. No physical-GPU or IDE validation was performed.
- Detailed local evidence and standalone acceptance harnesses: `.tmp-localcheck/codec-repair/` (gitignored). Mixed-revision intermediate runs are historical evidence, not proof that this entire snapshot passed.

## Delegation state

Used the `dsh-orchestration` skill. Both owned sessions were released; the active DDS run was confirmed cancelled before commit. No repair work should resume without user instruction.

- DDS/UI: `15f09133-29f7-4c99-bf3a-012d01a3ba21`; last run `dsh-run-mume72wx-6`, cancelled.
- EXR: `e9fa4ece-f462-430d-9d8c-c762e0cb36ce`; completed and released.
- DDS executor's child IDs: `7bbced99-45a5-4350-991e-e18cc9bad6b6` (interrupted by its parent) and `6105e74d-373a-465f-9d20-e4433c8be168` (UI). Bridge subagent status extensions were unavailable, so independent child terminal status was not observable.
- Original cumulative budget: 60 minutes from 07:23 UTC, 4 review/rework rounds. At pause approximately 47 minutes and all 4 rounds had been consumed; token/cost usage unknown. Root took over GPU readback and corrected the existing GPU test's fixture identity check.

Unrelated pre-existing edits under `content/` are excluded from this checkpoint commit.
