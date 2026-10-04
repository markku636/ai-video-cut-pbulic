# samples/

放測試影片（gitignored）。本專案的參考片段：

- `sample_clip1.webm` — 60 s 室內近景（人物、手、桌面上的平面物件），VP9 1280×720 VFR，4 個鏡頭（切點 2.0 / 30.9 / 45.3 s）。
  sha256 見 `fixtures/sample/README.md`。第三方素材，**不得 commit**。

引擎測試找參考片段的順序：`AIVC_SAMPLE_VIDEO` → `samples/sample_clip1.webm` → 這個資料夾裡第一支 `.webm`
（`engine/tests/_sample.py`）；都沒有就 skip。外掛的測試有自己的檔名約定（`plugins/<id>/engine/tests/_paths.py`）。
