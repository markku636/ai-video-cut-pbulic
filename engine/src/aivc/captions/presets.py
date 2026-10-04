"""字幕預設（presets.v1.json）與樣式深合併。

為什麼預設表存 JSON 而不是 Python 常數：TS `src/store/captions.ts CAPTION_PRESETS` 是 SoT，vitest 會逐欄比對這份檔；
兩邊都讀「資料」才不會出現「TS 改了顏色、引擎燒出來還是舊顏色」。形狀 `{version, presets: {id: {id, segmentation:{cjk,latin}, style}}}`。

合併規則與 TS `deepMerge` 相同：兩邊都是物件才往下走；陣列、null、純量整個換掉；**null 會蓋掉物件**
（`shadow: null` = 不要陰影、`colors.future: null` = 沿用 text），缺鍵（Python 沒有 undefined）= 不動。
"""
from __future__ import annotations

import copy
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .text import is_cjk_lang

PRESET_IDS: tuple[str, ...] = ("subtitle", "karaoke", "pop", "bounce", "typewriter", "boxHighlight")
DEFAULT_PRESET = "subtitle"
_PATH = Path(__file__).with_name("presets.v1.json")


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    with open(_PATH, encoding="utf-8") as f:
        doc = json.load(f)
    if doc.get("version") != 1:
        raise ValueError(f"presets.v1.json 版本不支援：{doc.get('version')!r}")
    return doc["presets"]


def presets() -> dict[str, Any]:
    """回傳深拷貝：呼叫端改了也不會污染快取。"""
    return copy.deepcopy(_load())


def preset(preset_id: str | None) -> dict[str, Any]:
    p = _load()
    return copy.deepcopy(p.get(preset_id or "") or p[DEFAULT_PRESET])


def deep_merge(base: Any, patch: Any) -> Any:
    if not isinstance(patch, dict) or not isinstance(base, dict):
        return copy.deepcopy(patch)
    out = copy.deepcopy(base)
    for k, v in patch.items():
        cur = out.get(k)
        out[k] = deep_merge(cur, v) if isinstance(cur, dict) and isinstance(v, dict) else copy.deepcopy(v)
    return out


def effective_style(track: dict[str, Any], cue: dict[str, Any] | None = None) -> dict[str, Any]:
    """PRESET ← track.style ← cue.styleOverride。"""
    st = deep_merge(preset(track.get("presetId"))["style"], track.get("style") or {})
    ov = (cue or {}).get("styleOverride")
    return deep_merge(st, ov) if isinstance(ov, dict) else st


# 中日韓語言「每則最多幾個中日韓字」（segment.py 的中文字數模式；只有跳字／彈跳需要）。
# 為什麼不寫進 presets.v1.json：那份檔逐欄鏡射 TS 的 CAPTION_PRESETS（vitest toEqual 比對），多一個欄位兩邊要同一個 commit 改；
# 分段只在引擎做（captions.build），TS 不需要這個值。build 出來的 track.segmentation 會帶著 maxChars（TS／Python 都當未知鍵原樣保留），
# 專案檔看得到當初是用多少字分的，`--segmentation '{"maxChars": 8}'` 也能覆寫（null = 關閉，回到逐 token 數 maxWords）。
# 數值：pop 一行 12 單位 = 6 個中文字（字級 9% 短邊，一行放得下）；bounce 一行 8 單位 = 4 個中文字（一次一個詞的份量）。
CJK_MAX_CHARS: dict[str, int] = {"pop": 6, "bounce": 4}


def preset_segmentation(preset_id: str | None, language: str | None) -> dict[str, Any]:
    p = preset(preset_id)
    cjk = is_cjk_lang(language)
    seg = dict(p["segmentation"]["cjk"] if cjk else p["segmentation"]["latin"])
    if cjk and p["id"] in CJK_MAX_CHARS:
        seg["maxChars"] = CJK_MAX_CHARS[p["id"]]
    return seg


def effective_segmentation(preset_id: str | None, language: str | None, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    seg = preset_segmentation(preset_id, language)
    for k, v in (overrides or {}).items():
        # maxChars 是選配鍵（只有部分預設有）：任何預設都允許覆寫開啟／關閉
        if k in seg or k == "maxChars":
            seg[k] = v
    return seg
