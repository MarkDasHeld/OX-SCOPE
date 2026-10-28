OX-SCOPE 1.4 — Intel macOS BUILD PROJECT (NOT a precompiled Mac app)
==============================================================

Target: Intel MacBook Pro, macOS 15. No Homebrew required on the user's Mac.

WHAT IS NEW
- Bundled MediaRemote adapter for Telegram/other macOS Now Playing info and artwork.
- System audio stereo capture using ScreenCaptureKit.
- Native fullscreen and window resizing, compact foobar2000-inspired skin.
- WAV/M4A/MP3 file player, artwork extraction, append-only playlist.
- Bars, rolling spectrogram, stereo waveforms, true X/Y oscilloscope for local audio.
- System play/pause, stop, next, previous and seek controls via the bundled adapter.

DISTRIBUTION — BUILD ON GITHUB'S REAL INTEL MAC
1. Create a new GitHub repository, preferably private.
2. Upload the contents of THIS project directory, retaining .github/workflows/.
3. On GitHub, open Actions > Build OX-SCOPE Intel DMG > Run workflow.
4. After a successful run, download the OX-SCOPE-1.4-Intel-DMG artifact.
5. Unzip the artifact, open the .dmg, drag OX-SCOPE to Applications.
6. Launch OX-SCOPE and allow Screen & System Audio Recording when prompted.
   The application is ad-hoc signed but is NOT Apple notarized. macOS may show
   a security warning. Check the origin/source before choosing Open Anyway.

REALITY CHECK
- This archive contains source code and an automated macOS build workflow, NOT
  a compiled DMG. Do not rename this ZIP to .dmg. The DMG must be produced
  by the macOS build workflow, which checks for compile and packaging errors.
- The web player can be tested on Linux/Windows/macOS, but system-audio capture
  and macOS Now Playing metadata require a real Mac native build.
- The third-party adapter uses macOS private MediaRemote functionality. It's
  BSD-3-Clause licensed and works for many applications, but Apple can change
  this interface; app/media artwork cannot be absolutely guaranteed.
- A professional seamless public release would need Developer ID signing,
  Apple notarization, and tests on supported Mac models.

UPSTREAM METADATA COMPONENT
https://github.com/ungive/mediaremote-adapter
The GitHub build workflow downloads and builds this component on macOS and
bundles the upstream BSD-3-Clause license inside OX-SCOPE.app.
No Homebrew or other metadata CLI is needed on a recipient's Mac.

Troubleshooting: If GitHub Actions fails, read the failed job's exact Swift/CMake
error. Unlike the older OX-SCOPE .command scripts, this does not hide failures
behind a generic 'Process completed' message.
