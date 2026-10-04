"""ASR 詞清理（研究規格 §5.3 B）：Whisper 原始詞 → 可以直接分段的詞。

每一步都有量測過的理由：
1. 空詞丟掉、CJK 前導空白拿掉、「，」「%」這種前置標點併回前一個詞 —— Whisper 的 token 邊界不是閱讀邊界。
2. 時間：turbo 在混語片把英文 " to" 標成 0.88–14.40 s（一個詞橫跨 13 秒）。詞跨過 VAD 靜音 → 起點移到結尾前
   最後一個語音起點；再超過上限（拉丁 1.2 s、CJK 每字 0.7 s）→ 用字數估長度（CJK 250 ms/字、拉丁 80 ms/字母）。
3. 繁體：Whisper 沒 prompt 時吐簡體。OpenCC `s2t` 會改到才跑 `s2twp`（台灣用詞：軟件→軟體）；轉換在「整段」上做
   （詞組跨 token），再分回每個詞：先找「連續詞分組、每組各自轉換後串起來 == 整段結果」的切法（軟件|視頻|內存 各成一組），
   找不到才退回 difflib（等長取代逐字對應、不等長整段給第一個字的主人、插入給前一個詞）。組內其他詞變空字串 → 併進前一詞。
   分兩階段（先 s2t 逐字、再 s2twp 詞組）是因為直接 s2twp 讓「软件视频」整段不等長，四個字的時間會全擠到第一個字。
4. 標點：CJK 語境裡的 ASCII `, . ? ! : ;` → 全形；數字維持半形（3.5 不動）。
5. 旗標：lowConfidence（prob < 0.45）、hallucination（壓縮比 > 2.4、no_speech > 0.6 且 logprob < -1、黑名單）只標不刪；
   VAD 說有人講話但 ≥ 1 秒沒有任何詞 → gaps（UI 提供「重新辨識這段」）。
"""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from . import text as T

LOW_CONF = 0.45
LATIN_CAP_S = 1.2
CJK_CHAR_CAP_S = 0.7
CJK_EST_S = 0.25
LATIN_EST_S = 0.08
GAP_MIN_S = 1.0
GAP_TOLERANCE_S = 0.25
HALLUCINATION_BLOCKLIST = (
    "amara.org",
    "明鏡與點點",
    "明镜与点点",
    "thanks for watching",
    "thank you for watching",
    "字幕由",
    "字幕志愿者",
    "字幕志願者",
    "請不吝點贊",
    "请不吝点赞",
    "訂閱我的頻道",
    "订阅我的频道",
    "subtitles by",
)
# 輸出語言 → OpenCC 設定。zh-TW 走台灣詞彙版（s2twp）；「已經是繁體就不動」由 auto 規則處理。
CONVERT_FOR_LANG = {"zh-tw": "s2twp", "zh-hant": "s2t", "zh-hk": "s2hk", "zh-cn": "t2s", "zh-hans": "t2s", "zh-sg": "t2s"}


@dataclass
class AsrWord:
    text: str
    start: float  # 秒，ASR 時間軸（加 TimeMap.offset_s 才是 proxy 時間）
    end: float
    prob: float = 1.0
    seg: int = 0
    raw: str | None = None
    flags: set[str] = field(default_factory=set)
    emphasis: bool = False
    speaker: str | None = None
    source: str = "asr"


@dataclass
class NormalizeOptions:
    output_language: str | None = None  # "zh-TW" | "en" | …；None = 不做文字轉換
    convert: str = "auto"  # auto | none | s2twp | s2t | s2hk | t2s
    fullwidth_punct: bool | None = None  # None = 依 CJK 語境自動
    low_conf: float = LOW_CONF
    hotwords: Sequence[str] = ()


@dataclass
class NormalizeResult:
    words: list[AsrWord]
    gaps: list[tuple[float, float]]
    warnings: list[str]
    hallucinated_segments: list[int]


# ---------------------------------------------------------------- 0. Whisper 片段 → 詞


def words_from_segments(segments: Iterable[dict[str, Any]]) -> list[AsrWord]:
    """ai-music-cut 形狀 `{id,start,end,text,…,words:[{start,end,word,probability}]}` → AsrWord。"""
    out: list[AsrWord] = []
    for si, s in enumerate(segments):
        sid = int(s.get("id", si))
        for w in s.get("words") or []:
            txt = str(w.get("word", ""))
            out.append(AsrWord(text=txt, start=float(w.get("start", 0.0)), end=float(w.get("end", 0.0)), prob=float(w.get("probability", 1.0)), seg=sid, raw=txt))
    return out


# ---------------------------------------------------------------- 1. token 清理


def _is_continuation(w: AsrWord, prev: AsrWord | None) -> bool:
    """中文模式下 Whisper 的詞是 unicode token：一個英文單字會被拆成好幾段（只有第一段帶前導空白）。
    沒有前導空白、前後都是英數 → 同一個拉丁詞的後半段（英文模式的詞都帶前導空白，不受影響）。"""
    raw = w.raw if w.raw is not None else w.text
    if prev is None or prev.seg != w.seg or not raw or raw[0].isspace():
        return False
    t = raw.strip()
    return bool(t) and t[0].isascii() and t[0].isalnum() and prev.text[-1:].isascii() and prev.text[-1:].isalnum()


def clean_tokens(words: list[AsrWord]) -> list[AsrWord]:
    out: list[AsrWord] = []
    for w in words:
        t = T.to_halfwidth_digits(w.text.strip())
        if not t:
            continue
        if out and _is_continuation(w, out[-1]):
            p = out[-1]
            p.text += t
            p.end = max(p.end, w.end)
            p.prob = min(p.prob, w.prob)
            p.raw = (p.raw or "") + (w.raw or "")
            continue
        # 前置標點併回前一個詞（同一片段內才併：跨片段表示中間有停頓，標點屬於哪句不確定 → 留在原處）
        lead = 0
        while lead < len(t) and t[lead] in T.ATTACH_TO_PREV:
            lead += 1
        if lead and out and out[-1].seg == w.seg:
            out[-1].text += t[:lead]
            t = t[lead:].strip()
            if not t:
                continue
        elif lead == len(t):
            if out:
                out[-1].text += t
            continue  # 整份逐字稿第一個詞就是標點：丟掉
        w.text = t
        out.append(w)
    return out


# ---------------------------------------------------------------- 2. 時間修正


def _silence_onset(start: float, end: float, vad: Sequence[tuple[float, float]]) -> float | None:
    """詞 [start,end) 內「前面有 ≥0.2 s 靜音」的最後一個 VAD 語音起點。"""
    best: float | None = None
    for j, (s, _e) in enumerate(vad):
        if not (start + 0.2 < s < end):
            continue
        prev_end = vad[j - 1][1] if j > 0 else float("-inf")
        if prev_end < s - 0.2:
            best = s
    return best


def fix_timing(words: list[AsrWord], vad: Sequence[tuple[float, float]] | None = None) -> list[AsrWord]:
    vad = sorted((float(a), float(b)) for a, b in (vad or ()))
    for i, w in enumerate(words):
        if w.end <= w.start:
            w.end = w.start + 0.02
        if vad:
            onset = _silence_onset(w.start, w.end, vad)
            if onset is not None:
                w.start = onset
        n_cjk = T.cjk_count(w.text)
        n_lat = T.latin_letters(w.text)
        cap = CJK_CHAR_CAP_S * n_cjk if n_cjk else LATIN_CAP_S
        if n_cjk and n_lat:
            cap += LATIN_CAP_S
        if w.end - w.start > cap:
            est = min(cap, max(0.1, CJK_EST_S * n_cjk + LATIN_EST_S * n_lat))
            prev = words[i - 1] if i > 0 else None
            # 片段第一個詞或前面有停頓：通常是「起點吸進前面的靜音」；否則是「終點拖進後面的靜音」
            if prev is None or prev.seg != w.seg or w.start - prev.end > 0.3:
                w.start = w.end - est
            else:
                w.end = w.start + est
    # 起點單調、不與前一詞重疊（DTW 偶爾會讓相鄰詞交錯）
    for i in range(1, len(words)):
        p, w = words[i - 1], words[i]
        if w.start < p.start:
            w.start = p.start
        if w.end <= w.start:
            w.end = w.start + 0.02
        if p.end > w.start:
            p.end = max(p.start + 0.01, w.start)
    return words


# ---------------------------------------------------------------- 3. 繁簡轉換


_OPENCC: dict[str, Any] = {}


def _converter(config: str) -> Any:
    if config not in _OPENCC:
        import opencc  # 惰性：沒裝 opencc 的環境（CI 最小依賴）只有要轉換時才失敗

        _OPENCC[config] = opencc.OpenCC(config)
    return _OPENCC[config]


def remap_texts(texts: Sequence[str], converted: str) -> list[str]:
    """`"".join(texts)` 被轉成 `converted` 之後，把轉換結果分回每個詞（規則見模組說明第 3 點）。"""
    original = "".join(texts)
    owner: list[int] = []
    for i, t in enumerate(texts):
        owner.extend([i] * len(t))
    out = [""] * len(texts)
    if not texts:
        return out
    sm = difflib.SequenceMatcher(None, original, converted, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal" or (tag == "replace" and i2 - i1 == j2 - j1):
            for d in range(i2 - i1):
                out[owner[i1 + d]] += converted[j1 + d]
        elif tag == "replace":
            out[owner[i1]] += converted[j1:j2]
        elif tag == "insert":
            out[owner[i1 - 1] if i1 > 0 else 0] += converted[j1:j2]
        # delete：字消失，沒有東西可分
    return out


_MAX_GROUP = 8
_MAX_CONVERTS_PER_WORD = 24


def partition_convert(texts: Sequence[str], target: str, conv: Any) -> list[str] | None:
    """把轉換結果依「詞組」分回去：找一個把連續詞分組的方式，使每組各自轉換後串起來 == 整段轉換結果。

    為什麼不只用 difflib：「軟件視頻內存」→「軟體影片記憶體」中間沒有任何相同字，difflib 會把 5 個字的差異當成一整塊，
    全部時間都擠到第一個字。逐組轉換能得到 軟件→軟體、視頻→影片、內存→記憶體 三組，時間只在組內合併。
    組內第一個詞拿轉換結果、其餘變空字串（呼叫端併進前一詞）。找不到（OpenCC 的最長匹配跨組）→ None，退回 difflib。
    """
    n = len(texts)
    budget = [_MAX_CONVERTS_PER_WORD * max(1, n)]
    memo: dict[tuple[int, int], list[str] | None] = {}
    cache: dict[str, str] = {}

    def convert(s: str) -> str:
        if s not in cache:
            budget[0] -= 1
            cache[s] = conv.convert(s)
        return cache[s]

    def solve(i: int, pos: int) -> list[str] | None:
        if i == n:
            return [] if pos == len(target) else None
        key = (i, pos)
        if key in memo:
            return memo[key]
        memo[key] = None
        for j in range(i + 1, min(n, i + _MAX_GROUP) + 1):
            if budget[0] <= 0:
                return None
            c = convert("".join(texts[i:j]))
            if target.startswith(c, pos):
                rest = solve(j, pos + len(c))
                if rest is not None:
                    memo[key] = [c] + [""] * (j - i - 1) + rest
                    return memo[key]
        return None

    try:
        return solve(0, 0)
    except RecursionError:
        return None


def _redistribute(texts: list[str], converted: str, conv: Any) -> list[str]:
    parts = partition_convert(texts, converted, conv)
    return parts if parts is not None else remap_texts(texts, converted)


def _merge_empty(words: list[AsrWord], texts: list[str]) -> list[AsrWord]:
    """轉換後變空字串的詞（例如「内存」→「記憶體」整段給了「内」）併進前一個詞：時間延長、旗標合併。"""
    out: list[AsrWord] = []
    pending: AsrWord | None = None
    for w, t in zip(words, texts):
        if not t:
            if out:
                out[-1].end = max(out[-1].end, w.end)
                out[-1].flags |= w.flags
                out[-1].prob = min(out[-1].prob, w.prob)
            else:
                pending = w
            continue
        w.text = t
        if pending is not None:
            w.start = min(w.start, pending.start)
            pending = None
        out.append(w)
    return out


def convert_script(words: list[AsrWord], opts: NormalizeOptions, warnings: list[str] | None = None) -> list[AsrWord]:
    lang = (opts.output_language or "").lower()
    config = opts.convert
    if config == "none" or (config == "auto" and lang not in CONVERT_FOR_LANG):
        return words
    target = CONVERT_FOR_LANG.get(lang, "s2twp") if config == "auto" else config
    try:
        s2t = _converter("s2t")
        final = _converter(target)
    except Exception as e:  # noqa: BLE001
        if warnings is not None:
            warnings.append(f"OpenCC 無法載入（{type(e).__name__}: {e}），略過繁簡轉換")
        return words
    out: list[AsrWord] = []
    for seg_words in _by_segment(words):
        texts = [w.text for w in seg_words]
        joined = "".join(texts)
        if target in ("t2s",):
            conv = final.convert(joined)
            if conv != joined:
                seg_words = _merge_empty(seg_words, _redistribute(texts, conv, final))
            out.extend(seg_words)
            continue
        stage1 = s2t.convert(joined)
        # auto：已經是繁體（s2t 不改）就不動 —— 使用者給了繁體 prompt、或本來就是港台用詞時不要多事
        if config == "auto" and stage1 == joined:
            out.extend(seg_words)
            continue
        if stage1 != joined:
            texts = _redistribute(texts, stage1, s2t)
            seg_words = _merge_empty(seg_words, texts)
            texts = [w.text for w in seg_words]
            joined = "".join(texts)
        if target != "s2t":
            stage2 = final.convert(joined)
            if stage2 != joined:
                seg_words = _merge_empty(seg_words, _redistribute(texts, stage2, final))
        out.extend(seg_words)
    return out


def _by_segment(words: list[AsrWord]) -> Iterable[list[AsrWord]]:
    cur: list[AsrWord] = []
    for w in words:
        if cur and w.seg != cur[-1].seg:
            yield cur
            cur = []
        cur.append(w)
    if cur:
        yield cur


# ---------------------------------------------------------------- 4. 全形標點


def fix_punct(words: list[AsrWord], opts: NormalizeOptions) -> list[AsrWord]:
    if opts.fullwidth_punct is False:
        return words
    lang_cjk = T.is_cjk_lang(opts.output_language)
    for seg_words in _by_segment(words):
        texts = [w.text for w in seg_words]
        joined = "".join(texts)
        seg_cjk = lang_cjk or T.cjk_count(joined) >= T.latin_letters(joined)
        if opts.fullwidth_punct is None and not T.has_cjk(joined):
            continue
        chars = list(joined)
        for p, ch in enumerate(chars):
            if ch not in T.ASCII_TO_FULLWIDTH:
                continue
            prev = chars[p - 1] if p > 0 else ""
            nxt = chars[p + 1] if p + 1 < len(chars) else ""
            if ch == "." and prev.isdigit() and nxt.isdigit():
                continue  # 3.5
            if T.is_cjk_char(prev) or T.is_cjk_char(nxt) or (not nxt and seg_cjk):
                chars[p] = T.ASCII_TO_FULLWIDTH[ch]
        new = "".join(chars)
        if new != joined:  # 等長取代 → 位置不變，直接依長度切回
            pos = 0
            for w, t in zip(seg_words, texts):
                w.text = new[pos : pos + len(t)]
                pos += len(t)
    return words


# ---------------------------------------------------------------- 5. 旗標 / 未覆蓋語音 / 強調


def hallucinated(segment: dict[str, Any]) -> bool:
    cr = segment.get("compression_ratio")
    if isinstance(cr, (int, float)) and cr > 2.4:
        return True
    nsp, alp = segment.get("no_speech_prob"), segment.get("avg_logprob")
    if isinstance(nsp, (int, float)) and isinstance(alp, (int, float)) and nsp > 0.6 and alp < -1.0:
        return True
    txt = str(segment.get("text", "")).lower()
    return any(b in txt for b in HALLUCINATION_BLOCKLIST)


def flag_words(words: list[AsrWord], segments: Sequence[dict[str, Any]], low_conf: float = LOW_CONF) -> list[int]:
    bad = {int(s.get("id", i)) for i, s in enumerate(segments) if hallucinated(s)}
    for w in words:
        if w.prob < low_conf:
            w.flags.add("lowConfidence")
        if w.seg in bad:
            w.flags.add("hallucination")
    return sorted(bad)


def find_gaps(vad: Sequence[tuple[float, float]], words: Sequence[AsrWord], min_s: float = GAP_MIN_S, tol: float = GAP_TOLERANCE_S) -> list[tuple[float, float]]:
    """VAD 語音區間扣掉詞覆蓋（各放寬 tol）之後，剩下 ≥ min_s 的片段。混語片 auto 偵測整段掉字就靠這個抓。"""
    spans = sorted((w.start - tol, w.end + tol) for w in words)
    gaps: list[tuple[float, float]] = []
    for vs, ve in sorted(vad):
        cur = vs
        for ws, we in spans:
            if we <= cur or ws >= ve:
                continue
            if ws > cur and ws - cur >= min_s:
                gaps.append((round(cur, 3), round(ws, 3)))
            cur = max(cur, we)
            if cur >= ve:
                break
        if ve - cur >= min_s:
            gaps.append((round(cur, 3), round(ve, 3)))
    return gaps


_NUMERIC = re.compile(r"[0-9]|[$€£¥%％]|NT\$|元")


def mark_emphasis(words: list[AsrWord], hotwords: Sequence[str] = ()) -> list[AsrWord]:
    """規則式強調（LLM 選配之外的預設）：數字／百分比／幣別、熱詞、全大寫拉丁詞、驚嘆號結尾。"""
    for w in words:
        t = w.text
        letters = [ch for ch in t if ch.isascii() and ch.isalpha()]
        if _NUMERIC.search(t) or (len(letters) >= 2 and all(ch.isupper() for ch in letters)) or t.rstrip().endswith(("!", "！")):
            w.emphasis = True
    hot = [h.strip() for h in hotwords if h and h.strip()]
    if hot:
        for seg_words in _by_segment(words):
            texts = [w.text for w in seg_words]
            joined = "".join(texts)
            low = joined.lower()
            owner: list[int] = []
            for i, t in enumerate(texts):
                owner.extend([i] * len(t))
            for h in hot:
                start = 0
                hl = h.lower().replace(" ", "")
                low_ns = low  # 拉丁熱詞在 joined（無空白）上比對：詞是分開存的
                while True:
                    p = low_ns.find(hl, start)
                    if p < 0:
                        break
                    for q in range(p, p + len(hl)):
                        seg_words[owner[q]].emphasis = True
                    start = p + 1
    return words


# ---------------------------------------------------------------- 全流程


def normalize(
    segments: Sequence[dict[str, Any]],
    vad: Sequence[tuple[float, float]] | None,
    opts: NormalizeOptions | None = None,
) -> NormalizeResult:
    opts = opts or NormalizeOptions()
    warnings: list[str] = []
    words = clean_tokens(words_from_segments(segments))
    words = fix_timing(words, vad)
    words = convert_script(words, opts, warnings)
    words = fix_punct(words, opts)
    bad = flag_words(words, segments, opts.low_conf)
    mark_emphasis(words, opts.hotwords)
    gaps = find_gaps(vad or (), words) if vad else []
    if bad:
        warnings.append(f"{len(bad)} 個片段疑似幻覺（壓縮比過高／無語音／黑名單），已標記未刪除")
    if gaps:
        warnings.append(f"{len(gaps)} 段有語音但沒有辨識出文字（混語或自動偵測語言錯誤？）")
    return NormalizeResult(words, gaps, warnings, bad)
