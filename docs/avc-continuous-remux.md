# Continuous AVC recording and bounded MP4 output

CapturePack keeps the shipping MediaRecorder stream, AVC encoder, 6 Mbps bitrate and existing keyframe cadence. The encoder writes an internal Matroska AVC stream. A CapturePack-owned streaming remuxer produces the public `video/mp4;codecs=avc1` / `replay.mp4` output. VP8/VP9 fallback still produces legal WebM.

Chromium 150.0.7871.129 uses a cumulative checked uint32 output position in its native MP4 muxer, which fails after 4 GiB. Its WebmMuxer delegate tracks position with checked signed int64. Selecting that internal writer removes the uint32 native MP4 route; the remuxer uses BigInt stream counters, uint64 decode timestamps and fragment-local data offsets. It does not periodically replace an encoder, force GC or discard arbitrary output to stay below 4 GiB.

Only incomplete input and one keyframe-led GOP survive an ingest call, with explicit byte and sample budgets. AVC VCL sample bytes are unchanged. Annex B parameter sets become avcC metadata and NAL lengths become MP4 length prefixes. Timestamps determine frame durations, including real gaps. Equal startup timestamps retain both samples with a zero duration rather than inventing elapsed time. The baseline AVC encoder has no B frames; decreasing timestamps, changing parameter sets, malformed/laced/invisible blocks and truncated final enclosures fail closed.

An empty final MediaRecorder event still sends an ordered payload-only queue marker to finalize the last GOP. It precedes replacement-session bytes and owns no fake Blob. Stop deadlines, cancellation, HOLD discard, native replay handoff and teardown clear the remux owner immediately. Existing explicit snapshot flush and HOLD/RESUME epoch boundaries are preserved.

The all/video QA profiles include structural timing/budget regressions, production factory routing and the actual renderer lifecycle ownership harness. The renderer harness uses synthetic media and clocks; it does not prove installed-app CPU/RSS/GPU performance. `avc-remux-cumulative-check.mjs` streams more than 4 GiB of actual bytes through the shipped parser and ring with bounded ownership; its AVC samples are structural fixtures and it does not prove native encoder stability or decoding.

Release acceptance additionally requires real MediaRecorder output, independent decoding/timing validation, native continuous cumulative output beyond 4 GiB and the #240/#245 installed-version long-run/recovery gates. Passing JS checks or merging this code alone must not close those gates or republish an unaccepted release.

Pinned upstream source: https://github.com/chromium/chromium/blob/150.0.7871.129/media/muxers/webm_muxer.h and https://github.com/chromium/chromium/blob/150.0.7871.129/media/muxers/webm_muxer.cc.
