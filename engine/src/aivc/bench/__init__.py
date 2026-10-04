"""bench：量尺（計畫 §11）的**純函式**部分——只吃 numpy 陣列／dict，不碰檔案、不解碼影片。

I/O（開專案、解碼來源與渲染輸出、讀 solve/遮罩/牌組）全部在 `aivc/ops/bench.py`；這裡的東西單元測試可以用
合成資料直接驗（`tests/test_bench.py`）。子模組：

- `common`   PSNR／遮罩膨脹／四角足跡／輸出幀 ↔ proxy 幀對應／JSON 安全化
- `outside`  遮罩外逐位元／PSNR 比對（bench outside）
- `jitter`   solve 狀態段切分、四角二階差分統計（bench jitter）
- `corners`  labels JSON 格式與四角誤差 p@N 統計（bench corners、label-auto 的寫檔）
- `verify`   輸出重辨識的逐幀判定與每 track 摘要（bench verify）
- `speed`    run 結果 JSON 的時間／VRAM 門檻（bench speed）

刻意不在這裡 import 任何子模組：`aivc --help` 要維持輕量，重 import（cv2）放在各子模組頂端、由 op 函式內才觸發。
"""
from __future__ import annotations

__all__ = ["common", "outside", "jitter", "corners", "verify", "speed"]
