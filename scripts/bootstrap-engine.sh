#!/bin/sh
# 建立受管 Python 環境（macOS / Linux 版；Windows 是同目錄的 bootstrap-engine.ps1，兩支步驟與 `==>` 行必須一致）。
#   sh scripts/bootstrap-engine.sh [--data-root DIR] [--wheel aivc-x.y.z-py3-none-any.whl] [--with-models] [--skip-torch]
# 步驟：平台與 ffmpeg 檢查（下載任何東西之前）→ 磁碟檢查 → uv（釘版）→ venv(3.12) → torch（Linux cu130 / macOS PyPI MPS）
#       → requirements.lock → aivc(wheel 或 editable) → 外掛(同目錄的 aivc_*-*.whl 或 editable plugins/*/engine；開源版沒有)
#       → doctor 閘門 → [--with-models] 預先下載 SAM 2.1
# 兩種擺法（看同目錄有沒有 requirements.lock.txt）：
#   repo 的 scripts/               旁邊是 ../engine（開發期；沒帶 --wheel 就 `-e engine`，外掛 `-e plugins/<名稱>/engine`）
#   安裝檔的 resources/engine/    腳本、aivc-*.whl、外掛的 aivc_*-*.whl、requirements、uv-manifest.json 全在同一目錄
#                                （build-engine-wheel.mjs 放的；App 的 pyenv.rs 從這裡呼叫，帶 --wheel）
# uv 的版本 / URL / sha256 釘在同目錄的 uv-manifest.json 的 assets（每個平台一行）：安裝檔絕不跑沒釘版的下載。
# App 的 pyenv.rs 以 `bash <本檔> --data-root <dir> [--wheel <whl>] [--with-models]` 呼叫（不靠執行權限位元：
# 安裝檔裡的資源檔不保證有 +x）：這支不能有任何互動提示。內容刻意寫成 POSIX sh，手動 `sh` 執行也一樣 ——
# Ubuntu 的 /bin/sh 是 dash、macOS 的 bash 是 3.2；CI 以 `sh -n` + shellcheck -s sh 把關，別用 bash 專屬語法。
# pyenv.rs 的 step_of_line 只認 `==> ` 行的關鍵字（ffmpeg / free space / venv / download uv / torch / requirements.lock /
# install aivc / gate / models）：改字之前先看那支函式與它的測試。
set -eu

APP_ID="net.markkulab.aivideocut"
MIN_FREE_GB=15
CU130_INDEX="https://download.pytorch.org/whl/cu130"

say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
warn() { printf '%s\n' "警告：$*" >&2; }
die() {
  printf '%s\n' "錯誤：$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：sh bootstrap-engine.sh [--data-root DIR] [--wheel PATH] [--with-models] [--skip-torch]
  --data-root DIR  資料根（預設與 App 相同：macOS ~/Library/Application Support/net.markkulab.aivideocut，
                   Linux ${XDG_DATA_HOME:-~/.local/share}/net.markkulab.aivideocut）
  --wheel PATH     安裝指定的 aivc wheel（預設：安裝檔擺法挑同目錄的 aivc-*.whl，repo 擺法 editable 安裝 engine/）
  --with-models    閘門通過後預先下載 SAM 2.1 權重（沒有這步也會在第一次使用時下載）
  --skip-torch     不裝 torch（已自行裝好時用；之後的 doctor 閘門仍會檢查）
也接受 PowerShell 版的寫法 -DataRoot / -Wheel / -WithModels / -SkipTorch。
EOF
}

DATA_ROOT=""
WHEEL=""
WITH_MODELS=0
SKIP_TORCH=0
while [ $# -gt 0 ]; do
  case $1 in
    --data-root | -DataRoot)
      [ $# -ge 2 ] || die "$1 後面要接目錄"
      DATA_ROOT=$2
      shift 2
      ;;
    --data-root=*)
      DATA_ROOT=${1#*=}
      shift
      ;;
    --wheel | -Wheel)
      [ $# -ge 2 ] || die "$1 後面要接 wheel 路徑"
      WHEEL=$2
      shift 2
      ;;
    --wheel=*)
      WHEEL=${1#*=}
      shift
      ;;
    --with-models | -WithModels)
      WITH_MODELS=1
      shift
      ;;
    --skip-torch | -SkipTorch)
      SKIP_TORCH=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "不認得的參數：$1（--help 看用法）" ;;
  esac
done

# 腳本所在目錄：App 以絕對路徑呼叫；手動 `sh bootstrap-engine.sh` 時 $0 不含斜線 → 就是目前目錄。
# 路徑可能有空白（macOS 的 "Application Support"、"AI Video Cut.app"），所有展開一律加引號。
case $0 in
  */*) SCRIPT_DIR=$(CDPATH='' cd -- "${0%/*}" && pwd -P) ;;
  *) SCRIPT_DIR=$(pwd -P) ;;
esac

# ---- 平台：決定 uv 資產、torch 來源與預設資料根（必須等於 Tauri 的 app_local_data_dir，否則 App 找不到 venv）
OS_NAME=$(uname -s)
ARCH=$(uname -m)
case $OS_NAME in
  Darwin)
    PLATFORM=macos
    # Rosetta 裡開的終端機 uname -m 會說 x86_64，但機器其實是 Apple Silicon：照 arm64 裝（uv 與 Python 都是原生 arm64）
    if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      ARCH=arm64
    fi
    case $ARCH in
      arm64 | aarch64) UV_TRIPLE=aarch64-apple-darwin ;;
      x86_64)
        UV_TRIPLE=x86_64-apple-darwin
        # PyTorch 從 2.3 起不再出 Intel Mac 的 wheel（torch 2.14.0 只有 macosx_14_0_arm64）：裝下去一定在 torch 那步失敗，
        # 與其讓人下載半天，不如一開始就講清楚。--skip-torch（自己處理 torch）才放行。
        if [ "$SKIP_TORCH" != 1 ]; then
          die "不支援 Intel Mac：PyTorch 2.14 沒有 macOS x86_64 版本，引擎只支援 Apple Silicon（M1 以後）的 macOS 14 以上"
        fi
        warn "Intel Mac 且帶了 --skip-torch：torch 要自己處理，doctor 閘門多半不會過"
        ;;
      *) die "不支援的 macOS 架構：$ARCH" ;;
    esac
    # torch 2.14 與 av 18.1 的 arm64 wheel 標籤都是 macosx_14_0：13 以下 uv 解不出來，先擋
    MACOS_VER=$(sw_vers -productVersion 2>/dev/null || echo 0)
    MACOS_MAJOR=${MACOS_VER%%.*}
    case $MACOS_MAJOR in
      '' | *[!0-9]*) MACOS_MAJOR=0 ;;
    esac
    if [ "$MACOS_MAJOR" -lt 14 ]; then
      die "需要 macOS 14 (Sonoma) 以上（torch / av 的 Apple Silicon wheel 最低 macOS 14.0），目前是 $MACOS_VER"
    fi
    ;;
  Linux)
    PLATFORM=linux
    case $ARCH in
      x86_64 | amd64) UV_TRIPLE=x86_64-unknown-linux-gnu ;;
      *) die "不支援的 Linux 架構：$ARCH（只支援 x86_64 + NVIDIA GPU，torch 走 CUDA 13.0）" ;;
    esac
    # 支援基準是 glibc 2.35（Ubuntu 22.04 / Debian 12）：App 的 deb / AppImage 在 22.04 上建、README 與 release notes 也寫 2.35。
    # torch 的 manylinux_2_28 wheel 在更舊的系統雖然裝得起來，但那不是測過、承諾支援的組合；
    # 各處訊息統一講 2.35，免得使用者看到腳本說 2.28、README 說 2.35 而不知道該信哪個。
    # 在下載任何東西之前擋：不然 6-7 GB 下載完才在某個原生套件上失敗。
    # musl（Alpine 等）：torch 只有 glibc 的 manylinux wheel、uv 也是 gnu 版，完全裝不起來。
    if ldd --version 2>&1 | grep -qi musl; then
      die "不支援 musl libc（Alpine 等）：需要 glibc 2.35 以上的發行版（Ubuntu 22.04 / Debian 12 或更新）"
    fi
    # getconf GNU_LIBC_VERSION 印「glibc 2.35」；讀不到（非常規環境）只警告，不因為偵測不到就擋掉可能可用的系統
    GLIBC_VER=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}') || GLIBC_VER=""
    case $GLIBC_VER in
      [0-9]*.[0-9]*)
        GLIBC_MAJOR=${GLIBC_VER%%.*}
        GLIBC_MINOR=${GLIBC_VER#*.}
        GLIBC_MINOR=${GLIBC_MINOR%%.*}
        case $GLIBC_MAJOR$GLIBC_MINOR in
          *[!0-9]*) warn "看不懂 glibc 版本「$GLIBC_VER」：略過版本檢查（需要 glibc 2.35 以上）" ;;
          *)
            if [ "$GLIBC_MAJOR" -lt 2 ] || { [ "$GLIBC_MAJOR" -eq 2 ] && [ "$GLIBC_MINOR" -lt 35 ]; }; then
              die "需要 glibc 2.35 以上（Ubuntu 22.04 / Debian 12 或更新），目前是 $GLIBC_VER"
            fi
            ;;
        esac
        ;;
      *) warn "讀不到 glibc 版本（getconf GNU_LIBC_VERSION 失敗）：略過版本檢查（需要 glibc 2.35 以上）" ;;
    esac
    ;;
  *) die "不支援的作業系統：$OS_NAME（Windows 請用 bootstrap-engine.ps1）" ;;
esac

# ---- ffmpeg：必須在建立任何目錄、下載任何東西之前確認
# macOS / Linux 版不內建 ffmpeg（用 Homebrew / 發行版的）。最後的 doctor 閘門找不到 ffmpeg 一定失敗，
# 不先查的話 uv + Python + torch（6-7 GB）全部下載完，使用者等了半小時才看到「找不到 ffmpeg」，而且留下一個閘門沒過的 venv。
# 找法與引擎 env.ffmpeg_dir() 同順序、同規則（ffmpeg 與 ffprobe 必須在同一個目錄），這裡判定可用、閘門就不會說找不到：
#   AIVC_FFMPEG_DIR → PATH 上 ffmpeg 所在目錄 → 常見安裝目錄（清單與 env._common_ffmpeg_dirs 相同）。
# 引擎的「內建 resources/ffmpeg」那一層在 macOS / Linux 只有 README.txt，這裡不查。
# App 解析到 ffmpeg 時會以 AIVC_FFMPEG_DIR 傳進來（Finder 開的 App 的 PATH 沒有 /opt/homebrew/bin），所以通常第一層就中。
ffmpeg_install_hint() {
  if [ "$PLATFORM" = macos ]; then
    printf '%s' "brew install ffmpeg（還沒有 Homebrew：先照 https://brew.sh 安裝）"
  elif command -v apt-get >/dev/null 2>&1; then
    printf '%s' "sudo apt install ffmpeg"
  elif command -v dnf >/dev/null 2>&1; then
    # 官方庫的 ffmpeg-free 沒有 libx264，proxy 會一路退到 mpeg4；完整 ffmpeg 在 RPM Fusion（與 App 橫幅的建議一致）
    printf '%s' "先啟用 RPM Fusion，再 sudo dnf install ffmpeg"
  elif command -v pacman >/dev/null 2>&1; then
    printf '%s' "sudo pacman -S ffmpeg"
  elif command -v zypper >/dev/null 2>&1; then
    printf '%s' "sudo zypper install ffmpeg"
  else
    printf '%s' "用發行版的套件管理員安裝 ffmpeg（Debian / Ubuntu：sudo apt install ffmpeg；Fedora：先啟用 RPM Fusion 再 sudo dnf install ffmpeg）"
  fi
}

ffmpeg_pair_in() {
  [ -f "$1/ffmpeg" ] && [ -f "$1/ffprobe" ]
}

# 印出引擎會選中的那個目錄（找不到回 1）。只取「第一個」有成對檔案的目錄：引擎也只取第一個，
# 就算後面的目錄比較好也輪不到 —— 所以第一個壞了要照實講，不能默默跳到下一個讓這裡與閘門 / 執行期的結果不一致。
resolve_ffmpeg_dir() {
  if [ -n "${AIVC_FFMPEG_DIR:-}" ]; then
    if ffmpeg_pair_in "$AIVC_FFMPEG_DIR"; then
      printf '%s\n' "$AIVC_FFMPEG_DIR"
      return 0
    fi
    # 引擎對這種情況也是靜靜略過往下找；這裡多講一句，免得使用者以為設定生效了
    warn "AIVC_FFMPEG_DIR=$AIVC_FFMPEG_DIR 裡沒有成對的 ffmpeg 與 ffprobe：忽略，改找 PATH 與常見目錄"
  fi
  ff_on_path=$(command -v ffmpeg 2>/dev/null) || ff_on_path=""
  case $ff_on_path in
    /*)
      ff_path_dir=${ff_on_path%/*}
      ff_path_dir=${ff_path_dir:-/}
      if [ -f "$ff_path_dir/ffprobe" ]; then
        printf '%s\n' "$ff_path_dir"
        return 0
      fi
      ;;
  esac
  for d in /opt/homebrew/bin /opt/homebrew/opt/ffmpeg-full/bin /usr/local/bin /usr/local/opt/ffmpeg-full/bin \
    /home/linuxbrew/.linuxbrew/bin "${HOME:+$HOME/.linuxbrew/bin}" /opt/local/bin /usr/bin "${HOME:+$HOME/.local/bin}"; do
    # HOME 沒設時那兩項展開成空字串：跳過，不能拼成 /.linuxbrew/bin 這種相對於根目錄的路徑
    [ -n "$d" ] || continue
    if ffmpeg_pair_in "$d"; then
      printf '%s\n' "$d"
      return 0
    fi
  done
  return 1
}

FFMPEG_DIR=$(resolve_ffmpeg_dir) || FFMPEG_DIR=""
if [ -z "$FFMPEG_DIR" ]; then
  die "找不到 ffmpeg / ffprobe（找過 AIVC_FFMPEG_DIR、PATH、/opt/homebrew/bin、/usr/local/bin、/usr/bin 等常見目錄）。macOS / Linux 版不內建 ffmpeg，請先安裝：$(ffmpeg_install_hint)；裝好後再執行一次（App 裡按「安裝引擎」）。還沒有下載任何東西。"
fi
# 有檔案不代表能跑：brew 升級後缺 dylib、沒有執行權限、別的架構的 binary。引擎只看檔案在不在，壞的也會被選中；
# 閘門的 `ffmpeg -version` 只有在根本啟動不了時才記成問題（缺 dylib 時行程照樣起來、只是非 0 結束，閘門照過）——
# 要到建 proxy 時才炸，所以在這裡把關。
if ! "$FFMPEG_DIR/ffmpeg" -version >/dev/null 2>&1 || ! "$FFMPEG_DIR/ffprobe" -version >/dev/null 2>&1; then
  die "$FFMPEG_DIR 的 ffmpeg / ffprobe 無法執行（-version 失敗：缺動態函式庫、沒有執行權限或架構不符）。請重新安裝：$(ffmpeg_install_hint)；或設定 AIVC_FFMPEG_DIR 指到可用的目錄。還沒有下載任何東西。"
fi
FFMPEG_VERSION=$("$FFMPEG_DIR/ffmpeg" -version 2>/dev/null | awk 'NR==1 {print $3; exit}') || FFMPEG_VERSION=""
step "ffmpeg: $FFMPEG_DIR/ffmpeg ${FFMPEG_VERSION:-(version unknown)}"
# 之後的 doctor 閘門與模型步驟用同一份（也蓋掉上面被忽略的無效 AIVC_FFMPEG_DIR）
export AIVC_FFMPEG_DIR="$FFMPEG_DIR"

if [ -z "$DATA_ROOT" ]; then
  [ -n "${HOME:-}" ] || die "HOME 沒有設定，請用 --data-root 指定資料根"
  if [ "$PLATFORM" = macos ]; then
    # dirs::data_local_dir() on macOS = ~/Library/Application Support
    DATA_ROOT="$HOME/Library/Application Support/$APP_ID"
  else
    # dirs::data_local_dir() on Linux = $XDG_DATA_HOME（必須是絕對路徑才採用）或 ~/.local/share
    case ${XDG_DATA_HOME:-} in
      /*) DATA_ROOT="$XDG_DATA_HOME/$APP_ID" ;;
      *) DATA_ROOT="$HOME/.local/share/$APP_ID" ;;
    esac
  fi
fi
mkdir -p "$DATA_ROOT"
# 轉成絕對路徑：venv 裡寫進去的路徑、最後印給 App / 使用者的 python 路徑都不能是相對的
DATA_ROOT=$(CDPATH='' cd -- "$DATA_ROOT" && pwd)

if [ -f "$SCRIPT_DIR/requirements.lock.txt" ]; then
  # 安裝檔擺法：requirements / wheel / manifest 都和本腳本同目錄
  ENGINE=$SCRIPT_DIR
  BUNDLED=1
else
  # repo 擺法：scripts/ 旁邊是 engine/
  ENGINE="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)/engine"
  BUNDLED=0
fi
VENV="$DATA_ROOT/pyenv"
TOOLS="$DATA_ROOT/tools/uv"
mkdir -p "$TOOLS" "$DATA_ROOT/logs" "$DATA_ROOT/models/hf" "$DATA_ROOT/models/torch"

# doctor 與模型下載要看到同一個資料根（HF_HOME 等模型快取由引擎依 AIVC_DATA_ROOT 推出來）；
# 沒帶的話自訂 --data-root 時模型會跑回預設位置。
export AIVC_DATA_ROOT="$DATA_ROOT"
export PYTHONUTF8=1
# uv 管理的 Python 放進資料根、而且只用 uv 管理的版本（下面 venv 帶 --managed-python）：
# macOS 上 Homebrew 的 python@3.12 一升級或 brew cleanup，指向它的 venv 就壞；Linux 發行版的 python3.12 也可能被移除。
# 放在資料根裡，venv 與它的底層直譯器同生共死，也跟著 15 GB 的空間檢查走。
export UV_PYTHON_INSTALL_DIR="$DATA_ROOT/tools/python"

# 0) 可用空間 >= 15 GB（venv ~6-7 GB + 模型 + proxy）；df -P 保證一個檔案系統一行、欄位固定
FREE_KB=$(df -Pk "$DATA_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
MOUNT_POINT=$(df -Pk "$DATA_ROOT" 2>/dev/null | awk 'NR==2 {m=$6; for (i=7; i<=NF; i++) m=m " " $i; print m}')
case $FREE_KB in
  '' | *[!0-9]*)
    step "free space on ${MOUNT_POINT:-$DATA_ROOT}: unknown"
    warn "讀不到 $DATA_ROOT 的可用空間（df 失敗），略過空間檢查"
    ;;
  *)
    FREE_GB=$(awk -v kb="$FREE_KB" 'BEGIN { printf "%.1f", kb / 1048576 }')
    step "free space on $MOUNT_POINT: $FREE_GB GB"
    if awk -v kb="$FREE_KB" -v min="$MIN_FREE_GB" 'BEGIN { exit !(kb < min * 1048576) }'; then
      die "需要至少 $MIN_FREE_GB GB 可用空間（目前 $FREE_GB GB）。用 --data-root 指到別的磁碟。"
    fi
    ;;
esac

# 殘留的 venv：沒有可執行的 bin/python 但 pyenv/ 還在（上次裝到一半、底層 Python 被刪掉）→ 建 venv 前要先清掉：
# `uv venv --clear` 只肯清「看得出是 venv」的資料夾，不像 venv 的（例如沒有 pyvenv.cfg）它會拒絕、要 --force，
# 接著退路 python3.12 -m venv 也會撞到同一個殘留 —— 而 App 沒有 stdin 可以回答任何提示。
# 但 rm -rf 之前一定要確定那是我們的東西（--data-root 可以是使用者指定的任何目錄），規則：
#   (a) 不是符號連結，實際路徑就是「資料根/pyenv」（連結目標可能是使用者別處的資料）；
#   (b) 頂層只有 venv 會出現的項目（uv / python -m venv 建的、pip 裝進 share/ etc/ 的、App 寫的 .stamp）。
# 任一條不符就停下來請人確認，絕不猜。驗證在下載 uv 之前先跑一次（不安全就別讓人白下載），真正刪除在 venv 那一步。
# --clear 仍保留在 uv venv 上，只是清完之後它面對的是不存在的目錄。
check_leftover_venv() {
  [ -e "$VENV" ] || [ -L "$VENV" ] || return 0
  if [ -L "$VENV" ]; then
    die "$VENV 是符號連結、裡面沒有可用的 python：為了不刪到連結目標的資料，安裝停止。請確認後自行移除或修好它，再執行一次。"
  fi
  [ -d "$VENV" ] || die "$VENV 不是資料夾：為了不刪到你的檔案，安裝停止。請移走它，或用 --data-root 指到別的目錄。"
  root_real=$(CDPATH='' cd -- "$DATA_ROOT" && pwd -P) || die "無法進入資料根 $DATA_ROOT"
  venv_real=$(CDPATH='' cd -- "$VENV" && pwd -P) || die "無法進入 $VENV：為了安全不刪除，安裝停止。"
  case $root_real in
    /) venv_expected=/pyenv ;;
    *) venv_expected="$root_real/pyenv" ;;
  esac
  [ "$venv_real" = "$venv_expected" ] ||
    die "$VENV 的實際位置 $venv_real 不在資料根 $root_real 底下：為了安全不刪除，安裝停止。"
  # 三個 glob 合起來列出所有頂層項目（含 dotfile、排除 . 與 ..）；沒有符合時 glob 原樣留下，用 -e / -L 濾掉
  for entry in "$VENV"/* "$VENV"/.[!.]* "$VENV"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    case $name in
      bin | lib | lib64 | include | share | etc | pyvenv.cfg | .gitignore | CACHEDIR.TAG | .lock | .stamp) ;;
      *) die "$VENV 裡有不屬於 venv 的「$name」：為了不刪到你的檔案，安裝停止。請確認內容後自行移走或刪除 $VENV（或用 --data-root 指到別的目錄），再執行一次。" ;;
    esac
  done
  return 0
}

remove_leftover_venv() {
  [ -e "$VENV" ] || [ -L "$VENV" ] || return 0
  check_leftover_venv
  step "remove incomplete venv at $VENV"
  rm -rf -- "$VENV"
}

PY="$VENV/bin/python"
if [ ! -x "$PY" ]; then
  check_leftover_venv
fi

# 1) uv：版本 / URL / sha256 釘在同目錄的 uv-manifest.json。已有 uv 但不是 manifest 那個版本 → 重抓（換版只改 manifest）。
#    macOS 內建的 python3 是會跳安裝視窗的 CLT 存根、也不保證有 jq，所以 manifest 刻意把每個平台的資產寫成一行，
#    這裡只用 sed 取值（build-engine-wheel.mjs --check 會用同一種規則驗證 manifest 的排版）。
#    與 ps1 不同：POSIX 平台的資產一定要有 sha256，沒有就拒絕（這些是後來才加的，沒有「舊 manifest 相容」的包袱）。
MANIFEST="$SCRIPT_DIR/uv-manifest.json"
[ -f "$MANIFEST" ] || die "缺 uv-manifest.json（應與本腳本同目錄）：$MANIFEST"
UV_VERSION=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -n 1)
[ -n "$UV_VERSION" ] || die "uv-manifest.json 缺 version"
ASSET_LINE=$(sed -n "/^[[:space:]]*\"$UV_TRIPLE\"[[:space:]]*:/p" "$MANIFEST" | head -n 1)
[ -n "$ASSET_LINE" ] || die "uv-manifest.json 的 assets 沒有 $UV_TRIPLE（這個平台不支援，或 manifest 過期）"
UV_URL=$(printf '%s\n' "$ASSET_LINE" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
UV_SHA=$(printf '%s\n' "$ASSET_LINE" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]*\)".*/\1/p' | tr 'A-F' 'a-f')
case $UV_URL in
  "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TRIPLE.tar.gz") ;;
  *) die "uv-manifest.json 的 $UV_TRIPLE url 不對（必須是 astral-sh/uv $UV_VERSION 的官方 tar.gz）：${UV_URL:-（空）}" ;;
esac
[ "${#UV_SHA}" -eq 64 ] || die "uv-manifest.json 的 $UV_TRIPLE 沒有 64 位 sha256：拒絕下載未驗證的執行檔"

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 30 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    printf '%s\n' "錯誤：需要 curl 或 wget 才能下載 uv" >&2
    return 1
  fi
}

sha256_of() {
  # Linux 有 sha256sum；macOS 沒有，但一定有 shasum（perl）；最後才退到 openssl
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

uv_is_wanted() {
  case $1 in
    "uv $UV_VERSION" | "uv $UV_VERSION "*) return 0 ;;
    *) return 1 ;;
  esac
}

UV="$TOOLS/uv"
HAVE_WANTED=0
CUR=""
if [ -x "$UV" ]; then
  CUR=$("$UV" --version 2>/dev/null) || CUR=""
  if uv_is_wanted "$CUR"; then
    HAVE_WANTED=1
  else
    say "==> uv present but not $UV_VERSION (${CUR:-unrunnable}) -> re-download"
  fi
fi
if [ "$HAVE_WANTED" != 1 ]; then
  step "download uv $UV_VERSION (pinned)"
  STAGE="$TOOLS/.download"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  ARCHIVE="$STAGE/uv.tar.gz"
  if ! download "$UV_URL" "$ARCHIVE"; then
    rm -rf "$STAGE"
    die "下載 uv 失敗：$UV_URL"
  fi
  GOT=$(sha256_of "$ARCHIVE")
  if [ "$GOT" != "$UV_SHA" ]; then
    rm -rf "$STAGE"
    die "uv 壓縮檔 sha256 不符：期望 $UV_SHA，實際 ${GOT:-（無法計算：沒有 sha256sum / shasum / openssl）}（下載被竄改或 manifest 過期）"
  fi
  if ! tar -xzf "$ARCHIVE" -C "$STAGE"; then
    rm -rf "$STAGE"
    die "解壓 uv 失敗：$ARCHIVE"
  fi
  # 官方 tarball 是 uv-<triple>/uv 與 uv-<triple>/uvx；不用 --strip-components（不是 POSIX tar 選項）
  SRC="$STAGE/uv-$UV_TRIPLE"
  [ -f "$SRC/uv" ] || SRC=$STAGE
  if [ ! -f "$SRC/uv" ]; then
    rm -rf "$STAGE"
    die "uv 壓縮檔裡找不到 uv 執行檔"
  fi
  for b in uv uvx; do
    if [ -f "$SRC/$b" ]; then
      mv -f "$SRC/$b" "$TOOLS/$b"
      chmod +x "$TOOLS/$b"
    fi
  done
  rm -rf "$STAGE"
  CUR=$("$UV" --version 2>/dev/null) || CUR=""
  uv_is_wanted "$CUR" || die "下載的 uv 是「${CUR:-無法執行}」，不是 manifest 的 $UV_VERSION"
fi
"$UV" --version

# 2) venv：ps1 在 Windows 要防「uv venv exit 0 但 Scripts\ 空的」；這裡同樣驗證直譯器真的在，不在就退回 stdlib venv。
#    殘留的 pyenv/ 已在下載 uv 之前驗過能不能安全刪除（check_leftover_venv），這裡才真的刪。
if [ ! -x "$PY" ]; then
  remove_leftover_venv
  step "create venv (python 3.12)"
  if ! "$UV" venv --managed-python --python 3.12 --clear "$VENV" || [ ! -x "$PY" ]; then
    step "uv venv failed -> fallback: python3.12 -m venv"
    command -v python3.12 >/dev/null 2>&1 ||
      die "uv 建不出 venv，PATH 上也沒有 python3.12（macOS：brew install python@3.12；Ubuntu：sudo apt install python3.12-venv）"
    # uv 失敗時可能留下半個 venv：同一套安全規則清掉
    remove_leftover_venv
    python3.12 -m venv "$VENV" || die "python3.12 -m venv 失敗"
  fi
fi
"$PY" --version || die "venv python 無法執行：$PY"

# 3) torch：一個指令、一個來源。
#    Linux：與 Windows 同一個 cu130 index 與同一份 requirements-torch.txt（明確 +cu130，絕不從 PyPI 解析出 CPU / cu12x 版）；
#    macOS：cu130 index 沒有 macOS wheel，PyPI 的 torch 就是帶 MPS 的官方版 → requirements-torch-macos.txt（不帶 +cu130）。
if [ "$SKIP_TORCH" != 1 ]; then
  if [ "$PLATFORM" = macos ]; then
    TORCH_REQ="$ENGINE/requirements-torch-macos.txt"
    [ -f "$TORCH_REQ" ] || die "缺 $TORCH_REQ"
    step "install torch/torchvision from PyPI (MPS)"
    "$UV" pip install --python "$PY" -r "$TORCH_REQ" ||
      die "torch 安裝失敗（macOS 需要 Apple Silicon + macOS 14 以上）"
  else
    TORCH_REQ="$ENGINE/requirements-torch.txt"
    [ -f "$TORCH_REQ" ] || die "缺 $TORCH_REQ"
    step "install torch/torchvision from cu130 index"
    "$UV" pip install --python "$PY" --index-url "$CU130_INDEX" -r "$TORCH_REQ" ||
      die "torch 安裝失敗（Linux 需要 x86_64 + glibc 2.35 以上）"
  fi
fi

# 4) 其餘依賴（torch 一定要先裝：accelerate 依賴 torch，先裝 lock 會從 PyPI 解出別的 torch）
step "install requirements.lock.txt"
"$UV" pip install --python "$PY" -r "$ENGINE/requirements.lock.txt" || die "依賴安裝失敗"

# 5) aivc：--wheel 就裝內建 wheel（--reinstall：同版號重裝才會真的換掉舊碼）；
#    安裝檔擺法沒帶 --wheel（手動執行）→ 挑同目錄的 aivc-*.whl（glob 已排序，取最後一個）；否則開發期 editable
if [ -z "$WHEEL" ] && [ "$BUNDLED" = 1 ]; then
  for f in "$SCRIPT_DIR"/aivc-*.whl; do
    if [ -f "$f" ]; then
      WHEEL=$f
    fi
  done
  [ -n "$WHEEL" ] || die "安裝檔裡沒有 aivc-*.whl：$SCRIPT_DIR"
fi
if [ -n "$WHEEL" ]; then
  [ -f "$WHEEL" ] || die "找不到 wheel：$WHEEL"
  step "install aivc (wheel)"
  "$UV" pip install --python "$PY" --no-deps --reinstall "$WHEEL" || die "aivc 安裝失敗"
else
  step "install aivc (editable)"
  "$UV" pip install --python "$PY" --no-deps -e "$ENGINE" || die "aivc 安裝失敗"
fi

# 5b) 外掛（選用；引擎靠 entry point 群組 aivc.plugins 找到它們；與 ps1 同規則）：
#     有 wheel（--wheel 或安裝檔擺法）→ 跟那個 aivc wheel 同目錄的 aivc_*-*.whl（私有版的 build-engine-wheel.mjs 才會放，開源版沒有）；
#     repo 擺法沒帶 --wheel → repo 的 plugins/*/engine（editable）。
#     先移除 venv 裡所有已裝的外掛：換成開源版、或少了某個外掛時，上一版留下的不能繼續被 entry point 找到（同版號就整組復活）。
#     `==>` 行不放路徑：pyenv.rs 的 step_of_line 只認關鍵字（路徑裡剛好有 venv / torch 字樣會被歸到別的步驟）。
# 不印換行（sys.stdout.write）：沒有外掛時輸出是真正的空字串
STALE_PLUGINS=$("$PY" -W ignore -c 'import importlib.metadata as m, sys; sys.stdout.write(" ".join(sorted({d.metadata["Name"] for d in m.distributions() if d.metadata["Name"] and any(e.group == "aivc.plugins" for e in d.entry_points)})))') ||
  die "列出已安裝的外掛失敗"
if [ -n "$STALE_PLUGINS" ]; then
  step "install aivc plugins: remove previously installed $STALE_PLUGINS"
  # 發行名稱只有英數與 - _ .：刻意不加引號，讓它依空白拆成多個參數
  # shellcheck disable=SC2086
  "$UV" pip uninstall --python "$PY" $STALE_PLUGINS || die "移除舊外掛失敗"
fi
if [ -n "$WHEEL" ]; then
  WHEEL_DIR=$(CDPATH='' cd -- "$(dirname -- "$WHEEL")" && pwd) || die "無法進入 wheel 所在目錄：$WHEEL"
  for f in "$WHEEL_DIR"/aivc_*-*.whl; do
    [ -f "$f" ] || continue
    step "install aivc plugin (wheel): ${f##*/}"
    "$UV" pip install --python "$PY" --no-deps --reinstall "$f" || die "外掛安裝失敗：$f"
  done
else
  for d in "${ENGINE%/engine}"/plugins/*/engine; do
    [ -f "$d/pyproject.toml" ] || continue
    plugin_name=${d%/engine}
    step "install aivc plugin (editable): ${plugin_name##*/}"
    "$UV" pip install --python "$PY" --no-deps -e "$d" || die "外掛安裝失敗：$d"
  done
fi

# 6) 閘門
step "gate: aivc doctor"
"$PY" -m aivc doctor || die "環境閘門未通過（exit $?）"

# 7) 預先下載模型（選用）：`aivc models pull`（引擎 ops/models.py 的 op models.pull；small 一定會抓，--sam 指定的變體另外抓）。
#    失敗不擋安裝（與 ps1 同）—— 閘門已過，SAM 2.1 權重在第一次用到時也會自己下載；退出碼 4 = 連不上 / 權限 / 找不到模型庫。
#    引擎沒有 models 指令的舊 wheel（例如 AIVC_BOOTSTRAP_SCRIPT 指到新腳本、--wheel 卻是舊版）直接略過，
#    而不是讓 argparse 的「invalid choice」看起來像安裝失敗。
if [ "$WITH_MODELS" = 1 ]; then
  step "pull models"
  if "$PY" -m aivc models --help >/dev/null 2>&1; then
    "$PY" -m aivc models pull --sam small || warn "模型預先下載失敗（exit $?）：第一次用到 SAM 2.1 時會自動下載"
  else
    say "（這個版本的 aivc 沒有 models 指令：略過，SAM 2.1 權重會在第一次使用時自動下載）"
  fi
fi
say ""
say "OK  python = $PY"
