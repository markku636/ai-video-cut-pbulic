"""aivc.media — 媒體層：指紋、probe、PTS 索引、VFR→CFR 對應、色彩、幀來源、鏡頭切點、ffmpeg 編碼。

模組頂層刻意不 import numpy / av / cv2（`aivc --help` 要快）；需要時在函式內 import。
所有大 payload 都寫到 `env.media_cache_dir(fingerprint)` 底下的檔案（見 cache.py），只回傳路徑。
"""
