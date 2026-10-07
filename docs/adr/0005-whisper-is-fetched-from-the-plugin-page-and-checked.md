# whisper.cpp and its model are fetched from the Plugin Page, checked by a pinned SHA-256

Since ADR-0004 an operator sets scribe up on its Plugin Page, but whisper.cpp
was still a thing to build: `git`, `cmake`, a C++ compiler, and a model
fetched by a script of whisper.cpp's. An operator of the FirstMate App, on
Windows above all, has none of these. FirstMate asks a Plugin to bring, or
fetch on first use, everything it needs (FirstMate's plugin guide, "Bring
everything you need").

So scribe's Plugin Page offers both, each on its own button:

- **A whisper.cpp build** for this system and architecture. whisper.cpp
  publishes one with each release on GitHub (`ggml-org/whisper.cpp`), under
  the nightly tag the release names: v1.9.4 is `b5130`. There is a zip for
  Windows x64 and arm64, and a tar.gz for Linux x64 and arm64, built on
  Ubuntu. macOS has only an xcframework, which is no program, so there the
  Page says how to build whisper-cli and keeps the path field.
- **A model**, which the operator chooses, from `ggerganov/whisper.cpp` on
  Hugging Face. It is a download of its own because it is hundreds of
  megabytes (`ggml-small.bin` is 488 MB) to a build's ten.

Nothing is fetched at `firstmate install`, at start, or by any tool but the
two the Page's buttons call.

## Every download is checked against a SHA-256 scribe already knows

whisper.cpp publishes no checksum file. GitHub gives each release asset a
`digest`, its SHA-256, and Hugging Face gives each file its Git LFS object id,
which is its SHA-256. scribe pins both, with each URL and size, in one data
file, `src/downloads.json`; they were checked against the bytes when they
were pinned. A model URL names a commit of the Hugging Face repository, not
`main`, so the bytes behind it never change. A newer whisper.cpp is a change to
that file and nothing else.

A download is streamed into a `.part` file beside where it will be kept, its
SHA-256 worked out as it comes. One that fails, goes quiet for
`SCRIBE_FETCH_IDLE_MS`, sends more than its size, or whose SHA-256 does not
match, is removed with everything it unpacked, and the Page shows one
sentence. Only a download that matched is renamed into `downloads/` in the
Plugin directory, and its absolute path written into `settings.json`, so
nothing else has to be set. `downloads/` is the Plugin's own, beside
`scribe.db` (FirstMate ADR-0005), and Git ignores it.

`SCRIBE_DOWNLOADS` names a list of the same form read in place of scribe's
own. It is how a test serves fixture archives from a local server with their
own checksums. Whoever sets it already sets `SCRIBE_WHISPER`, which names the
program scribe runs, so it trusts no one new.

## A build is unpacked by scribe's own reader

Node reads neither a zip nor a tar, and scribe takes no runtime dependency.
The systems' own programs differ: Windows 10 and later ships a `tar.exe` that
reads a zip, but GNU tar on Linux reads no zip, and `unzip` is not on every
Linux. A test on Linux would then never unpack what Windows unpacks.

So `src/unpack.ts` reads both, over `node:zlib`: the same code on every
system, about two hundred lines, and nothing in an archive runs. It reads what
whisper.cpp's archives hold — stored and deflated zip entries; ustar and GNU
tar, with their long names — and refuses the rest with a sentence: an
encrypted, split or ZIP64 zip, an entry of a kind it does not know. Every
entry must land inside the directory it is unpacked into; a name that is
absolute or climbs out with `..` is refused, and so is a link whose target is
not in the archive. A link is written as a copy of its target, because
Windows lets few accounts make one, and the Linux build names its libraries
through links (`libwhisper.so.1` → `libwhisper.so.1.9.4`). The build's
whisper-cli finds them beside it, by its `$ORIGIN` run path.

## Consequences

Setting a path by hand stays as it was, and a variable still beats the file
(ADR-0004): an operator who built whisper.cpp needs none of this.

A fetched build is whisper.cpp's CPU build. A CUDA or BLAS build is the
operator's to build or fetch, and to set by path.

The Linux builds need glibc 2.34 or newer and `libgomp.so.1`. Where either is
missing, whisper-cli does not start, and the Transcript fails as it would with
any whisper.cpp that does not run.

No test reaches the network. The pinned list is checked by hand when it
changes, and the fetch, the check and the unpacking are tested against a
local server, on Linux and on Windows, with both archive forms on both.
