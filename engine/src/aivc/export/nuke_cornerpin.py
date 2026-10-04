"""Nuke CornerPin2D `.nk` 文字片段（計畫 §17.5 #1，主格式）。

knob 語意 [V]（learn.foundry.com CornerPin2D）：`to1`=左下 BL、`to2`=右下 BR、`to3`=右上 TR、`to4`=左上 TL；
`from1..4` 是原始角落（同序）；`motionblur`=取樣數；`shutter`=快門開啟幀數（0.5 = 半幀 = 180°）；
`shutteroffset`=centred|start|end|custom（Nuke 用英式拼法 centred）；`filter`（Impulse/Cubic/…/Lanczos4）；
`clamp`（修 Lanczos 光暈）；`black_outside`；`invert`（stabilize 語意）。

**座標轉換**（必須有單元測試釘住，見 tests/test_export.py）：
- 我們 `Quad{p:[TL,TR,BR,BL]}` 是來源像素、原點左上、Y 向下；Nuke 原點左下、Y 向上。
      to1 ← p[3]   to2 ← p[2]   to3 ← p[1]   to4 ← p[0]
      x_nuke = x_src            y_nuke = height_src − y_src
  半像素慣例 [S]：我們對外一律「邊界慣例」（像素 i 佔 [i, i+1)），Nuke 的 CornerPin 也是以影像邊界為 0 與 height，
  所以只翻 Y、不加 0.5；E1 貼進 Nuke 目視確認後若差半像素，只改這一個函式（`to_nuke_xy`）。
- `frame_nuke = k_proxy + frameOffset`（預設 1：Nuke 腳本從 1 起算，proxy 幀從 0 起算）。
- `from1..4` = 模板矩形 (0,0)-(w,h) 同序，也做 Y 翻轉：from1=(0,0) from2=(w,0) from3=(w,h) from4=(0,h)。

動畫曲線語法 [S]：`{curve x<F> v x<F> v …}`，每個 key 都明寫 `x<F>`（連續幀省略前綴也合法，但明寫最不會出錯）；
LOST／沒有解的幀直接不寫 key（Nuke 會在缺口內插；合成器那邊是 hold，兩者語意不同，交給使用者在 Nuke 補）。
口味：baked（曲線內嵌，預設）／linked（多一行 `#` 註解記 solve.v1.json 相對路徑與 trackId；Tcl 註解，Nuke 貼上會忽略）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

Quad = Sequence[Sequence[float]] | np.ndarray

# 我們 quad 索引 → Nuke to 編號：TL=p[0]→to4, TR=p[1]→to3, BR=p[2]→to2, BL=p[3]→to1
TO_INDEX_OF_CORNER: tuple[int, int, int, int] = (4, 3, 2, 1)
CORNER_OF_TO: dict[int, int] = {4: 0, 3: 1, 2: 2, 1: 3}

FILTER_BY_KERNEL: dict[str, str] = {"nearest": "Impulse", "bilinear": "Cubic", "bicubic": "Cubic", "lanczos3": "Lanczos4"}
SHUTTEROFFSET_BY_PHASE: dict[str, str] = {"centered": "centred", "start": "start", "end": "end", "custom": "custom"}


@dataclass(frozen=True)
class NukeOptions:
    node_name: str = "aivc_CornerPin2D"
    frame_offset: int = 1
    motionblur: int = 1  # 取樣數（Nuke 預設 1 = 不模糊）
    shutter: float = 0.5  # 幀；180° = 0.5
    shutteroffset: str = "centred"
    shutter_custom_offset: float = 0.0  # shutteroffset=custom 時的 shuttercustomoffset
    filter: str = "Lanczos4"
    clamp: bool = True
    black_outside: bool = True
    invert: bool = False  # True = stabilize 語意
    precision: int = 4  # 小數位數；4 位 → 往返誤差 ≤ 5e-5 px


def to_nuke_xy(x: float, y: float, height: float) -> tuple[float, float]:
    """來源像素（左上原點、Y 向下）→ Nuke（左下原點、Y 向上）。"""
    return float(x), float(height) - float(y)


def from_nuke_xy(x: float, y: float, height: float) -> tuple[float, float]:
    return float(x), float(height) - float(y)


def quad_to_nuke(quad: Quad, height: float) -> dict[int, tuple[float, float]]:
    """TL,TR,BR,BL → {to_index: (x_nuke, y_nuke)}。"""
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    return {TO_INDEX_OF_CORNER[i]: to_nuke_xy(q[i, 0], q[i, 1], height) for i in range(4)}


def quad_from_nuke(to: Mapping[int, tuple[float, float]], height: float) -> np.ndarray:
    """{to_index: (x_nuke, y_nuke)} → (4,2) TL,TR,BR,BL 來源像素。"""
    out = np.zeros((4, 2), dtype=np.float64)
    for to_i, corner in CORNER_OF_TO.items():
        x, y = to[to_i]
        out[corner] = from_nuke_xy(x, y, height)
    return out


def _fmt(v: float, precision: int) -> str:
    s = f"{float(v):.{precision}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def format_curve(keys: Iterable[tuple[int, float]], precision: int = 4) -> str:
    """`{curve x<F> v x<F> v …}`；沒有 key 時回 `0`（Nuke 接受常數）。"""
    parts = [f"x{int(f)} {_fmt(v, precision)}" for f, v in keys]
    if not parts:
        return "0"
    return "{curve " + " ".join(parts) + "}"


def nuke_cornerpin(
    frames: Mapping[int, Quad | None],
    *,
    height: int,
    template_wh: tuple[int, int],
    options: NukeOptions | None = None,
    header_lines: Sequence[str] = (),
    linked: str | None = None,
) -> str:
    """`{k: quad|None}` → CornerPin2D 節點文字。`linked` 非 None 時多一行註解（--linked 口味）。"""
    o = options or NukeOptions()
    w, h = template_wh
    ks = sorted(k for k, q in frames.items() if q is not None)
    # 每個 to 角兩條曲線（x、y）
    curves: dict[int, tuple[list[tuple[int, float]], list[tuple[int, float]]]] = {i: ([], []) for i in (1, 2, 3, 4)}
    for k in ks:
        pts = quad_to_nuke(frames[k], height)  # type: ignore[arg-type]
        f = int(k) + int(o.frame_offset)
        for to_i, (x, y) in pts.items():
            curves[to_i][0].append((f, x))
            curves[to_i][1].append((f, y))
    lines: list[str] = []
    for hl in header_lines:
        lines.append(f"# {hl}")
    if linked is not None:
        lines.append(f"# linked: {linked}")
    lines.append("CornerPin2D {")
    for to_i in (1, 2, 3, 4):
        cx, cy = curves[to_i]
        lines.append(f" to{to_i} {{{format_curve(cx, o.precision)} {format_curve(cy, o.precision)}}}")
    lines.append(f" invert {'true' if o.invert else 'false'}")
    # from：模板矩形 (0,0)-(w,h)，同樣走 Y 翻轉（模板高 = h）
    frm = quad_to_nuke([[0.0, 0.0], [float(w), 0.0], [float(w), float(h)], [0.0, float(h)]], float(h))
    for to_i in (1, 2, 3, 4):
        x, y = frm[to_i]
        lines.append(f" from{to_i} {{{_fmt(x, o.precision)} {_fmt(y, o.precision)}}}")
    lines.append(f" motionblur {int(o.motionblur)}")
    lines.append(f" shutter {_fmt(o.shutter, 4)}")
    lines.append(f" shutteroffset {o.shutteroffset}")
    if o.shutteroffset == "custom":
        lines.append(f" shuttercustomoffset {_fmt(o.shutter_custom_offset, 4)}")
    lines.append(f" filter {o.filter}")
    lines.append(f" clamp {'true' if o.clamp else 'false'}")
    lines.append(f" black_outside {'true' if o.black_outside else 'false'}")
    lines.append(f" name {o.node_name}")
    lines.append("}")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- 解析（量尺 export-roundtrip 用）


@dataclass
class ParsedNuke:
    to: dict[int, dict[int, tuple[float, float]]] = field(default_factory=dict)  # to_index → frame_nuke → (x,y)
    from_: dict[int, tuple[float, float]] = field(default_factory=dict)
    knobs: dict[str, str] = field(default_factory=dict)
    comments: list[str] = field(default_factory=list)

    @property
    def frames(self) -> list[int]:
        s: set[int] = set()
        for d in self.to.values():
            s |= set(d)
        return sorted(s)


_CURVE_RE = re.compile(r"\{curve\s+([^{}]*)\}")
_TO_RE = re.compile(r"^\s*to([1-4])\s+\{(.*)\}\s*$")
_FROM_RE = re.compile(r"^\s*from([1-4])\s+\{\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s*\}\s*$")
_KNOB_RE = re.compile(r"^\s*([A-Za-z_][\w]*)\s+(.+?)\s*$")


def parse_curve(text: str) -> dict[int, float]:
    """`x927 231.5 x928 231.6 232.0` → {927: 231.5, 928: 231.6, 929: 232.0}（省略 x 前綴 = 上一幀 +1）。"""
    out: dict[int, float] = {}
    frame: int | None = None
    for tok in text.split():
        if tok.startswith("x"):
            frame = int(float(tok[1:]))
            continue
        if frame is None:
            frame = 1  # Nuke 預設從 1 起算
        out[frame] = float(tok)
        frame += 1
    return out


def parse_nuke_cornerpin(text: str) -> ParsedNuke:
    p = ParsedNuke()
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            p.comments.append(line[1:].strip())
            continue
        m = _TO_RE.match(line)
        if m:
            idx = int(m.group(1))
            body = m.group(2)
            curves = _CURVE_RE.findall(body)
            if len(curves) == 2:
                xs, ys = parse_curve(curves[0]), parse_curve(curves[1])
                p.to[idx] = {f: (xs[f], ys[f]) for f in xs if f in ys}
            else:
                # 常數 `to1 {x y}`
                nums = [float(v) for v in body.replace("{", " ").replace("}", " ").split()]
                if len(nums) == 2:
                    p.to[idx] = {1: (nums[0], nums[1])}
            continue
        m = _FROM_RE.match(line)
        if m:
            p.from_[int(m.group(1))] = (float(m.group(2)), float(m.group(3)))
            continue
        if line in ("CornerPin2D {", "}"):
            continue
        m = _KNOB_RE.match(line)
        if m:
            p.knobs[m.group(1)] = m.group(2)
    return p


def corners_from_parsed_nuke(parsed: ParsedNuke, *, height: int, frame_offset: int = 1) -> dict[int, np.ndarray]:
    """解析結果 → {k_proxy: quad(4,2) TL,TR,BR,BL 來源像素}。"""
    out: dict[int, np.ndarray] = {}
    for f in parsed.frames:
        if not all(f in parsed.to.get(i, {}) for i in (1, 2, 3, 4)):
            continue
        to = {i: parsed.to[i][f] for i in (1, 2, 3, 4)}
        out[int(f) - int(frame_offset)] = quad_from_nuke(to, float(height))
    return out


def options_from_insert(insert: Any, *, frame_offset: int = 1, node_name: str = "aivc_CornerPin2D", invert: bool = False) -> NukeOptions:
    """從 comp.params.InsertParams（或 None）推 knob 值：samples→motionblur、shutterAngle/360→shutter、phase、kernel。"""
    if insert is None:
        return NukeOptions(node_name=node_name, frame_offset=frame_offset, invert=invert)
    mb = insert.motion_blur
    samples = mb.samples if isinstance(mb.samples, int) else 1
    return NukeOptions(
        node_name=node_name,
        frame_offset=frame_offset,
        motionblur=int(max(1, samples)),
        shutter=float(mb.shutter_frames),
        shutteroffset=SHUTTEROFFSET_BY_PHASE.get(mb.shutter_phase, "centred"),
        shutter_custom_offset=float(getattr(mb, "shutter_offset", 0.0)),
        filter=FILTER_BY_KERNEL.get(insert.resample.kernel, "Lanczos4"),
        clamp=bool(insert.resample.clamp),
        invert=invert,
    )
