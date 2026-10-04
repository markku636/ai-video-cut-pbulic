# 架構（docs/architecture.md）

> 2026-10 更新到 v0.0.7：核心是通用的「追蹤任何東西 → 打碼／替換／加特效」，特定題材的功能一律做成外掛（`plugins/<id>/`）。
> 這裡只放速查、**現況**與「為什麼」。物件追蹤的資料格式見 [`tracking-api.md`](tracking-api.md)，自動更新與發版見 [`updater.md`](updater.md)，
> 序列剪輯與音訊的設計見 [`editor-m2-design.md`](editor-m2-design.md)。

```
┌ ai-video-cut（Tauri 2 桌面 App，Windows 優先）─────────────────────────────────────┐
│ React 18 + zustand   shell/（開始畫面、工具列、命令面板）  stage/（<video> proxy + canvas 疊層） │
│                      frametimeline/（自畫 canvas 時間軸，素材／序列兩種空間）                │
│                      inspector/（物件、追蹤、遮罩、字幕、片段、工作、歷史、建議、AI 助手）      │
│                      objects/ fx/（通用物件與特效）  commands/（一功能一 Command）            │
│                      store/edits（向量狀態 undo）  pipeline/（一個引擎 op 一支；jobId 過濾事件）│
│                      plugins/（外掛 API 與登記表；用 import.meta.glob 找 plugins/*/frontend）  │
│ Rust（src-tauri）    engine.rs（常駐 sidecar 監督、GPU Semaphore(1)）  pyenv.rs（受管 venv）   │
│                      media.rs ffmpeg.rs thumbs.rs peaks.rs project.rs store.rs proc.rs       │
│                      mcp.rs（內建 MCP server）agent.rs codex.rs（AI 助手 CLI 後端）           │
│                      updater.rs wheel_refresh.rs（自動更新、更新後換引擎 wheel）              │
└──────────┬──────────────────────────────────────────────────────────────────────────┘
           │ JSONL over stdin/stdout（大 payload 一律走檔案路徑）
   engine/（Python 3.12 venv @ %LOCALAPPDATA%\net.markkulab.aivideocut\pyenv）
   aivc = 套件 = CLI：media（索引／CFR／色彩／鏡頭／proxy）→ seg（SAM 2.1／SAM 3 遮罩）→ objects（ObjectTrack）
          → fx（打碼、調色、光暈、貼紙／文字）／track（平面追蹤）→ insert（平面替換）→ comp（比值重打光合成）
          → inpaint／bg／reframe／captions／asr → media/encoder（rawvideo → ffmpeg）→ export（Nuke／AE／JSON／遮罩序列）
   外掛：Python 套件經 entry point `aivc.plugins`（或 AIVC_PLUGINS）載入，透過 aivc.hooks 掛進核心
```

三層的分工只有一句話：**引擎擁有所有媒體邏輯，Rust 只做監督／設定／ffprobe／指紋／縮圖／檔案 IO／MCP 與更新，TS 擁有專案 schema 與 UI**。
CLI `aivc` 與 App 跑的是同一套 ops（sidecar 收到的 `args` 就是 CLI argparse 的 `vars(ns)`），所以「App 做得到、CLI 做不到」這種漂移在結構上不會發生；
格式產生器（編碼計畫、Nuke／AE 匯出）也**只有 Python 一份**，前端只顯示引擎回的文字。

## 核心的工作流程

1. **開檔**：Rust `media_probe`（ffprobe）＋ `media_fingerprint`（blake3(size ‖ head 4 MiB ‖ tail)，hex 前 16 碼＝快取目錄名，與 Python 逐位元相同）。
2. **索引與代理**（`media.index` / `media.proxy`）：完整解碼一趟建 `PtsIndex`；`CfrMap` 把 VFR 對到整數 proxy 幀 k，proxy 第 k 幀＝來源第 `map[k]` 幀；鏡頭切點在同一趟算出（`media.shots`）。
3. **找東西**：
   - **物件**（`seg.find` 打字找、`seg.select` 點／框，`objects.*`）：SAM 遮罩逐幀傳播成 `.aivm`，`objects/` 把它變成 ObjectTrack（錨點、外接框、方向角）；隱私打碼預設會替人臉、車牌自動加馬賽克。
   - **平面**（`track.solve`）：使用者拖四角（或從物件遮罩取四角）→ 模板→幀 SIFT ＋ `USAC_MAGSAC` ＋ `findTransformECC`，永不逐幀鏈接；靜止段鎖死、只平滑移動段 → `solve.v1.json`。
4. **做效果**：
   - **物件特效**（`fx.*`，`fx/`）：打碼（馬賽克／模糊）、調色、描邊光暈、跟著物件走的貼紙與文字；特效檔格式見 `tracking-api.md` §7。
   - **平面替換**（`insert/`，track 的 `replace`）：用圖片或影片取代追蹤到的表面，交給 `comp/compositor.py`（比值重打光、動態模糊、顆粒、遮擋 alpha）。
   - **移除物件**（`inpaint`）、**背景虛化／換色**（`bg`）、**自動重構圖**（`reframe`）、**動態字幕**（`asr` → `captions`）、**AI 配音**（`tts`，連使用者自架的 TTS 伺服器）。
5. **輸出**（`render.plan|run` → `pipeline/exportVideo.ts`）：來源只解一趟、proxy k → `map[k]`；**只寫回合成區域**，其餘 yuv420p 位元組原樣 → rawvideo → 內建 ffmpeg（`encode_plan.plan()` 純函式；webm → VP9 ＋ `-c:a copy`）、`.part` ＋ rename。序列（schema v2）照對應表剪接、混音。
6. **追蹤資料匯出**（`export.track`、`track-export`）：Nuke CornerPin2D、After Effects 關鍵幀、JSON／CSV／PNG 遮罩序列。

## 外掛機制

開源版只有核心；選配功能（例如 `plugins/cards`）是一個資料夾，裡面三塊各自被核心「找到」，核心**從不 import** 外掛的程式：

| 層 | 外掛放哪 | 核心怎麼找 | 接點 |
|---|---|---|---|
| 前端 | `plugins/<id>/frontend/index.ts`（default export `AivcPlugin`） | `src/plugins/index.ts` 的 `import.meta.glob`（資料夾不存在＝空物件） | `src/plugins/api.ts`：工作模式、開始畫面卡片、指令／選單／工具列、側欄分頁、舞台疊層、對話框、設定區段、專案檔的外掛鍵、列舉加值、建議、媒體資訊、離線元件清單、翻譯目錄… |
| 引擎 | `plugins/<id>/engine/`（Python 發行套件，例 `aivc-cards`） | entry point 群組 `aivc.plugins`，或 `AIVC_PLUGINS=模組名`；`AIVC_NO_PLUGINS=1`＝安全模式 | `aivc.hooks`：insert-source、param-group、schema-field、track-check、composite-mode、face-stage、track-method、op-args、content-note、render-finish；外掛也可以 `@aivc.ops.register` 自己的 op |
| 打包 | `plugins/<id>/tauri.conf.overlay.json` | `scripts/release-local.mjs --flavor <id>` 疊上去 | 私有建置用自己的更新來源與金鑰，不能發到公開 repo |

規則：
- **外掛擁有的專案檔鍵在磁碟上的名字與位置不變**；外掛不在時核心原樣保留（頂層走 project extras、track 走 extra、options／insert 走未知鍵保留），開源版開檔再存檔不會洗掉外掛的資料（`src/store/foreignKeys.test.ts`、`engine/tests/test_schema_ext.py`）。
- 列舉欄位（`regionPolicy`、`sheenLock`、`profile`）的磁碟值是相容值：核心認得 `full`／`hold`、`plate`、`generic`，外掛加的值（例如 `keepBarcode`、`card`、`cards`）沒有外掛時原樣保留。
- 壞掉的外掛不能拖垮核心：引擎把它這次登記的 op 與掛勾整批撤掉、`hello.loadErrors` 回報給 App。
- 翻譯：外掛自帶 `locales/en.ts`，載入語言時跟核心目錄合併（核心優先）；`check-i18n.mjs` 核心與外掛分開查。

## AI 助手與 MCP

- `mcp.rs`：內建 MCP server（Streamable HTTP、JSON-RPC 2.0），只綁 127.0.0.1、每次啟動隨機 bearer token；工具目錄由前端登記（`mcp_set_tools`），呼叫時發事件給前端執行再回寫。伺服器名 `aivc`（claude 的工具全名 `mcp__aivc__<tool>`）。
- `agent.rs`／`codex.rs`：驅動使用者本機的 `claude`／`codex` CLI，只連 App 內建的 MCP server（`--strict-mcp-config`），工作目錄是 App 設定目錄下的 `agent-workspace/`。
- 前端 `src/assistant/`：工具目錄（`catalogue.ts`）、對話面板；引擎端的 LLM 呼叫（章節、字幕校對）走 `aivc.llm.client`。

## 自動更新

`updater.rs`（檢查／下載／安裝、網址規則）＋ `wheel_refresh.rs`（更新後第一次啟動引擎時，把 venv 裡的核心與外掛 wheel 換成新版內建的，不重抓 torch）＋ `src/updater/`（狀態機、節流、設定頁、狀態列提示）。安裝檔一定要通過 minisign 簽章驗證；公鑰空白＝停用。細節見 [`updater.md`](updater.md)。

## solve.v1.json（平面追蹤的公開格式）

```
{ "version": 1, "trackId": "…", "shot": [k0, k1),          // proxy 幀號，k1 不含
  "referenceFrame": k | null,
  "template": { "w": W, "h": H },                           // 模板原生像素
  "frames": [ [k, h00, h01, h02, h10, h11, h12, h20, h21, conf, state], … ] }
```

- `H` 把**模板連續座標**（原點左上、Y 向下）映到**來源像素連續座標**，row-major，h22 正規化為 1。
- `state`：0 none／1 tracking／2 static／3 lost；LOST 幀的 8 個 h 是 `null`。`conf` ∈ [0,1]；合成器在 `conf < hold_below_conf`（預設 0.35）時不替換。
- 時間：k 是 CFR proxy 幀號；轉來源時刻用同快取的 `index.v1.json`（`CfrMap` runs），不要用 k/fps 反推來源 PTS。

## 契約速查（Rust ↔ TS ↔ Python 三方共用；版本欄位一律要有）

| 契約 | 所在 | 摘要 |
|---|---|---|
| 專案檔 `*.aivc.json` | TS `src/project/format.ts`（SoT）；Python `project/schema.py` 讀同一 JSON | `schemaVersion: 2`（v2＝序列與音訊）；camelCase；keyframes 存 quad 不存 H；`migrate()` 只在版本**大於**目前才擲錯；共用 fixture 在 `engine/tests/fixtures/project/`、`fixtures/project/` |
| 快取 `<app_cache_dir>/media/<fp16>/` | Rust `media.rs` 給路徑與 `cache_read`（拒絕 `..`／絕對路徑／junction 逃逸）；Python 寫 | `probe.v1.json index.v1.json shots.v1.json proxy.mp4 proxy.v1.json thumbs/ tracks/<id>/{masks.aivm, solve.v1.json, …}`；全部可重生 |
| 遮罩檔 `.aivm` | Python 寫、Rust 依 k 讀、TS worker 解 | `AIVM` magic + u32 version=1 + header + index + 逐幀 COCO RLE；golden 在 `engine/tests/fixtures/seg/` |
| 指紋 | Rust `ffmpeg.rs` 與 Python `media/fingerprint.py` | 逐位元相同；共用測試向量 `engine/tests/fixtures/media/fingerprint-vectors.json` |
| Sidecar 協定 | `engine/src/aivc/serve.py` ↔ `src-tauri/src/engine.rs` | 一行一 JSON；請求 `{id,op,args}`；事件 `progress`／`log`／`artifact{path}`；回覆**恰一次** `{id,ok,result｜error{kind,message,hint}}`；控制 op `hello`（比對協定與版本，回報已載入的外掛）／`ping`／`cancel{id}`／`shutdown` |
| 業務 op（＝CLI 子命令） | `engine/src/aivc/ops/*.py` 的 `@register` | `aivc --help` 列出全部；外掛的 op 只在外掛載入時出現 |
| Tauri 指令與事件 | `src-tauri/src/commands/mod.rs` ↔ `src/api.ts` | 指令 snake_case（TS 傳 camelCase）；事件處理器先過濾 `job_id` |
| 版號 | `package.json`（SoT）→ `scripts/sync-version.mjs` | 鏡射到 `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`engine/src/aivc/_version.py` 與外掛的 `_version.py` |
| 主題色 token | `tailwind.config.js` ↔ `src/themes.ts` | `check-theme-tokens.mjs` 守 |
| i18n | 繁中原文＝key；核心 `src/locales/en.ts`、外掛 `plugins/<id>/frontend/locales/en.ts` | `check-i18n.mjs` 掃 `t("…")` 與標籤表 |

## 引擎安裝與發版

- **開發機**：`scripts/bootstrap-engine.ps1`（UTF-8 BOM、CRLF）→ 釘版 uv（sha256 驗過）→ `uv venv --python 3.12` → torch／torchvision **cu130** → `requirements.lock.txt` → `-e engine`（或 wheel）→ `aivc doctor` 閘門。
- **安裝檔**：`scripts/build-engine-wheel.mjs` 把核心 wheel、外掛 wheel、兩份 requirements、bootstrap `.ps1`、`uv-manifest.json` 放進 `src-tauri/resources/engine/`。
- **ffmpeg**：`scripts/fetch-ffmpeg.mjs` 依 `ffmpeg-manifest.json`（LGPL shared build，URL ＋ sha256 釘死）解進 `src-tauri/resources/ffmpeg/`。
- **CI**：`npm run check`、`cargo test --no-default-features`、CPU `pytest`。發版：推 `v*` 標籤 → release workflow → GitHub Release。

## 儲存位置

- `app_local_data_dir()`（＝`%LOCALAPPDATA%\net.markkulab.aivideocut`，**不是** Roaming）：`pyenv/ models/ tools/uv logs/`；`engine.dataRoot` 設定可整體搬到別的磁碟。
- `app_cache_dir()/media/<fp16>/`：所有衍生資料，快取缺就重生。
- `settings.json`（`store.rs`）：沒有任何金鑰欄位；外掛的設定鍵原樣保留（`AppSettings.extra`）。

## 祕密與隱私

沒有雲端依賴：影片、模型、推論全在本機；不上傳、不遙測、不用於訓練。`check-secrets.mjs` 掃 `hf_…` token 與 repo 內的 `*.aivc.json`（`fixtures/` 底下的 golden 例外，路徑一律用假路徑）。

## dev 鉤子（只在 debug build 生效）

- `AIVC_DEV_OPEN=<video|project>`：啟動即開檔；`window.__aivc`（`src/devBridge.ts`）：store 與自動化橋接（外掛可以多掛自己的東西）。
- `AIVC_PYTHON=<python.exe>`：覆寫引擎 Python（`AIVC_PYTHON → 受管 venv → 錯誤`，絕不退回 PATH——PATH 上的 torch 多半是 CPU 版）。
- `AIVC_FFMPEG_DIR=<dir>`：覆寫 ffmpeg 目錄（`AIVC_FFMPEG_DIR → resources/ffmpeg → PATH`）。
- 截圖：`scripts/make-screenshots.mjs`（外掛的場景放 `plugins/<id>/scripts/screenshots.mjs`）。
