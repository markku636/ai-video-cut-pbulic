"""字幕檔匯出：SRT / WebVTT / ASS / TXT（研究規格 §5.4 captions.export）。

- UTF-8 無 BOM、`\\n` 換行（Premiere／YouTube／ffmpeg 都吃；BOM 會讓部分播放器把第一則的序號讀壞）。
- 時間：幀號 → `round(k·1000·den/num)` 毫秒（整數運算），30000/1001 fps 第 1799 幀 = 00:01:00,027。
- 則內換行用跟燒錄同一套 linebreak（寬度改用顯示單位：CJK=2），行數上限 = segmentation.maxLines。
- 行尾的 。，、 不輸出（Netflix 繁中規範，跟燒錄同一條 text.strip_line_end_tokens；？！… 保留）。SRT／VTT／ASS 適用；
  TXT 是逐字稿（一則一行、給人讀或丟給其他工具），標點保留。ASS 卡拉OK 的 `\\k` 時間照樣逐詞輸出，只是被拿掉的字不顯示。
- hidden 的則不輸出。`--range K0:K1` 只輸出與範圍重疊的則並裁到範圍內；`--trim` 再把時間減去 K0（對應 render --trim 的成品）。
- ASS：帶樣式（字型、字級、顏色、描邊、陰影、位置）與卡拉OK `\\k`／`\\kf` 標籤，給 Aegisub／mpv／ffmpeg subtitles 濾鏡。
"""
from __future__ import annotations

from typing import Any, Iterable

from . import text as T
from .layout import safe_rect
from .linebreak import break_lines
from .presets import effective_segmentation, effective_style
from .timebase import frame_to_ms

FORMATS = ("srt", "vtt", "ass", "txt")


def _hms(ms: int, sep: str) -> str:
    ms = max(0, int(ms))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, frac = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{frac:03d}"


def srt_time(ms: int) -> str:
    return _hms(ms, ",")


def vtt_time(ms: int) -> str:
    return _hms(ms, ".")


def ass_time(ms: int) -> str:
    cs = (max(0, int(ms)) + 5) // 10
    h, rem = divmod(cs, 360_000)
    m, rem = divmod(rem, 6000)
    s, c = divmod(rem, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{c:02d}"


def _units_space(cjk_latin_space: bool):
    def f(a: str, b: str) -> float:
        x, y = a[-1:], b[:1]
        mixed = cjk_latin_space and ((T.is_cjk_char(x) and y.isalnum() and not T.is_cjk_char(y)) or (x.isalnum() and not T.is_cjk_char(x) and T.is_cjk_char(y)))
        return 1.0 if T.needs_space(a, b) or mixed else 0.0

    return f


def cue_lines(cue: dict[str, Any], seg: dict[str, Any], cjk_latin_space: bool = True) -> list[list[int]]:
    """回傳每行的詞索引（寬度 = 顯示單位；放不下就照樣輸出，字幕檔沒有「溢出」這回事）。"""
    words = [str(w.get("text", "")).strip() for w in cue.get("words") or []]
    if not words:
        return []
    res = break_lines(words, lambda t: float(T.units(t)), float(seg.get("maxUnitsPerLine") or 42), int(seg.get("maxLines") or 2), _units_space(cjk_latin_space), scales=(1.0,))
    if res.tokens is not None:  # 硬換行拆了字：字幕檔一律退回不拆（整則一行）
        return [list(range(len(words)))]
    return res.lines


def _line(texts: list[str], ln: list[int], cjk_latin_space: bool) -> str:
    """一行的顯示文字：詞 → 拿掉行尾 。，、 → 依規則補空白。"""
    return _join(T.strip_line_end_tokens([texts[j] for j in ln]), cjk_latin_space)


def _join(texts: Iterable[str], cjk_latin_space: bool) -> str:
    out = ""
    sp = _units_space(cjk_latin_space)
    for t in texts:
        t = t.strip()
        if not t:
            continue
        if out and sp(out, t):
            out += " "
        out += t
    return out


def select_cues(track: dict[str, Any], k0: int | None = None, k1: int | None = None, trim: bool = False) -> list[dict[str, Any]]:
    """範圍內、非隱藏的則（淺拷貝；裁到範圍、trim 時減去 K0；字也一起平移／裁切）。"""
    out = []
    for c in sorted(track.get("cues") or [], key=lambda c: int(c["startFrame"])):
        if c.get("hidden") or not c.get("words"):
            continue
        s, e = int(c["startFrame"]), int(c["endFrame"])
        if k0 is not None and k1 is not None:
            s, e = max(s, k0), min(e, k1)
            if e <= s:
                continue
        shift = k0 if (trim and k0 is not None) else 0
        words = []
        for w in c["words"]:
            ws, we = max(int(w["startFrame"]), s), min(int(w["endFrame"]), e)
            if we <= ws:
                continue
            words.append({**w, "startFrame": ws - shift, "endFrame": we - shift})
        if words:
            out.append({**c, "startFrame": s - shift, "endFrame": e - shift, "words": words})
    return out


def to_srt(track: dict[str, Any], fps: tuple[int, int], *, cues: list[dict[str, Any]] | None = None, speaker_prefix: bool = False) -> str:
    num, den = fps
    style = effective_style(track)
    cls = bool((style.get("font") or {}).get("cjkLatinSpace", True))
    seg = track.get("segmentation") or effective_segmentation(track.get("presetId"), track.get("language"))
    parts: list[str] = []
    for i, c in enumerate(cues if cues is not None else select_cues(track), start=1):
        texts = [str(w.get("text", "")) for w in c["words"]]
        lines = [_line(texts, ln, cls) for ln in cue_lines(c, seg, cls)]
        if speaker_prefix and c.get("speaker") and lines:
            lines[0] = f"{c['speaker']}: {lines[0]}"
        parts.append(f"{i}\n{srt_time(frame_to_ms(c['startFrame'], num, den))} --> {srt_time(frame_to_ms(c['endFrame'], num, den))}\n" + "\n".join(lines) + "\n")
    return "\n".join(parts)


def to_vtt(track: dict[str, Any], fps: tuple[int, int], *, cues: list[dict[str, Any]] | None = None, speaker_prefix: bool = False, word_timing: bool = False) -> str:
    num, den = fps
    style = effective_style(track)
    cls = bool((style.get("font") or {}).get("cjkLatinSpace", True))
    seg = track.get("segmentation") or effective_segmentation(track.get("presetId"), track.get("language"))
    parts = ["WEBVTT\n"]
    for c in cues if cues is not None else select_cues(track):
        words = c["words"]
        texts = [str(w.get("text", "")) for w in words]
        rendered = []
        for ln in cue_lines(c, seg, cls):
            if not word_timing:
                rendered.append(_line(texts, ln, cls))
                continue
            s = ""
            shown = T.strip_line_end_tokens([texts[j] for j in ln])
            for n, j in enumerate(ln):
                t = shown[n]
                if not t:
                    continue  # 行尾整個被拿掉的標點詞：沒有字可顯示，時間標記也不必留
                if s and _units_space(cls)(s, t):
                    s += " "
                # WebVTT 卡拉OK 時間標記：第一個詞跟則同時出現，不需要標
                if j > 0:
                    s += f"<{vtt_time(frame_to_ms(words[j]['startFrame'], num, den))}>"
                s += t
            rendered.append(s)
        if speaker_prefix and c.get("speaker") and rendered:
            rendered[0] = f"<v {c['speaker']}>{rendered[0]}"
        parts.append(f"{vtt_time(frame_to_ms(c['startFrame'], num, den))} --> {vtt_time(frame_to_ms(c['endFrame'], num, den))}\n" + "\n".join(rendered) + "\n")
    return "\n".join(parts)


def to_txt(track: dict[str, Any], *, cues: list[dict[str, Any]] | None = None, speaker_prefix: bool = False) -> str:
    style = effective_style(track)
    cls = bool((style.get("font") or {}).get("cjkLatinSpace", True))
    lines = []
    for c in cues if cues is not None else select_cues(track):
        t = _join((str(w.get("text", "")) for w in c["words"]), cls)
        lines.append(f"{c['speaker']}: {t}" if speaker_prefix and c.get("speaker") else t)
    return "\n".join(lines) + ("\n" if lines else "")


def _ass_color(hex_color: str | None, default: str = "#FFFFFF") -> str:
    h = hex_color if isinstance(hex_color, str) and len(hex_color) in (7, 9) else default
    r, g, b = h[1:3], h[3:5], h[5:7]
    a = int(h[7:9], 16) if len(h) == 9 else 255
    return f"&H{255 - a:02X}{b}{g}{r}".upper()


def to_ass(track: dict[str, Any], fps: tuple[int, int], width: int, height: int, *, cues: list[dict[str, Any]] | None = None, speaker_prefix: bool = False, font_name: str | None = None) -> str:
    num, den = fps
    st = effective_style(track)
    font = st.get("font") or {}
    colors = st.get("colors") or {}
    lay = st.get("layout") or {}
    an = st.get("animation") or {}
    box = st.get("box") or {}
    shadow = st.get("shadow") if isinstance(st.get("shadow"), dict) else None
    cls = bool(font.get("cjkLatinSpace", True))
    seg = track.get("segmentation") or effective_segmentation(track.get("presetId"), track.get("language"))
    px = float(font.get("sizePctShortSide") or 5.2) / 100.0 * min(width, height)
    stroke = float((st.get("stroke") or {}).get("widthPct") or 0.0) / 100.0 * px
    sx0, sy0, sx1, sy1 = safe_rect(width, height, str(lay.get("safeArea") or "auto"))
    anchor = str(lay.get("anchor") or "bottom")
    align = {"left": 1, "center": 2, "right": 3}.get(str(lay.get("align") or "center"), 2)
    alignment = align + (6 if anchor == "top" else 3 if anchor == "middle" else 0)
    margin_v = int(round(height - sy1)) if anchor == "bottom" else int(round(sy0)) if anchor == "top" else 0
    name = font_name or (font.get("families") or ["Arial"])[0]
    word = an.get("word") or "none"
    karaoke = word in ("karaoke", "karaokeWipe", "pop", "boxMove", "typewriter")
    # ASS 卡拉OK：Primary = 唱過的顏色、Secondary = 還沒唱到的顏色
    primary = (colors.get("past") or colors.get("active") or colors.get("text")) if karaoke else colors.get("text")
    secondary = colors.get("future") or colors.get("text")
    border_style = 3 if (box.get("mode") or "none") == "line" else 1
    back = box.get("color") if border_style == 3 else (shadow or {}).get("color", "#00000000")
    outline = float(box.get("padEm") or 0.0) * px if border_style == 3 else stroke
    shadow_px = float((shadow or {}).get("dyPct") or 0.0) / 100.0 * px
    head = [
        "[Script Info]",
        "; AI Video Cut captions export",
        "ScriptType: v4.00+",
        f"PlayResX: {int(width)}",
        f"PlayResY: {int(height)}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        (
            f"Style: Default,{name},{int(round(px))},{_ass_color(primary)},{_ass_color(secondary)},{_ass_color(colors.get('stroke'), '#000000')},{_ass_color(back, '#00000000')},"
            f"{-1 if int(font.get('weight') or 700) >= 700 else 0},0,0,0,100,100,0,0,{border_style},{outline:.1f},{shadow_px:.1f},{alignment},{int(round(sx0))},{int(round(width - sx1))},{margin_v},1"
        ),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    tag = "\\kf" if word == "karaokeWipe" else "\\k"
    pos = ""
    if anchor == "middle":
        cy = (0.70 if height / max(width, 1) >= 1.5 else 0.78) * height
        pos = f"{{\\an5\\pos({int(round((sx0 + sx1) / 2))},{int(round(cy))})}}"
    events = []
    upper = bool(font.get("uppercaseLatin"))
    for c in cues if cues is not None else select_cues(track):
        words = c["words"]
        texts = [T.display_text(str(w.get("text", "")).strip(), upper).replace("{", "(").replace("}", ")") for w in words]
        start_ms = frame_to_ms(c["startFrame"], num, den)
        end_ms = frame_to_ms(c["endFrame"], num, den)
        body_lines = []
        for ln in cue_lines(c, seg, cls):
            s = ""
            shown = T.strip_line_end_tokens([texts[j] for j in ln])
            for n, j in enumerate(ln):
                t = shown[n]
                if s and t and _units_space(cls)(s.split("}")[-1], t):
                    s += " "
                if karaoke:
                    # \k 以百分之一秒計：從這個詞開始到下一個詞開始（最後一個詞到則結束）；第一個詞前的空檔另外補一個空的 \k
                    a = frame_to_ms(words[j]["startFrame"], num, den)
                    b = frame_to_ms(words[j + 1]["startFrame"], num, den) if j + 1 < len(words) else end_ms
                    if j == 0 and a > start_ms:
                        s += f"{{{tag}{(a - start_ms + 5) // 10}}}"
                    s += f"{{{tag}{max(0, (b - a + 5) // 10)}}}"
                s += t
            body_lines.append(s)
        body = "\\N".join(body_lines)
        if speaker_prefix and c.get("speaker"):
            body = f"{c['speaker']}: {body}"
        events.append(f"Dialogue: 0,{ass_time(start_ms)},{ass_time(end_ms)},Default,{c.get('speaker') or ''},0,0,0,,{pos}{body}")
    return "\n".join(head + events) + "\n"


def export_text(
    track: dict[str, Any],
    fmt: str,
    fps: tuple[int, int],
    width: int,
    height: int,
    *,
    range_frames: tuple[int, int] | None = None,
    trim: bool = False,
    speaker_prefix: bool = False,
    vtt_word_timing: bool = False,
) -> str:
    fmt = fmt.lower()
    if fmt not in FORMATS:
        raise ValueError(f"不支援的字幕格式 {fmt!r}（{'|'.join(FORMATS)}）")
    k0, k1 = range_frames if range_frames else (None, None)
    cues = select_cues(track, k0, k1, trim)
    if fmt == "srt":
        return to_srt(track, fps, cues=cues, speaker_prefix=speaker_prefix)
    if fmt == "vtt":
        return to_vtt(track, fps, cues=cues, speaker_prefix=speaker_prefix, word_timing=vtt_word_timing)
    if fmt == "ass":
        return to_ass(track, fps, width, height, cues=cues, speaker_prefix=speaker_prefix)
    return to_txt(track, cues=cues, speaker_prefix=speaker_prefix)


def write_text(path: Any, content: str) -> None:
    """UTF-8 無 BOM、LF；先寫**唯一**的 `.part` 再 rename（半寫的字幕檔不能被播放器／上傳流程讀到）。"""
    from .. import atomic

    atomic.write_text(path, content, newline="\n")
