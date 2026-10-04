"""字幕文字工具（純函式）。

為什麼要有「顯示單位」：中文一個字在畫面上約等於兩個拉丁字母寬，直接用 len() 會讓 16 個中文字被當成
「還能再塞 16 個」而爆行。規則與 ai-music-cut `captions.ts displayWidth` 相同（CJK／全形算 2，其餘 1）。
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable, Sequence

# 句末（硬斷點）、子句（軟斷點加分）、禁則（不能在它之前／之後換行）
SENTENCE_END = frozenset("。？！.?!")
CLAUSE_MARKS = frozenset("，、,;:；：")
NO_BREAK_BEFORE = frozenset("，。、；：？！」』）》〉】…—%％,.;:?!)]}")
NO_BREAK_AFTER = frozenset("「『（《〈【([{")
CLOSING_QUOTES = frozenset("」』）》〉】\"'”’)]}")
# 會被併到前一個詞的「前置標點」：Whisper 偶爾把「，」「%」切成獨立的詞或放在下一個詞開頭
ATTACH_TO_PREV = frozenset("，。、；：？！」』）》〉】…,.;:?!%％")
ASCII_TO_FULLWIDTH = {",": "，", ".": "。", "?": "？", "!": "！", ":": "：", ";": "；"}

CJK_LANGS = ("zh", "ja", "ko", "yue", "cmn", "wuu")

_EN_CONJ = frozenset({"and", "but", "or", "so", "because", "that", "which", "when"})
_ZH_CONNECTIVES = ("但是", "所以", "因為", "因为", "然後", "然后", "而且", "可是", "如果", "就是")
# 數字後面常接的單位：切在數字和單位之間會讀成兩件事（+50 懲罰）
_UNITS = ("%", "％", "元", "塊", "块", "個", "个", "年", "月", "日", "號", "号", "點", "点", "分", "秒", "歲", "岁", "次", "倍", "萬", "万", "億", "亿",
          "千", "百", "kg", "km", "cm", "mm", "m", "g", "s", "ms", "k", "K", "M", "GB", "MB", "fps", "px")


def is_wide(ch: str) -> bool:
    """東亞寬字元（含全形標點）→ 顯示 2 單位。"""
    c = ord(ch)
    return (
        0x1100 <= c <= 0x115F
        or 0x2E80 <= c <= 0xA4CF
        or 0xAC00 <= c <= 0xD7A3
        or 0xF900 <= c <= 0xFAFF
        or 0xFE30 <= c <= 0xFE4F
        or 0xFF00 <= c <= 0xFF60
        or 0xFFE0 <= c <= 0xFFE6
        or 0x20000 <= c <= 0x3FFFD
    )


def is_cjk_char(ch: str) -> bool:
    """CJK 文字（漢字／假名／諺文），**不含**全形標點：標點轉換與斷行要分開判斷。"""
    if not ch:
        return False
    c = ord(ch[0])
    return (
        0x3040 <= c <= 0x30FF  # 假名
        or 0x3400 <= c <= 0x4DBF
        or 0x4E00 <= c <= 0x9FFF
        or 0xF900 <= c <= 0xFAFF
        or 0xAC00 <= c <= 0xD7A3
        or 0x20000 <= c <= 0x3FFFD
    )


def has_cjk(s: str) -> bool:
    return any(is_cjk_char(ch) for ch in s)


def cjk_count(s: str) -> int:
    return sum(1 for ch in s if is_cjk_char(ch))


def latin_letters(s: str) -> int:
    return sum(1 for ch in s if ch.isascii() and ch.isalnum())


def units(s: str) -> int:
    return sum(2 if is_wide(ch) else 1 for ch in s)


def is_cjk_lang(lang: str | None) -> bool:
    if not lang:
        return False
    return lang.split("-")[0].lower() in CJK_LANGS


_LATIN_TAIL = re.compile(r"[A-Za-z0-9)\]}\"'.,!?;:%$]$")
_LATIN_HEAD = re.compile(r"^[A-Za-z0-9(\[{\"'$#@&+]")


def needs_space(prev: str, nxt: str) -> bool:
    """兩個詞之間要不要空格：兩邊都是西文字母／數字才要（中文之間、中英之間不加；中英間距另由 cjkLatinSpace 處理）。"""
    return bool(prev) and bool(nxt) and bool(_LATIN_TAIL.search(prev)) and bool(_LATIN_HEAD.search(nxt))


def join_words(texts: Iterable[str]) -> str:
    out = ""
    for raw in texts:
        t = raw.strip()
        if not t:
            continue
        if out and needs_space(out, t):
            out += " "
        out += t
    return out


def ends_sentence(s: str) -> bool:
    t = s.rstrip()
    while t and t[-1] in CLOSING_QUOTES:
        t = t[:-1]
    return bool(t) and t[-1] in SENTENCE_END


def ends_clause(s: str) -> bool:
    t = s.rstrip()
    return bool(t) and t[-1] in CLAUSE_MARKS


def is_en_conjunction(s: str) -> bool:
    return s.strip().lower().strip(".,!?;:") in _EN_CONJ


def starts_zh_connective(s: str) -> bool:
    t = s.strip()
    return any(t.startswith(c) for c in _ZH_CONNECTIVES)


def splits_number_unit(left: str, right: str) -> bool:
    """left 以數字結尾、right 以單位或數字開頭（`12`|`%`、`3`|`5`）→ 不該在這裡切。"""
    a, b = left.rstrip(), right.lstrip()
    if not a or not b or not a[-1].isdigit():
        return False
    return b[0].isdigit() or any(b.startswith(u) for u in _UNITS)


# 行尾要拿掉的標點（Netflix 繁中規範：行尾不放逗號、句號、頓號；問號、驚嘆號、刪節號、引號保留）。
# 這三個是全形中文標點，只會出現在中日韓文字裡 —— 所以「行尾是它們」本身就代表這是中文行，不必另外判斷語言。
LINE_END_STRIP = "。，、"
_LINE_END_RE = re.compile(r"[\s。，、]+$")


def strip_line_end(s: str) -> str:
    """一行字幕的顯示文字：去掉行尾的 。，、（可連續多個、夾空白也算）。整行只剩這些標點時原樣返回（不要產生空白字幕）。

    TS 鏡射（CaptionLayer 近似版面）：`line.replace(/[\\s。，、]+$/u, "") || line`。
    """
    return _LINE_END_RE.sub("", s) or s


def trim_line_end_punct(s: str) -> str:
    """同 strip_line_end 但允許變成空字串（換行量寬用：這個 token 若落在行尾，畫面上剩多寬）。"""
    return _LINE_END_RE.sub("", s)


def strip_line_end_tokens(tokens: Sequence[str]) -> list[str]:
    """同一行的 token（詞）→ 去掉行尾 。，、 之後的 token；長度不變（整個被拿掉的 token 變空字串，呼叫端略過）。

    為什麼逐 token 而不是整行字串：燒錄／ASS 卡拉OK 要知道每個詞各自剩下什麼（詞的時間與顏色狀態還是照原本的索引）。
    整行都是這些標點時原樣返回。
    """
    out = [t.strip() for t in tokens]
    for i in range(len(out) - 1, -1, -1):
        out[i] = _LINE_END_RE.sub("", out[i])
        if out[i]:
            break
    if not any(out):
        return [t.strip() for t in tokens]
    return out


def is_han_char(ch: str) -> bool:
    """漢字（不含假名、諺文）：只有漢字才做「單字 token 併成詞」—— 韓文詞之間本來有空白，日文假名的詞界規則不同。"""
    if not ch:
        return False
    c = ord(ch[0])
    return 0x3400 <= c <= 0x4DBF or 0x4E00 <= c <= 0x9FFF or 0xF900 <= c <= 0xFAFF or 0x20000 <= c <= 0x3FFFD


def to_halfwidth_digits(s: str) -> str:
    """全形數字 → 半形（Netflix 繁中規範：數字用半形）。只動數字，不做整體 NFKC（會把全形標點也打回半形）。"""
    return "".join(chr(ord(ch) - 0xFEE0) if "０" <= ch <= "９" else ch for ch in s)


def display_text(text: str, uppercase_latin: bool) -> str:
    return text.upper() if uppercase_latin else text


def cps_chars(s: str) -> int:
    """閱讀速度用的字數：不算空白與標點（CJK 字、拉丁字母、數字各算 1）。"""
    return sum(1 for ch in s if not ch.isspace() and unicodedata.category(ch)[0] not in ("P", "S", "Z"))


def token_pieces(texts: Sequence[str]) -> list[str]:
    """把長 CJK 詞拆成單字（硬換行最後手段用）；拉丁詞不拆。"""
    out: list[str] = []
    for t in texts:
        if has_cjk(t) and len(t) > 1:
            out.extend(list(t))
        else:
            out.append(t)
    return out
