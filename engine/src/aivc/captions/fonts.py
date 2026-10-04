"""字型解析（研究規格 §5.3 H）：**不內嵌任何字型**，渲染時讀使用者系統上已安裝的字型（不複製、不散布）。

解析順序：style.font.file → families 依序在作業系統字型目錄找 → Pillow 內建字型（只有拉丁字，CJK 會變方塊，回報警告）。
- Windows：%WINDIR%\\Fonts、%LOCALAPPDATA%\\Microsoft\\Windows\\Fonts。Microsoft JhengHei（粗 ≥700 用 msjhbd.ttc）。
- macOS：/System/Library/Fonts、/Library/Fonts、~/Library/Fonts。PingFang TC（檔案位置各版本不同，未實機驗證）→ Hiragino Sans。
- Linux：fc-match（Noto Sans CJK TC），最後再用 `:lang=zh-tw` 問 fontconfig 任何能顯示中文的字型。
一條 track 用一個字型：中日韓語言挑 CJK 字型（它也涵蓋拉丁字）；拉丁語言優先挑拉丁粗體（Segoe UI Black／Arial Black 的字形比較像市售模板）。
坑：可變字型（NotoSansTC-VF）呼叫 font_variant() 之後粗細會掉回預設 → 每次載入都重設 wght 軸。

`FontSpec.cjk` 是**實測**這個字型檔有沒有常用漢字的字形（covers_cjk），不是看家族名稱：
驗證者抓到 Linux 的 fc-match 永遠會回一個字型（沒裝中文字型時回 DejaVu Sans），以前只要要求的家族名是中文字型就標 cjk=True，
燒出來全是方塊卻沒有任何警告。中日韓語言找不到涵蓋中文的字型時，退回拉丁字型（至少英數正常）並回報 cjk=False，由呼叫端發警告。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Sequence

from .text import is_cjk_lang


@dataclass(frozen=True)
class FontSpec:
    path: str | None  # None = Pillow 內建
    index: int = 0
    variable_weight: int | None = None  # 可變字型要設的 wght 軸值
    family: str = ""
    cjk: bool = False  # 實測涵蓋常用漢字（covers_cjk）
    source: str = "system"  # system | file | builtin | fc-match

    def to_json(self) -> dict[str, Any]:
        return {"path": self.path, "index": self.index, "variation": self.variable_weight, "family": self.family, "cjk": self.cjk, "source": self.source}


# family（小寫）→ [(最低粗細, 檔名, ttc index, 可變字型?)]，粗細由高到低找第一個 ≤ 需求的
_WIN: dict[str, list[tuple[int, str, int, bool]]] = {
    "microsoft jhenghei": [(700, "msjhbd.ttc", 0, False), (0, "msjh.ttc", 0, False)],
    "微軟正黑體": [(700, "msjhbd.ttc", 0, False), (0, "msjh.ttc", 0, False)],
    "microsoft yahei": [(700, "msyhbd.ttc", 0, False), (0, "msyh.ttc", 0, False)],
    "noto sans tc": [(0, "NotoSansTC-VF.ttf", 0, True)],
    "noto sans cjk tc": [(0, "NotoSansTC-VF.ttf", 0, True), (700, "NotoSansCJKtc-Bold.otf", 0, False), (0, "NotoSansCJKtc-Regular.otf", 0, False)],
    "noto sans hk": [(0, "NotoSansHK-VF.ttf", 0, True)],
    "yu gothic": [(700, "YuGothB.ttc", 0, False), (0, "YuGothR.ttc", 0, False)],
    "malgun gothic": [(700, "malgunbd.ttf", 0, False), (0, "malgun.ttf", 0, False)],
    "mingliu": [(0, "mingliu.ttc", 0, False)],
    "segoe ui black": [(0, "seguibl.ttf", 0, False)],
    "segoe ui": [(900, "seguibl.ttf", 0, False), (700, "segoeuib.ttf", 0, False), (0, "segoeui.ttf", 0, False)],
    "arial black": [(0, "ariblk.ttf", 0, False)],
    "arial": [(900, "ariblk.ttf", 0, False), (700, "arialbd.ttf", 0, False), (0, "arial.ttf", 0, False)],
}
_MAC: dict[str, list[tuple[int, str, int, bool]]] = {
    "pingfang tc": [(0, "PingFang.ttc", 0, False)],
    "hiragino sans": [(700, "ヒラギノ角ゴシック W6.ttc", 0, False), (0, "ヒラギノ角ゴシック W3.ttc", 0, False)],
    "hiragino sans gb": [(0, "Hiragino Sans GB.ttc", 0, False)],
    "heiti tc": [(700, "STHeiti Medium.ttc", 0, False), (0, "STHeiti Light.ttc", 0, False)],
    "arial unicode ms": [(0, "Arial Unicode.ttf", 0, False)],
    "arial black": [(0, "Arial Black.ttf", 0, False)],
    "arial": [(700, "Arial Bold.ttf", 0, False), (0, "Arial.ttf", 0, False)],
    "helvetica": [(0, "Helvetica.ttc", 0, False)],
}
_CJK_FAMILIES = {"microsoft jhenghei", "微軟正黑體", "microsoft yahei", "noto sans tc", "noto sans cjk tc", "noto sans hk", "pingfang tc", "hiragino sans"}
# 中日韓回退清單：**只放中日韓字型**（以前清單尾巴接拉丁字型，找不到中文字型時就靜靜挑了 Arial）。
# 各平台常見的預裝／常裝字型；表裡沒有的家族在 Linux 走 fc-match。授權說明見 THIRD-PARTY-NOTICES（不散布，只讀系統上已安裝的）。
FALLBACK_CJK = (
    "Microsoft JhengHei", "PingFang TC", "Hiragino Sans", "Heiti TC", "Hiragino Sans GB", "Noto Sans CJK TC", "Noto Sans TC",
    "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans TC", "WenQuanYi Zen Hei", "Yu Gothic", "Malgun Gothic", "MingLiU", "Arial Unicode MS",
)
FALLBACK_LATIN = ("Segoe UI Black", "Arial Black", "Arial", "Helvetica")
# 探測用的常用漢字（繁體、簡體、日文共用字形）；非字元 U+FFFF 絕不會在任何 cmap 裡 → 畫出來就是 .notdef（缺字方塊）
CJK_PROBE = "的一中字人"
_NOTDEF_PROBE = "\uffff"


def font_dirs() -> list[Path]:
    out: list[Path] = []
    if sys.platform == "win32":
        windir = os.environ.get("WINDIR") or "C:\\Windows"
        out.append(Path(windir) / "Fonts")
        if os.environ.get("LOCALAPPDATA"):
            out.append(Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "Windows" / "Fonts")
    elif sys.platform == "darwin":
        out += [Path("/System/Library/Fonts"), Path("/System/Library/Fonts/Supplemental"), Path("/Library/Fonts"), Path.home() / "Library" / "Fonts"]
    else:
        out += [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".local" / "share" / "fonts"]
    return [d for d in out if d.is_dir()]


def _table() -> dict[str, list[tuple[int, str, int, bool]]]:
    return _MAC if sys.platform == "darwin" else _WIN


def _find_in_dirs(name: str) -> str | None:
    for d in font_dirs():
        p = d / name
        if p.is_file():
            return str(p)
    return None


@lru_cache(maxsize=64)
def covers_cjk(path: str | None, index: int = 0) -> bool:
    """字型檔有沒有常用漢字的字形：每個探測字的點陣都要跟 .notdef（缺字方塊）不同、而且不是空白。

    為什麼用畫的而不是讀 cmap：Pillow 沒有公開 cmap，fontTools 不在依賴裡；FreeType 對 cmap 沒有的碼位一律畫 glyph 0，
    所以「跟 U+FFFF 畫出來一模一樣」就是缺字。讀不了的檔（壞檔、不支援的格式）→ False。
    """
    if not path:
        return False
    try:
        from PIL import Image, ImageDraw, ImageFont

        font = ImageFont.truetype(path, size=32, index=index, layout_engine=ImageFont.Layout.BASIC)

        def raster(ch: str) -> bytes:
            im = Image.new("L", (64, 64), 0)
            ImageDraw.Draw(im).text((8, 44), ch, font=font, fill=255, anchor="ls")
            return im.tobytes()

        notdef = raster(_NOTDEF_PROBE)
        for ch in CJK_PROBE:
            r = raster(ch)
            if r == notdef or not any(r):
                return False
        return True
    except (OSError, ValueError):
        return False


def _fc_match(pattern: str) -> str | None:
    fc = shutil.which("fc-match")
    if not fc:
        return None
    try:
        out = subprocess.run([fc, "-f", "%{file}", pattern], capture_output=True, text=True, timeout=5, check=False).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out if out and os.path.isfile(out) else None


def _fc_weight(weight: int) -> str:
    return "bold" if weight >= 700 else "regular"


def lookup_family(family: str, weight: int) -> FontSpec | None:
    key = family.strip().lower()
    for min_w, fname, index, variable in _table().get(key, []):
        if weight >= min_w:
            p = _find_in_dirs(fname)
            if p:
                return FontSpec(p, index, weight if variable else None, family, covers_cjk(p, index))
    if sys.platform not in ("win32", "darwin") and key not in ("sans-serif", "serif"):
        p = _fc_match(f"{family}:weight={_fc_weight(weight)}")
        if p:
            return FontSpec(p, 0, None, family, covers_cjk(p, 0), "fc-match")
    return None


def _fc_lang_font(language: str, weight: int) -> FontSpec | None:
    """Linux：不指定家族，請 fontconfig 找任何支援這個語言的字型（有裝文泉驛、AR PL 之類但不在清單裡時靠這個）。"""
    if sys.platform in ("win32", "darwin"):
        return None
    lang = (language or "zh-tw").lower()
    if lang.split("-")[0] in ("zh", "cmn", "yue", "wuu") and "-" not in lang:
        lang = "zh-tw"
    p = _fc_match(f":lang={lang}:weight={_fc_weight(weight)}")
    if not p:
        return None
    return FontSpec(p, 0, None, f":lang={lang}", covers_cjk(p, 0), "fc-match")


@lru_cache(maxsize=64)
def _resolve_cached(file: str | None, families: tuple[str, ...], weight: int, language: str) -> FontSpec:
    if file and os.path.isfile(file):
        # 使用者明確指定的字型檔：照用（覆寫是使用者的決定），cjk 仍照實回報，缺字時呼叫端會警告
        return FontSpec(file, 0, None, Path(file).stem, covers_cjk(file, 0), "file")
    cjk_lang = is_cjk_lang(language) or not language
    fams = list(families)
    if cjk_lang:
        # 先找真的有中文字形的字型；全部沒有才退拉丁字型（英數至少正常），回傳的 spec.cjk=False 讓呼叫端警告
        first_any: FontSpec | None = None
        for fam in fams + [f for f in FALLBACK_CJK if f not in fams]:
            spec = lookup_family(fam, weight)
            if spec is None:
                continue
            if spec.cjk:
                return spec
            first_any = first_any or spec
        spec = _fc_lang_font(language, weight)
        if spec is not None and spec.cjk:
            return spec
        for fam in FALLBACK_LATIN:
            if first_any is not None:
                break
            first_any = lookup_family(fam, weight)
        return first_any or FontSpec(None, 0, None, "Pillow default", False, "builtin")
    # 拉丁語言：使用者指定的拉丁字型 → 系統拉丁粗體 → 使用者指定的 CJK 字型（也有拉丁字）
    lat = [f for f in fams if f.lower() not in _CJK_FAMILIES and f.lower() not in ("sans-serif", "serif")]
    order = lat + [f for f in FALLBACK_LATIN if f not in lat] + fams + list(FALLBACK_CJK)
    for fam in order:
        spec = lookup_family(fam, weight)
        if spec is not None:
            return spec
    return FontSpec(None, 0, None, "Pillow default", False, "builtin")


def resolve_font(style: dict[str, Any], language: str | None) -> FontSpec:
    font = style.get("font") or {}
    fams: Sequence[str] = font.get("families") or ()
    return _resolve_cached(font.get("file") or None, tuple(str(f) for f in fams), int(font.get("weight") or 700), language or "")


def missing_cjk_warning(spec: FontSpec, needs_cjk: bool) -> dict[str, Any] | None:
    """字幕需要中日韓字形、但解析到的字型沒有 → 警告物件（render 計畫、captions.layout、preview 都帶出去）。"""
    if spec.path is None:
        return {"kind": "fontFallback", "message": "找不到任何系統字型，改用 Pillow 內建字型（中日韓字會顯示成方塊）"}
    if needs_cjk and not spec.cjk:
        return {
            "kind": "fontNoCjk",
            "message": f"字型 {spec.family}（{spec.path}）沒有中日韓字形，字幕的中文會顯示成方塊；請安裝 Noto Sans CJK TC 等中文字型，或在樣式指定字型檔",
            "font": spec.path,
        }
    return None


@lru_cache(maxsize=128)
def load_font(spec: FontSpec, size_px: float) -> Any:
    """Pillow FreeTypeFont；size 取到 1/4 px（快取鍵穩定、字寬仍接近連續縮放）。"""
    from PIL import ImageFont

    size = max(1.0, round(float(size_px) * 4) / 4)
    if spec.path is None:
        return ImageFont.load_default(size=size)
    f = ImageFont.truetype(spec.path, size=size, index=spec.index, layout_engine=ImageFont.Layout.BASIC)
    if spec.variable_weight is not None:
        try:
            f.set_variation_by_axes([float(spec.variable_weight)])
        except (OSError, ValueError, AttributeError):
            pass
    return f
