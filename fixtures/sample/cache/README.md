# fixtures/sample/cache

參考片段（見 `../README.md`）的引擎快取（`<cache>/media/d171ec9031ba677f/`，引擎 v0.0.6 `media.proxy` 產生），
給 `src/video/mediaInfo.test.ts` 當「媒體資訊」的 golden：數字全是真片實測，不是手捏的。

- `index.v1.json`：1762 個來源幀的 pts / 關鍵幀旗標 + CFR runs（N = 1797 @ 30/1、35 個重複幀、0 丟幀、36 段；
  來源幀 1 之後 1200 ms 斷層、來源幀 116 之後 49 ms）。
- `probe.v1.json`：`path` 改成相對的示意路徑 `samples/sample_clip1.webm`（原本是開發機的絕對路徑），其餘原樣。
- `proxy.v1.json` / `shots.v1.json`：原樣。

影片本身是第三方素材不入庫；這幾份只有時間戳與統計數字，不含畫面內容。
