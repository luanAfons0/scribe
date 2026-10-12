---
status: proposed
---

# The call's sound is kept until its voices are told apart

scribe told people apart by track alone: `Você` for the mic, `Outros` for
the call's sound (the track the code names `tab`, ADR-0008). To tell the
people in the call's sound apart, a diarizer (sherpa-onnx) must read the
whole Call at once: run on one window at a time, the "Pessoa 1" of one window
is not the "Pessoa 1" of the next.

So the call's sound is kept in `audio/` until the Call stops and
the diarizer has read it, and is then deleted. **This reverses the rule that
a chunk is deleted as soon as Whisper has read it**, for the call's sound.
The mic's track is never diarized, and is still deleted at once.

## Considered Options

- **One window at a time.** Rejected: the labels change from window to
  window, which is no use to the Minutes.
- **A voiceprint per window, grouped by scribe.** It keeps numbers, not
  audio, but needs code of scribe's own over a library sherpa-onnx ships no
  program for. Kept for later, if keeping the audio proves wrong.

## Consequences

The audio still never leaves the machine, and is never kept past the Call.
Without the diarizer set, nothing changes: each chunk is deleted once Whisper
has read it, and the lines of the call's sound stay `Outros`.

A Call that is Cut leaves its sound behind. The next start deletes it
without telling its voices apart, as it makes no Minutes on its own: the
lines of that Call's sound stay `Outros`.

On Windows the call's sound is the whole machine's sound (ADR-0008), so any
other sound the machine plays is kept with it until the diarizer has read it.

Voices are named per Call. scribe keeps no voiceprint between Calls: it would
be biometric data of people who never agreed to it.

Status is proposed until a spike measures the diarizer on a real Call in
Portuguese.

## Spike results

Measured on 2026-10-12 for scribe#26. The verdict by ear is not here yet: the
operator gives it on a real Call in Portuguese of about 45 minutes, and then
sets the status.

### What was run

- sherpa-onnx v1.13.8, `sherpa-onnx-offline-speaker-diarization`.
- Segmentation: pyannote segmentation 3.0, `model.onnx`.
- Embedding: 3D-Speaker CAM++ trained on VoxCeleb
  (`3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`). VoxCeleb holds many
  languages. The model in sherpa-onnx's own example, ERes2Net base trained on
  Chinese, was measured too: it is three times slower, and no better on
  the test files.
- Settings: `--clustering.cluster-threshold=0.9` (the number of voices is not
  known before a Call), and `--segmentation.num-threads` and
  `--embedding.num-threads` equal. All else is the default. Both thread
  settings are 1 by default.
- Audio: 16 kHz mono 16-bit wav, as the program reads it.

### Time

On an AMD Ryzen 7 5700 (8 cores), in WSL2. Other work ran on the machine at
the same time (load average 2 to 9), so the times are an upper bound. The
audio is the four multi-speaker test files sherpa-onnx publishes, joined
17 times: 45.8 minutes. The times include the load of the models.

| System      | Build                     | Embedding | Threads | Time   | Per minute of audio |
| ----------- | ------------------------- | --------- | ------- | ------ | ------------------- |
| Linux x64   | shared                    | CAM++     | 1       | 463 s  | 10.1 s              |
| Linux x64   | shared                    | CAM++     | 4       | 213 s  | 4.7 s               |
| Linux x64   | shared                    | CAM++     | 8       | 342 s  | 7.5 s               |
| Linux x64   | shared                    | ERes2Net  | 1       | 1546 s | 33.8 s              |
| Windows x64 | static, MT-Release no-tts | CAM++     | 1       | 386 s  | 8.4 s               |
| Windows x64 | static, MT-Release no-tts | CAM++     | 4       | 202 s  | 4.4 s               |

The peak memory on Linux is 506 MB with CAM++, and 717 MB with ERes2Net.
Four threads are the fastest: eight compete with each other and with the
rest of the machine. So a Call of 45 minutes is told apart in about 3.5
minutes after Stop, with four threads, on both systems.

### Labels on the test files

How many labels each test file got, against how many voices it holds:

| Embedding, threshold | 0-four-speakers-zh (4) | 1-two-speakers-en (2) | 2-two-speakers-en (2) | 3-two-speakers-en (2) |
| -------------------- | ---------------------- | --------------------- | --------------------- | --------------------- |
| CAM++, 0.5           | 4                      | 2                     | 4                     | 3                     |
| CAM++, 0.7           | 3                      | 2                     | 3                     | 3                     |
| CAM++, 0.9           | 2                      | 2                     | 2                     | 2                     |
| ERes2Net, 0.5        | 7                      | 2                     | 4                     | 4                     |
| ERes2Net, 0.9        | 4                      | 1                     | 2                     | 4                     |

A smaller threshold gives more labels. When the number of voices is known,
`--clustering.num-clusters` takes it instead. The thread count does not
change the labels. On the 45-minute joined file, which holds ten voices in
two languages and is not like a Call, CAM++ at 0.9 gave 14 labels, and one
of them held 65% of all speech. So the test files cannot give the verdict.
A real Call must.

### Windows: the shared build does not run

The Windows x64 shared build (MD-Release) stops at once on this Windows 11
(build 26200): `The requested API version [28] is not available, only API
versions [1, 17] are supported in this build. Current ORT Version is:
1.17.1`. The program loads `C:\Windows\System32\onnxruntime.dll` (1.17, part
of Windows), and not the `onnxruntime.dll` 1.28.2 beside it. The same DLL
loads correctly by its full path. The static build (MT-Release, no-tts) has
ONNX Runtime inside the program, and runs. Its program is 17 MB, but its
archive is 239 MB, because it holds every program and static library. The
Windows build ran through WSL interop, from a copy under the Windows temp
directory. The Linux and Windows runs gave the same segments for the same
file.

### The bzip2 reader

Every asset is a tar.bz2, and `src/bzip2.ts` reads it with no dependency. All
three archives unpacked by `src/unpack.ts` are byte for byte the same as GNU
tar's. The Linux build (28 MB to 86 MB) unpacks in 3.9 s; the system's
`bzip2` takes 2.9 s. The static Windows build (239 MB to 1.3 GB) unpacks in
112 s, on a loaded machine.

### Assets

The SHA-256 is of the file as downloaded. #27 pins these.

| Asset | Size (bytes) | SHA-256 |
| ----- | ------------ | ------- |
| [sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2) | 28156791 | `c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4` |
| [sherpa-onnx-v1.13.8-win-x64-static-MT-Release-no-tts.tar.bz2](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-static-MT-Release-no-tts.tar.bz2) | 238840069 | `d2ce464a9e28d9128ab1fd15720df6f0e5e19053f725035d630af20a09c17e36` |
| [sherpa-onnx-v1.13.8-win-x64-shared-MD-Release.tar.bz2](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MD-Release.tar.bz2) (does not run, above) | 20494724 | `3e971a04b2e0ba4dfa53d381a006367ce8c9f5f09b4ae00043e9845c2baded22` |
| [sherpa-onnx-pyannote-segmentation-3-0.tar.bz2](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2) | 6958444 | `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488` |
| [3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx) | 29596978 | `357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b` |
| [3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx) | 39593761 | `1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b` |

Inside them: the pyannote `model.onnx` is 5992913 bytes,
`220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079`. The
Linux program is
`fbb2a4d5db13cac4824f3a70e5a5d8f6f7765e39fa5aadbaed53885426a3ede1`, and the
static Windows program is
`ad93ff8d5c248de36d7a0699ae6fcba0881f34eeb7f1902f3afedcfaeab7c8c0`.
The models' release tag is spelled `speaker-recongition-models` by
sherpa-onnx.

### For #27

- Windows needs the static build, or a way to make the shared build load
  its own ONNX Runtime. The static archive is 239 MB to fetch for 17 MB kept.
- Run with four threads.
- The threshold, or a number of voices the operator gives, is the
  operator's verdict to make on the real Call.
