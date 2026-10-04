# 建立受管 Python 環境（與 App 的 pyenv.rs 步驟一致；純 CLI 使用者跑這支）。
#   .\scripts\bootstrap-engine.ps1 [-DataRoot <dir>] [-Wheel <aivc-x.y.z-py3-none-any.whl>] [-WithModels] [-SkipTorch]
# 步驟：磁碟檢查 → uv（釘版）→ venv(3.12) → torch cu130 → requirements.lock → aivc(wheel 或 editable)
#       → 外掛(同目錄的 aivc_*-*.whl 或 editable plugins\*\engine；開源版沒有) → doctor 閘門
# 兩種擺法（看同目錄有沒有 requirements.lock.txt）：
#   repo 的 scripts/               旁邊是 ../engine（開發期；沒帶 -Wheel 就 `-e engine`，外掛 `-e plugins\<名稱>\engine`）
#   安裝檔的 resources/engine/    腳本、aivc-*.whl、外掛的 aivc_*-*.whl、兩份 requirements、uv-manifest.json 全在同一目錄
#                                （build-engine-wheel.mjs 放的；App 的 pyenv.rs 從這裡呼叫，帶 -Wheel）
# uv 的版本 / URL / sha256 釘在同目錄的 uv-manifest.json：安裝檔絕不跑沒釘版的下載。
# App 以 powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 呼叫：這支不能有任何互動提示。
param(
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "net.markkulab.aivideocut"),
  [string]$Wheel = "",
  [switch]$WithModels,
  [switch]$SkipTorch
)
# App 以管線逐行讀本腳本的輸出（pyenv.rs run_streaming）。PowerShell 5.1 預設用 ANSI 代碼頁（zh-TW 是 cp950）寫管線，
# 中文 throw 原因（例如磁碟空間不足）到 Rust 端不是合法 UTF-8。一律改成 UTF-8（無 BOM）；Rust 端另有代碼頁解碼當保險。
# 沒有主控台可設時（某些宿主）會擲錯：吞掉，不能因為編碼設定讓安裝跑不起來。
try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
} catch { }
$ErrorActionPreference = "Stop"
if (Test-Path (Join-Path $PSScriptRoot "requirements.lock.txt")) {
  # 安裝檔擺法：requirements / wheel / manifest 都和本腳本同目錄
  $engine  = $PSScriptRoot
  $bundled = $true
} else {
  # repo 擺法：scripts/ 旁邊是 engine/
  $engine  = Join-Path (Split-Path -Parent $PSScriptRoot) "engine"
  $bundled = $false
}
$venv   = Join-Path $DataRoot "pyenv"
$tools  = Join-Path $DataRoot "tools\uv"
foreach ($d in @($DataRoot, $tools, (Join-Path $DataRoot "logs"), (Join-Path $DataRoot "models\hf"), (Join-Path $DataRoot "models\torch"))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
# doctor 閘門與模型下載要看到同一個資料根：引擎的 HF_HOME / TORCH_HOME 預設由 AIVC_DATA_ROOT 推出來（env.apply_model_env）。
# 沒設的話手動帶 -DataRoot 時，doctor / models pull 仍用 %LOCALAPPDATA% 的預設根，模型跑回系統碟（App 呼叫時 install_env 會帶，這裡補手動執行）。
# 轉成絕對路徑：-DataRoot .\data 這種相對寫法，子行程換了工作目錄就指到別處（與 .sh 版同規則）。
$env:AIVC_DATA_ROOT = (Resolve-Path -LiteralPath $DataRoot).ProviderPath
function Step($m) { Write-Host ("==> " + $m) }

# 0) 可用空間 >= 15 GB（venv ~6-7 GB + 模型 + proxy）
$driveName = (Get-Item $DataRoot).PSDrive.Name
$free = [math]::Round((Get-PSDrive $driveName).Free / 1GB, 1)
Step "free space on ${driveName}: $free GB"
if ($free -lt 15) { throw "需要至少 15 GB 可用空間（目前 $free GB）。用 -DataRoot 指到別的磁碟。" }

# 1) uv：版本 / URL / sha256 釘在同目錄的 uv-manifest.json。已有 uv 但不是 manifest 那個版本 → 重抓（換版只改 manifest）。
#    sha256 為 null（manifest 的 note 會說為什麼）時只能警告不擋，但版本字串一定要對。
$manifestPath = Join-Path $PSScriptRoot "uv-manifest.json"
if (-not (Test-Path $manifestPath)) { throw "缺 uv-manifest.json（應與本腳本同目錄）：$manifestPath" }
$uvm = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $uvm.version -or -not $uvm.url) { throw "uv-manifest.json 缺 version 或 url" }
$uv = Join-Path $tools "uv.exe"
$haveWanted = $false
if (Test-Path $uv) {
  $cur = & $uv --version
  if ($LASTEXITCODE -eq 0 -and "$cur" -match [regex]::Escape("uv $($uvm.version)")) {
    $haveWanted = $true
  } else {
    Write-Host "==> uv present but not $($uvm.version) ($cur) -> re-download"
  }
}
if (-not $haveWanted) {
  Step "download uv $($uvm.version) (pinned)"
  $zip = Join-Path $tools "uv.zip"
  Invoke-WebRequest -Uri $uvm.url -OutFile $zip -UseBasicParsing
  if ($uvm.sha256) {
    $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
    if ($got -ne "$($uvm.sha256)".ToLowerInvariant()) {
      Remove-Item $zip -Force
      throw "uv.zip sha256 不符：期望 $($uvm.sha256)，實際 $got（下載被竄改或 manifest 過期）"
    }
  } else {
    Write-Warning "uv-manifest.json 沒有 sha256：無法驗證下載內容，只比對版本字串"
  }
  Expand-Archive -Path $zip -DestinationPath $tools -Force
  Remove-Item $zip -Force
  $cur = & $uv --version
  if ("$cur" -notmatch [regex]::Escape("uv $($uvm.version)")) { throw "下載的 uv 是「$cur」，不是 manifest 的 $($uvm.version)" }
}
& $uv --version

# 2) venv；uv venv 在 Windows 有「exit 0 但 Scripts\ 空的」已知失敗 → 驗證後退回 stdlib venv
$py = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $py)) {
  Step "create venv (python 3.12)"
  & $uv venv --python 3.12 $venv
  if (-not (Test-Path $py)) {
    Step "uv venv left Scripts empty -> fallback: py -3.12 -m venv"
    py -3.12 -m venv $venv
  }
}
& $py --version
if ($LASTEXITCODE -ne 0) { throw "venv python 無法執行" }

# 3) torch：一個指令、一個 index、明確 +cu130（絕不從 PyPI 解析 torch）
if (-not $SkipTorch) {
  Step "install torch/torchvision from cu130 index"
  & $uv pip install --python $py --index-url https://download.pytorch.org/whl/cu130 -r (Join-Path $engine "requirements-torch.txt")
  if ($LASTEXITCODE -ne 0) { throw "torch 安裝失敗" }
}

# 4) 其餘依賴
Step "install requirements.lock.txt"
& $uv pip install --python $py -r (Join-Path $engine "requirements.lock.txt")
if ($LASTEXITCODE -ne 0) { throw "依賴安裝失敗" }

# 5) aivc：-Wheel 就裝內建 wheel（--reinstall：同版號重裝才會真的換掉舊碼）；
#    安裝檔擺法沒帶 -Wheel（手動執行）→ 挑同目錄的 aivc-*.whl；否則開發期 editable
if (-not $Wheel -and $bundled) {
  $found = @(Get-ChildItem -Path $PSScriptRoot -Filter "aivc-*.whl" | Sort-Object Name)
  if ($found.Count -eq 0) { throw "安裝檔裡沒有 aivc-*.whl：$PSScriptRoot" }
  $Wheel = $found[-1].FullName
}
if ($Wheel) {
  if (-not (Test-Path $Wheel)) { throw "找不到 wheel：$Wheel" }
  Step "install aivc (wheel)"
  & $uv pip install --python $py --no-deps --reinstall $Wheel
} else {
  Step "install aivc (editable)"
  & $uv pip install --python $py --no-deps -e $engine
}
if ($LASTEXITCODE -ne 0) { throw "aivc 安裝失敗" }

# 5b) 外掛（選用；引擎靠 entry point 群組 aivc.plugins 找到它們）：
#     有 wheel（-Wheel 或安裝檔擺法）→ 跟那個 aivc wheel 同目錄的 aivc_*-*.whl（私有版的 build-engine-wheel.mjs 才會放，開源版沒有）；
#     repo 擺法沒帶 -Wheel → repo 的 plugins\*\engine（editable）。
#     先移除 venv 裡所有已裝的外掛：換成開源版、或少了某個外掛時，上一版留下的不能繼續被 entry point 找到（同版號就整組復活）。
#     `==>` 行不放路徑：pyenv.rs 的 step_of_line 只認關鍵字（路徑裡剛好有 venv / torch 字樣會被歸到別的步驟）。
$pluginTargets = @()
if ($Wheel) {
  $wheelDir = Split-Path -Parent (Resolve-Path -LiteralPath $Wheel).ProviderPath
  $pluginTargets = @(Get-ChildItem -Path $wheelDir -Filter "aivc_*-*.whl" | Sort-Object Name | ForEach-Object { $_.FullName })
} else {
  $pluginRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "plugins"
  if (Test-Path $pluginRoot) {
    $pluginTargets = @(Get-ChildItem -Path $pluginRoot -Directory | Sort-Object Name | ForEach-Object { Join-Path $_.FullName "engine" } | Where-Object { Test-Path (Join-Path $_ "pyproject.toml") })
  }
}
# 只用單引號：PowerShell 5.1 傳給原生程式的引數裡的雙引號會被吃掉
$stale = @(& $py -W ignore -c "import importlib.metadata as m; print('\n'.join(sorted({d.metadata['Name'] for d in m.distributions() if d.metadata['Name'] and any(e.group == 'aivc.plugins' for e in d.entry_points)})))" | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) { throw "列出已安裝的外掛失敗" }
if ($stale.Count -gt 0) {
  Step "install aivc plugins: remove previously installed $($stale -join ', ')"
  & $uv pip uninstall --python $py @stale
  if ($LASTEXITCODE -ne 0) { throw "移除舊外掛失敗" }
}
foreach ($t in $pluginTargets) {
  if ($Wheel) {
    Step "install aivc plugin (wheel): $(Split-Path -Leaf $t)"
    & $uv pip install --python $py --no-deps --reinstall $t
  } else {
    Step "install aivc plugin (editable): $(Split-Path -Leaf (Split-Path -Parent $t))"
    & $uv pip install --python $py --no-deps -e $t
  }
  if ($LASTEXITCODE -ne 0) { throw "外掛安裝失敗：$t" }
}

# 6) 閘門
Step "gate: aivc doctor"
& $py -m aivc doctor
if ($LASTEXITCODE -ne 0) { throw "環境閘門未通過（exit $LASTEXITCODE）" }

# 7) 預先下載模型（選用）：`aivc models pull`（引擎 ops/models.py；small 一定會抓，--sam 指定的變體另外抓）。
#    失敗不擋安裝（與 .sh 同）：閘門已過，SAM 2.1 權重在第一次用到時也會自己下載；退出碼 4 = 連不上 / 權限 / 找不到模型庫。
#    -File 執行時最後一個原生指令失敗不會變成腳本的退出碼，所以要自己講一聲，免得使用者只看到錯誤訊息接著「OK」。
if ($WithModels) {
  Step "pull models"
  & $py -m aivc models pull --sam small
  if ($LASTEXITCODE -ne 0) { Write-Warning "模型預先下載失敗（exit $LASTEXITCODE）：第一次用到 SAM 2.1 時會自動下載" }
}
Write-Host ""
Write-Host "OK  python = $py"
