This directory holds the packaged Python engine that ships with the installer:

  aivc-<version>-py3-none-any.whl   the `aivc` package (engine + CLI), installed with --no-deps
  requirements-torch.txt            torch/torchvision pins for Windows and Linux (cu130 index only)
  requirements-torch-macos.txt      torch/torchvision pins for macOS on Apple Silicon (PyPI, MPS)
  requirements.lock.txt             every other dependency, fully pinned
  bootstrap-engine.ps1              the installer script the app runs on Windows (copied from scripts/)
  bootstrap-engine.sh               the installer script the app runs on macOS and Linux (POSIX sh)
  uv-manifest.json                  pinned uv version + per-platform URL + sha256 the scripts download

On first run the app's pyenv.rs runs the script for its OS from this directory to build a
private virtual environment under the app data folder:
  Windows  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bootstrap-engine.ps1
           -> %LOCALAPPDATA%\net.markkulab.aivideocut\pyenv (Scripts\python.exe)
  macOS    bash bootstrap-engine.sh --data-root ...
           -> ~/Library/Application Support/net.markkulab.aivideocut/pyenv (bin/python)
  Linux    bash bootstrap-engine.sh --data-root ...
           -> ${XDG_DATA_HOME:-~/.local/share}/net.markkulab.aivideocut/pyenv (bin/python)
(uv -> venv 3.12 -> torch (cu130 on Windows/Linux, PyPI MPS on macOS) -> lock -> wheel ->
`aivc doctor` gate) and stores sha256(requirements.lock.txt) in pyenv/.stamp so a changed
lock shows up as "stale". The wheel's version must equal the app version: pyenv.rs picks the
matching wheel by file name and the engine's hello handshake rejects a mismatch.
AIVC_BOOTSTRAP_SCRIPT overrides the script location (offline / patched installs).

Only this README is in version control; `node scripts/build-engine-wheel.mjs` produces the
wheel (uv build) and copies the other files here before packaging (release.yml runs it
before tauri-action on every platform). During development the app uses the repo's engine/
directory (editable install via scripts/bootstrap-engine.ps1 or .sh) unless a wheel is present here.
