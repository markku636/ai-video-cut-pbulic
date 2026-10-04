# App 自動更新（維護者手冊）

App 內建自動更新：啟動後約 10 秒在背景檢查（一天最多一次），找到新版就在狀態列提示「新版本 vX.Y.Z」；
按下去是更新對話框（這一版的說明、下載進度），按鈕有「稍後 / 略過這個版本 / 安裝並重新啟動」；下載中可以「取消下載」或「在背景繼續」。
使用者也可以從「說明 › 檢查更新…」或「設定 › 常用 › 更新」手動檢查、關掉自動檢查、覆寫更新來源。

這份文件寫給發版的人：金鑰怎麼產生、公鑰貼哪裡、GitHub secrets、怎麼發版、私有建置怎麼隔開、怎麼在本機做端到端測試。

## 運作方式（一段話版）

- 更新來源是 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints`，目前是
  `https://github.com/markku636/ai-video-cut-pbulic/releases/latest/download/latest.json`。App 讀這份 `latest.json`，版本比自己新才提示。
- 安裝檔一定要通過 **minisign 簽章驗證**才會安裝：私鑰在你手上（簽章），公鑰在 `plugins.updater.pubkey`（App 驗章）。
  **公鑰是空的時候自動更新整個停用**，設定頁會寫原因 —— 這是目前 repo 裡的狀態，等你產生金鑰後貼上公鑰才會啟用。
- 下載與安裝分兩步：先下載、驗簽章（使用者可以取消，或關掉對話框回去工作），**下載完才**再看一次有沒有工作在跑、
  專案有沒有沒存的變更（問過才裝）。在背景下載完的話，App 會把更新對話框叫回來等使用者按安裝，不會在他編輯到一半時自己關掉。
- 安裝時先舉「更新鎖」（之後引擎、ffmpeg、引擎安裝都開不起來），再停引擎（引擎自己取消工作、殺掉 ffmpeg）、收掉殘留的 ffmpeg，
  最後交給安裝程式：Windows 用 NSIS 的 passive 模式（只有進度條），裝完自動重新開啟；macOS / Linux 換掉 App 後自動重新啟動。
  有工作在跑、或 AI 助手之類的請求還在等回覆時不給裝。
- 更新後第一次啟動引擎時，App 會把 venv 裡的引擎 wheel 換成新版內建的（`uv pip install --offline --no-deps --reinstall`，
  核心 `aivc` 加上外掛 wheel），**不重抓 torch**，幾秒完成。只有 `requirements.lock.txt` 變了的版本才需要使用者到
  「設定 → 引擎」完整重裝（那時狀態會顯示 stale）。
- 程式碼：`src-tauri/src/updater.rs`（檢查 / 下載 / 安裝、網址規則）、`src-tauri/src/wheel_refresh.rs`（換引擎 wheel）、
  `src/updater/`（狀態機、節流、設定頁那一段、狀態列提示）、`src/dialogs/UpdateDialog.tsx`。

## 一次性設定

### 1. 產生簽章金鑰

在自己的電腦上跑（**不要**在 CI、也不要交給別人跑）：

```powershell
npx tauri signer generate -w "$env:USERPROFILE\.tauri\ai-video-cut-updater.key"
```

（cmd 寫法：`npx tauri signer generate -w %USERPROFILE%\.tauri\ai-video-cut-updater.key`）

它會問密碼，建議設一個。完成後有兩個檔：

| 檔案 | 是什麼 | 放哪裡 |
| --- | --- | --- |
| `ai-video-cut-updater.key` | 私鑰（簽章用） | 只留在你的電腦 + GitHub secret；**絕不 commit** |
| `ai-video-cut-updater.key.pub` | 公鑰（App 驗章用） | 內容貼進 `tauri.conf.json` |

**私鑰與密碼一定要另外備份。** 弄丟任何一個，已經安裝的 App 就再也收不到更新（只能請使用者手動重裝新的安裝檔）。

### 2. 把公鑰貼進設定檔

打開 `%USERPROFILE%\.tauri\ai-video-cut-updater.key.pub`，把**檔案內容**（一行 base64）貼到
`src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，然後 commit：

```json
"plugins": {
  "updater": {
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6…（你的公鑰內容）",
    "endpoints": ["https://github.com/markku636/ai-video-cut-pbulic/releases/latest/download/latest.json"],
    "dangerousInsecureTransportProtocol": true,
    "requireSignedVersion": true,
    "windows": { "installMode": "passive" }
  }
}
```

- 要貼**內容**，不是檔案路徑（建置工具吃路徑，App 不吃）。
- `dangerousInsecureTransportProtocol` 是給本機測試伺服器（`http://127.0.0.1`）用的：外掛自己的檢查在正式版會連本機 http 都擋。
  真正的規則在 `updater.rs` 的 `check_url_policy`（有單元測試）：一律 https，http 只准 localhost / 127.0.0.1 / ::1。
  不論來源是什麼，安裝檔都要通過簽章驗證才會裝。
- `requireSignedVersion` **要開著**（已經開了，`cargo test` 釘住）：`latest.json` 本身沒有簽章，簽章只保護安裝檔。
  不綁版本的話，拿得到 `latest.json` 的人（Release 寫入權限、外洩的 workflow token、或在設定頁填了別的來源）可以宣稱「99.0.0」、
  配上**舊版真的**安裝檔與 `.sig`，把使用者降級成舊版，之後也收不到真正的更新。
  開著時 `.sig` 的 trusted comment 必須帶 `version:` 而且等於 `latest.json` 的版本 —— `@tauri-apps/cli` **2.12 起** `tauri build`
  會自動寫（package.json 已升到 `^2.12.1`；`cargo test` 也釘住不能退回 2.11）。2.11 以前簽的 `.sig` 會被拒，
  所以第一個簽章版本就要用 2.12 以上建置；`scripts/lib/updater-manifest.mjs` 產生 `latest.json` 前會先檢查，對不上就不發。

### 3. GitHub secrets（CI 發版用）

在 repo 的 Settings → Secrets and variables → Actions 新增兩個（或用 gh，PowerShell 寫法）：

```powershell
Get-Content -Raw "$env:USERPROFILE\.tauri\ai-video-cut-updater.key" | gh secret set TAURI_SIGNING_PRIVATE_KEY -R markku636/ai-video-cut-pbulic
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R markku636/ai-video-cut-pbulic   # 會提示你輸入密碼；沒設密碼就略過
```

- `TAURI_SIGNING_PRIVATE_KEY`：私鑰檔的**內容**（不要貼進任何 issue、聊天、log；`release-local.mjs` 也絕不把這個環境變數的值印出來）。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：產生金鑰時設的密碼。
- `.env` 檔不會被讀：本機發版要用真的環境變數（下一節）。

### 4. 更新來源要改的時候（開源 repo 名稱定案後）

**只改一個地方**：`src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints`。

- `scripts/release-local.mjs` 的預設 repo 是從這個網址推出來的（`github.com/<owner>/<repo>/releases/…`）；
  CI 的 `release.yml` 用的是它自己所在的 repo，不用改。
- 已經裝好的舊版 App 只認它被建置時的網址：換 repo 之前最後一版要先發在舊網址，裡面帶新網址，使用者才跟得過去。
- 網址要能**匿名**下載：私有 repo 的 Release 檔案對外是 404（App 不會、也不該夾帶任何 token），
  而且 `/releases/latest/` 不含 draft 與 prerelease —— 目前的 repo 還是私有的，公開之前檢查更新一定是「沒有回應可用的版本資訊」。

## 發版

版號只改 `package.json`，再跑 `node scripts/sync-version.mjs` 同步到 Cargo.toml / tauri.conf.json / 引擎的 `_version.py`。
一般版號（`v0.0.8`）發成正式 Release 並標成 **Latest**，App 的預設來源才找得到；帶後綴的是 prerelease，App 不會自動找到。
後綴只准 `-alpha.N` / `-beta.N` / `-rc.N`（`sync-version.mjs` 會擋別的）：引擎 wheel 的檔名是 PEP 440 寫法（`0.0.8-beta.1` → `aivc-0.0.8b1-…whl`），
App 與 `build-engine-wheel.mjs` 只認得這三種的對照。

### 本機發版（Windows；GitHub Actions 被擋的期間用這個）

```powershell
# 金鑰只放在這個視窗的環境變數裡（路徑或內容都可以）；腳本不讀也不寫金鑰檔，交給 tauri CLI 讀，也不會把值印出來
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\ai-video-cut-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<產生金鑰時設的密碼>"

# 1) 乾跑：建引擎 wheel → 打 NSIS（帶 src-tauri/tauri.updater.conf.json，產生 .sig）→ 收檔 → 寫 latest.json，
#    只「印出」會跑的 gh 指令。產物在 release\v0.0.8\（gitignore）：AI.Video.Cut_0.0.8_x64-setup.exe、.sig、latest.json
node scripts/release-local.mjs --notes-file notes.txt

# 2) 確認沒問題、tag 已 push（git tag v0.0.8; git push origin v0.0.8）之後真的發：
#    建 draft → 上傳三個檔 → 轉正並標成 Latest。--skip-build 沿用剛剛建好的檔
node scripts/release-local.mjs --publish --skip-build --notes-file notes.txt
```

- `--notes` / `--notes-file` 是更新對話框裡「這一版的變更」，以純文字顯示。
- 本機發版**只有 Windows**：macOS / Linux 的 App 檢查更新會得到「這一版沒有提供這個平台的更新檔」（腳本會提醒）。
  三個平台都要就等 CI。
- 已經發布（不是 draft）的 Release 不會再往裡面上傳；要重發請換版本號。

### CI 發版（`.github/workflows/release.yml`）

推 `v*` tag 就會跑：三個平台各自建置（帶 updater overlay 與兩個 secrets）、上傳安裝檔與 `.sig`，
最後 `publish-release` 從這些 `.sig` 一次產生 `latest.json`（三個平台缺一個就丟錯、Release 留在 draft），再轉正並標成 Latest。

- 推 tag 時缺 secrets 或公鑰是空的，build 會直接失敗並說原因（沒有 `.sig` 的 Release，已安裝的 App 永遠更新不到）。
- `workflow_dispatch`（沒有 tag）沒有私鑰時照樣出安裝檔，只是不產生 `.sig`。
- macOS 建置帶 `--bundles app,dmg`：自動更新用的是 `.app.tar.gz`，只出 dmg 就沒有 macOS 的更新檔。

### 沒有私鑰的人怎麼建置

`createUpdaterArtifacts` 只放在 `src-tauri/tauri.updater.conf.json`（release overlay），基本設定檔沒有它：
`npx tauri build`、`npx tauri dev`、`npm run check`、`cargo test` 都不需要私鑰。只有帶了這個 overlay 的建置才會要求 `TAURI_SIGNING_PRIVATE_KEY`。

## 私有建置（含 cards 外掛）

私有建置多疊一層 `plugins/cards/tauri.conf.overlay.json`，裡面把 `plugins.updater.endpoints` 清成 `[]`，
並設 `"allowEndpointOverride": false`：

```powershell
npx tauri build --bundles nsis --config src-tauri/tauri.updater.conf.json --config plugins/cards/tauri.conf.overlay.json
```

- 這樣的私有版**自動更新是停用的**；設定頁的「更新來源」覆寫也不生效（`updater.rs` 的 `resolve_status`，有測試釘住）。
  開源版的 Release 永遠蓋不到私有版。
- **頻道要靠金鑰隔開，不是只靠網址。** 兩個版本的 identifier 一樣（`net.markkulab.aivideocut`），也就共用同一份 `settings.json`；
  同一把金鑰的話，任何一邊的安裝檔在另一邊都驗得過，一個留在設定裡的覆寫網址就能讓私有版被開源版蓋掉（反過來也一樣）。
  所以私有版要自動更新的話，**一定要另一把金鑰**，而且覆寫網址在私有版一律不看（`allowEndpointOverride: false`）。
- 想讓私有版也能自動更新：
  1. 另外產生一把金鑰（`npx tauri signer generate -w "$env:USERPROFILE\.tauri\ai-video-cut-cards-updater.key"`），私鑰同樣只留在自己電腦並備份。
  2. 在 `plugins/cards/tauri.conf.overlay.json` 的 `plugins.updater` 加上 `"pubkey": "<cards 公鑰內容>"`，
     並把 `endpoints` 改成私有頻道的網址（https，而且要能匿名下載 —— 私有 GitHub repo 不行，用自己的主機）。保留 `"allowEndpointOverride": false`。
  3. 發版時 `TAURI_SIGNING_PRIVATE_KEY` 設成 **cards 的私鑰**，再跑
     `node scripts/release-local.mjs --flavor cards --base-url https://<私有主機>/<路徑>/`，把 `release\v0.0.8-cards\` 裡的三個檔放上去。
- `release-local.mjs --flavor cards` 會擋：cards overlay 沒有自己的公鑰、或跟公開版同一把；沒有 `allowEndpointOverride: false`；
  `--repo` 是公開 repo（不分大小寫，`Markku636/AI-Video-Cut-Pbulic` 也算）；`--base-url` 指到公開 repo 的 Release。

## 端到端測試（本機 http 伺服器）

用正式版的安裝檔測（`npm run tauri dev` 的開發版不會背景檢查，安裝也會被拒）。

1. **準備金鑰**：用正式的金鑰，或另外產生一把測試用的
   （`npx tauri signer generate -w "$env:USERPROFILE\.tauri\aivc-test.key"`）並暫時把它的公鑰貼進 `tauri.conf.json`（測完改回、不要 commit）。
   設好 `TAURI_SIGNING_PRIVATE_KEY`（必要時 `_PASSWORD`）。
2. **舊版**：在目前版本（例如 0.0.7）建一個安裝檔並安裝：
   `node scripts/build-engine-wheel.mjs`，再 `npx tauri build --bundles nsis --config src-tauri/tauri.updater.conf.json`，
   裝 `src-tauri\target\release\bundle\nsis\` 裡的 setup.exe，開一次、裝好引擎、確認引擎能啟動。
3. **新版**：把 `package.json` 改成 0.0.8、跑 `node scripts/sync-version.mjs`，然後
   `node scripts/release-local.mjs --base-url http://127.0.0.1:8000/ --notes "測試更新"`
   → `release\v0.0.8\` 有安裝檔、`.sig`，以及 url 指到 `http://127.0.0.1:8000/…` 的 `latest.json`。
4. **伺服器**：`python -m http.server 8000 --directory release\v0.0.8`（或 `npx http-server release\v0.0.8 -p 8000`）。
5. **在已安裝的 0.0.7**：設定 › 常用 › 更新 › 更新來源（進階）填 `http://127.0.0.1:8000/latest.json` → 立即檢查
   → 對話框顯示 v0.0.8 與說明 → 安裝並重新啟動 → NSIS 進度條 → App 以 0.0.8 重新開啟。
   第一次啟動引擎時 `logs\bootstrap.log`（設定 › 引擎資料根底下）會多一段 `refresh bundled wheels`，引擎不再報版本不符。
6. 也測幾個會失敗的情況：改一個位元組的 `.sig` 或安裝檔（→「簽章驗證失敗，不安裝」）、輸出影片時按安裝（→ 拒絕並說明有工作在跑）、
   專案沒存時按安裝（→ 下載完先問要不要儲存）、關掉伺服器再檢查（背景檢查安靜失敗；手動檢查跳 toast）。
   下載中按「取消下載」（→ 回到「有新版本」）；按「在背景繼續」後回去改專案（→ 下載完對話框自己跳回來、停在「更新已下載」，
   按安裝才問存檔、才安裝）。
7. 測完：清掉更新來源覆寫、把版本號與測試公鑰改回來。

## 疑難排解

| 看到的訊息 | 原因 |
| --- | --- |
| 自動更新已停用：還沒有設定更新簽章的公鑰 | `plugins.updater.pubkey` 是空的（見「一次性設定」） |
| 更新來源沒有回應可用的版本資訊 | `latest.json` 404：repo 是私有的、Release 還是 draft / prerelease、或沒有上傳 latest.json |
| 這一版沒有提供這個平台的更新檔 | `latest.json` 缺這個平台（本機發版只有 Windows；macOS 沒帶 `app` bundle） |
| 更新檔的簽章驗證失敗，不安裝 | 簽章的私鑰與 App 裡的公鑰不是同一對，或檔案在傳輸中壞了 |
| 更新檔的簽章與宣告的版本不符，不安裝 | `.sig` 沒有 `version:`（用 2.12 以前的 tauri-cli 建的）或跟 `latest.json` 的版本不同（拿錯安裝檔、或有人竄改 `latest.json`） |
| 還有 N 個引擎請求在等回覆（例如 AI 助手） | AI 助手的對話還沒回來：等它完成再按安裝（已下載的安裝檔留著，不必重新下載） |
| 正在安裝 App 更新：引擎與 ffmpeg 已停用 | 安裝途中按了要用引擎或 ffmpeg 的功能：App 馬上會關閉、裝好後重新開啟 |
| 引擎版本 X 與 App 版本 Y 不同 | 更新後換 wheel 失敗（看 `logs\bootstrap.log`），到「設定 → 引擎」重新安裝 |

- Windows 的安裝程式會留在 `%TEMP%\AI Video Cut-<版本>-updater-*`，可以手動刪。
- NSIS 的 `/UPDATE` 模式不先解除安裝舊版：從安裝檔拿掉的檔案會留在安裝目錄（例如舊版的引擎 wheel）。
  App 只挑版本等於自己的 wheel，留著不影響。
