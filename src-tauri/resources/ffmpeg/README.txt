This directory holds the bundled FFmpeg (BtbN n8.1.2 shared build, LGPL-3.0-or-later,
dynamically linked) that ships with the Windows installer: ffmpeg.exe, ffprobe.exe and
their av*/sw* DLLs.

You may replace them with your own build of FFmpeg - keep ffmpeg and ffprobe in the
same directory. AI Video Cut also prefers any ffmpeg found on your PATH over this copy,
and Settings -> ffmpeg path overrides both. The Python engine reads the same directory
through the AIVC_FFMPEG_DIR environment variable that the app sets when it starts it.

See THIRD-PARTY-NOTICES.txt for the license and where to get the source.

The binaries themselves are not in version control; CI fetches them with
`node scripts/fetch-ffmpeg.mjs` (pinned URL + sha256) before packaging.
