# 量測腳本（量尺）

這幾支不是測試，是**量尺**。

測試回答「行為有沒有變」，量尺回答「這個常數對不對」——後者沒有辦法用推理決定，只能拿真的影片去問。
每一支都應該對應到一次「本來以為 X，量了才知道是 Y」；還沒量過的先寫 TODO，**不要憑感覺填數字**。

兩種模式：

- **引擎模式** `aivc bench <name> <project> [--labels FILE] [--render OUT]`：純 Python，對著快取裡的 solve / 遮罩 / 渲染結果算數字，門檻不過就**非零退出**。
- **App 模式** `node scripts/measure/<name>.mjs`：透過 CDP（`cdp.mjs`）對著**跑起來的 App** 問——顯示的幀號、rVFC 掉幀這類東西只有 WebView2 裡才量得到。

量尺**不進 `npm run check`**：發版前跑，結果貼回下表「量出來過的事」（附版號），數字同時記進 `plugins/cards/docs/measurements.md`。

| 腳本 | 回答的問題 | 量出來過的事 |
| --- | --- | --- |
| `aivc bench-corners <project> --labels L.json` | 四角貼多準／會不會滑？門檻：靜止平均 ≤1.0 px 且 p@1≥0.9；移動 p@5≥0.90、p@15≥0.98；遠景 p@4% 平面長邊 ≥0.90（非零退出只看 p@5/p@15/靜止平均/遠景；p@1 記錄） | 2026-09-17 shot 3，**偵測器標記**（非真值）56 筆：p@5 0.643、p@15 1.000、STATIC 平均 4.95 px → FAIL，但只說明 tracker 與偵測器四角系統性差 2–11 px，誰對要人工標記；遠景 0 幀。詳見 plugins/cards/docs/measurements.md「E1 rulers (shot 3)」 |
| `aivc label-auto <project> --frame K … -o L.json`（cards 外掛） | 沒有人工真值時，bench-corners 的標記從哪來？偵測器四角＋白輪廓直線精修，寫 `"source": "detector"` 與警語（不是真值）；精修角點移動 > max(6 px, 10% 長邊) 退回精修前 | 2026-09-17 shot 3 十幀 → 56 筆（偵測器 50、退 solve 6）；護欄擋下 2 筆飛到 366 px 外的精修（Player1@1121/1134） |
| `aivc bench mask` | 手遮擋對不對？門檻：IoU≥0.90、2 px 邊界 F≥0.8 | TODO |
| `aivc bench-jitter <project>` | 靜止的平面會不會抖？門檻：STATIC 段二階差分 std＝0；TRACKING 段前／後對比 | 2026-09-17 shot 3：6 條 track 14 個 STATIC 段二階差分 max **0.0** → PASS；TRACKING 二階差分 std 平滑前 0.28–1.84 → 後 0.11–0.59 px |
| `aivc bench-outside <project> --render OUT [--range K0:K1]` | 沒動到的地方真的沒動？門檻：編碼前逐位元相同；渲染後遮罩外 PSNR≥45 dB（nvenc cq19）、ffv1 SSIM≥0.9999（實作：無損輸出要求排除區〔遮罩∪四角足跡或 --matte alpha，膨脹 3 px〕外逐位元相同；有損 PSNR≥45；SSIM 子門檻未做） | 2026-09-17 shot 3：ffv1 k=1091 逐位元相同 PASS；VP9 crf 24 全片 min 42.67 dB、111 幀 <45（全在未合成的 shot 2/4＝純重編碼損失）→ FAIL；只看 shot 3 min 45.32 dB PASS |
| `aivc bench-verify <project> --render OUT [--states static,tracking]`（cards 外掛） | 輸出裡每幀真的是目標牌？門檻：目標格位 ≥98% STATIC 幀正確；非目標格位 0 誤傷；VP9 對 ffv1 PSNR≥40 dB、位元率 ±30%（實作另加：原牌 margin >0.05 仍可讀＝失敗；VP9/ffv1 子門檻未做） | 2026-09-17 shot 3 STATIC：9D 238/238、AS 183/183、原牌可讀 0、附帶損害 616/616 → PASS。掃牌尾段 1215–1357 含 TRACKING：0/143、17/143 → FAIL（預期；H 已發散，量不到原牌可讀性，要人工看） |
| `node scripts/measure/ui-sweep.mjs` | 每個對話框與檢視器分頁打開來會不會壞？檢查崩潰 / console.error（含 React 警告）、開了是空的、畫面上出現 undefined／NaN／`[object Object]`／沒代換掉的 `{vars}` | 2026-09-19 首跑：**命令面板**每次開都噴一串「two children with the same key」而且沒渲染出來（有子項的指令的子項同時也註冊成頂層指令）。修掉之後 16 個對話框、8 個分頁全綠 |
| `aivc bench frame-map` | proxy 第 k 幀＝來源第 map[k] 幀？門檻：抽樣 50 幀逐位元比對 | TODO |
| `aivc bench color` | 有沒有 tv/pc 偏移？門檻：PyAV vs ffmpeg zscale 同幀均差 <1 | TODO |
| `aivc bench-speed RUN.jsonl` | 5090 上每段花多久、峰值 VRAM？門檻：記錄；60 s 全片 <5 min、<12 GB（依片長等比；吃 `aivc --json run` 的 stdout） | 2026-09-17 `run --shot 3`：255.7 s < 299.5 s、3744 MB → PASS，但只處理 1 個鏡頭，不是全片數字 |
| `seek-accuracy.mjs`（App） | 顯示幀號＝ffmpeg 抽出的幀？門檻：誤差 0 幀（`currentTime=(f+0.5)/fps` 的 +0.5 偏移就是靠它證明） | TODO（A0 出口條件，第一個要跑） |
| `scrub-drops.mjs`（App） | 拖時間軸掉幾幀？門檻：rVFC `presentedFrames` 差 | TODO |
| `seq-playback.mjs`（App） | 序列預覽播放（M2.11 / M2.16）：① 接點——播一條「連續切點＋同媒體跳接＋空白＋停用片段」的序列，畫面出現片段 `[srcIn, srcOut)` 以外的幀數＝0、每個接點頓挫 ≤150 ms、空白走時誤差 ≤50 ms；② 漂移——整支範例（約 60 s）一個片段＋A1 一段 WAV，每呈現一幀比「畫面序列位置」與「Web Audio 排程位置」，最大 \|漂移\| <40 ms 且漂移重排 0 次；③ CORS spike——asset protocol 上 `crossOrigin=anonymous` 的媒體元素接 MediaElementSource 有電平（>−90 dBFS） | 2026-09-17 v0.0.6（feat/editor-m2，範例 sample_clip1 proxy 30/1、RTX 5090 機）：① 片段外 **0** 幀、接點 5 個、頓挫 16–18 ms、空白 / 停用走時誤差 1–2 ms → PASS（修正前只靠 rAF 提前量時，序列尾巴暫停曾多呈現 1 幀片段外的幀，改成 rVFC 回報最後一幀就動手後歸零）；② 59.9 s、1793 次比對、漂移重排 0、\|漂移\| p50 8.2 / p95 15.7–22.9 / 最大 18.0–24.3 ms → PASS（修正前錨點取在開播第一幀，整段帶 −17 ms 偏差＋約 −0.8 ms/s 斜率，最大 38.2 ms 擦邊；改成暖機 300 ms 後偏差 >5 ms 重錨一次）；③ crossOrigin −41.1 dBFS、不設 −∞ → A0 走 GainNode 可行。注意：範例影片音軌本身是數位靜音（−91 dB），A0 電平量不出東西，所以 CORS 用測試音量 |
| `aivc bench stabilized` | 穩定視圖下靜止段真的不動？門檻：穩定化後 STATIC 段表面區逐幀 SSD 二階差分 std＝0；TRACKING 段記錄 | TODO |
| `aivc bench difference` | 遮罩外真的沒動（視覺版）？門檻：gain 4／gamma 2.2 差異圖在膨脹 alpha 外非黑像素數＝0 | TODO |
| `aivc bench grain-checker` | 顆粒對得上嗎？門檻：棋盤格 key-mix 後棋盤週期 FFT 峰值 < 背景 3σ | TODO |
| `aivc bench blur-length` | 動態模糊長度對嗎？門檻：快速翻轉幀的合成塗抹長度／原片塗抹長度 ∈ [0.8, 1.25]（180° 快門而非 360°） | TODO |
| `aivc bench export-roundtrip` | 匯出的角釘貼回去對得上嗎？門檻：由 `.nk`／AE 文字重建的四角 vs `solve.v1.json` 四角，最大誤差 <0.01 px | TODO |
| `aivc bench adjust-cost` | 修一段壞 track 要多久？門檻：修 12 幀 wall-clock < 全片重解的 1/50 | TODO |

## 怎麼跑（App 模式）

量尺要對著**跑起來的 App** 問（真資料在裡面：probe、解算、`<video>` 播放器），
所以先用開了偵錯埠的方式啟動，再跑腳本。

```powershell
# 1) 開 App（換成你自己的影片；A0 期間 proxy 由 E1 CLI 先產好放進快取）
$env:AIVC_DEV_OPEN = "D:\path\to\sample_clip1.webm"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222 --remote-allow-origins=*"
npm run tauri dev

# 2) 另一個終端機
node scripts/measure/seek-accuracy.mjs
node scripts/measure/scrub-drops.mjs
```

bash 的寫法是 `AIVC_DEV_OPEN=... npm run tauri dev`；PowerShell 沒有 `VAR=x cmd` 這種語法。

**跑一分鐘以上的量尺（`seq-playback.mjs`）要關掉 HMR**：量的途中有人存檔（或平行的 worktree 工作在改檔），
HMR 會換模組、甚至疊第二份 App，數字就不算數。不用 `tauri dev`，改成兩個終端機分開起：

```bash
# 1) 沒有 HMR / 檔案監看的前端（跟 vite.config.ts 相同，只關掉這兩樣）
npx vite --config scripts/measure/vite.measure.config.mjs
# 2) debug 版 App（--no-default-features = 不帶 custom-protocol，載入 devUrl http://localhost:1420；跟 cargo test 共用編譯產物，幾秒就好）
(cd src-tauri && cargo build --no-default-features)
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*" \
AIVC_DEV_OPEN="D:\path\to\sample_clip1.webm" ./src-tauri/target/debug/ai-video-cut.exe
# 3) 量（改了程式要重啟 1)、再 Page.reload：監看關掉之後 Vite 不會自己換新版）
AIVC_FFMPEG_DIR="<內建 ffmpeg 目錄>" node scripts/measure/seq-playback.mjs [--only boundaries|drift]
```

`seq-playback.mjs` 量完會把實驗旗標、時間軸空間、序列與音訊清單還原（WebView 的 localStorage 跟正式 App 共用同一個設定檔）。

引擎模式不需要 App：`aivc bench corners fixtures/sample/project.aivc.json --labels fixtures/sample/gt/corners.json`。

## 讀結果

- 每支量尺在數字明顯不對時標 `⚠` 並指出該回頭看哪個檔案（例：`seek-accuracy` 差 1 幀 → `src/video/frames.ts` 的 +0.5 偏移）。
- 門檻不過以**非 0 結束碼**退出——那是會**安靜**交出壞檔的那種錯（`outside` 過不了代表遮罩外被動到，看片是看不出來的）。

## 兩個會讓你白量的坑（沿自 ai-music-cut，機制相同）

1. **`#root` 只能有一個子節點。** 熱更新會把整棵 App 疊第二份上去（`createRoot`
   對同一個容器重跑），那時候量 DOM 會拿到兩份混在一起的答案。`waitReady` 會擋。
2. **`Runtime.evaluate` 要帶 `userGesture: true`。** 不帶的話播放相關的量測會被
   自動播放政策擋掉，而症狀是「全部回 0」，看起來像功能壞了。`cdp.mjs` 已經帶了。

## 加一支新的量尺

值得加的判準是：**它回答的問題，只有真資料答得出來。**
「這個函式回傳對不對」是測試的事，寫成量尺只是把測試放到不會自動跑的地方。
加了就在上表補一列，門檻寫在「回答的問題」欄，量到數字再填第三欄。
