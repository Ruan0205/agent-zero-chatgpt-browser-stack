# Visual evidence guard

Always-on custom plugin for both main and repair Agent Zero. It adds explicit
software WebGL to the internal Linux browser without enabling Chromium's unsafe
automatic software fallback, and adds bounded console/DOM diagnostics to uniform
captures. Screenshots are checked by pixel variation, not file size or darkness.

Visual review assignments use exact attachment paths and SHA-256 receipts. Missing
or uniform images stop delegation; the reviewer must load the prescribed images
with `vision_load` before returning an assessment, or report `não avaliável`.
This protects evidence transport, not the correctness of every LLM judgement:
the reviewer must still establish that both reference and actual render are visible.
Ordinary non-visual delegation and intentionally solid-color image generation are
not rejected. Browser `evaluate.expression` is normalized to `script`; empty code
is rejected, including batch calls.

The `call_subordinate` override also applies the guard to parallel delegation.
Install the plugin in `usr/plugins/visual_evidence_guard` and restart Agent Zero.
The `init_a0/start` hook installs the renderer adapter before chat restoration or
browser-viewer access, so opening the viewer first after a reboot cannot bypass it.
Existing browser sessions retain their conversation/tab bindings; process restart
recreates their internal browser with the corrected renderer settings.

Native Kimi image parts default to explicit `detail: high`, preserving their
original bytes/paths and message IDs. Explicit caller detail is respected.
The live probe with the actual comparison board identified all six reference
poses, the blue-gray tunic, all four renders, and the incomplete model arms.
This improves visual evidence delivery; it does not make subjective grades
infallible. Contradictory descriptions must still be rejected, not optimized for.

Verify using the framework Python runtime:
`python -m unittest discover -s usr/plugins/visual_evidence_guard/tests -v`.
For a live smoke check, compare uniform-image rejection, expression alias, actual
WebGL page capture, and reviewer attachment/vision logs; do not accept a grade from
code descriptions or the reference image alone.
