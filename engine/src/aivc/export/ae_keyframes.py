"""After Effects 關鍵幀剪貼簿文字（計畫 §17.5 #2，次格式）。

⚠ **角落順序假設 [U]（尚未實證）**：AE Corner Pin 效果的四個角在剪貼簿文字裡是
    `Effects<TAB>ADBE Corner Pin #1<TAB>ADBE Corner Pin-000N`，N = 0002..0005，
本模組假設 0002 = Upper Left、0003 = Upper Right、0004 = Lower Left、0005 = Lower Right（AE 效果面板的顯示順序）。
E1 DoD (10) 要在 AE 建一個 Corner Pin、四角各打不同 keyframe、複製出來比對後把這個對照表釘死；
實證前任何依賴它的下游都要知道這是假設。對照表集中在 `AE_CORNER_ORDER`，改一處即可。

容器格式 [V]（AE 8.0 起不變）：
    Adobe After Effects 8.0 Keyframe Data
    <空行>
    <TAB>Units Per Second<TAB>30            ← Rational fps 精確值：30/1→30、30000/1001→29.97、24000/1001→23.976
    <TAB>Source Width<TAB>1280
    <TAB>Source Height<TAB>720
    <TAB>Source Pixel Aspect Ratio<TAB>1
    <TAB>Comp Pixel Aspect Ratio<TAB>1
    <空行>
    Effects<TAB>ADBE Corner Pin #1<TAB>ADBE Corner Pin-0002
    <TAB>Frame<TAB>X pixels<TAB>Y pixels<TAB>
    <TAB>0<TAB>248.5<TAB>410.25<TAB>
    <空行>
    …（另三個角）
    End of Keyframe Data
座標系：AE 圖層座標左上原點、Y 向下、來源像素 → 與我們 quad **免轉換**。
幀號：AE 合成從 0 起算，所以 `frame_ae = k_proxy + frameOffset`，**AE 口味的預設 frameOffset 是 0**
（Nuke 是 1）；exportDefaults.trackData.frameOffset 若有明確值則兩者都用它。

口味 `cornerpin`（只角釘）／`cornerpin+transform`（另寫 Transform Position／Scale／Rotation 區塊，
讓 AE 圖層動態模糊有變換可算——AE 的 Corner Pin 效果本身收不到圖層動態模糊 [S]）。Transform 是由四角推的近似：
Position = 四角質心（Z=0）、Scale = 上邊長／模板寬、左邊長／模板高（%）、Rotation = 上邊 TL→TR 的角度（度）。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Mapping, Sequence

import numpy as np

Quad = Sequence[Sequence[float]] | np.ndarray

HEADER = "Adobe After Effects 8.0 Keyframe Data"
FOOTER = "End of Keyframe Data"
EFFECT_MATCH = "ADBE Corner Pin #1"
# (property id, 人話標籤, 我們 quad 的索引)  —— [U] 見模組說明
AE_CORNER_ORDER: tuple[tuple[str, str, int], ...] = (
    ("ADBE Corner Pin-0002", "Upper Left", 0),
    ("ADBE Corner Pin-0003", "Upper Right", 1),
    ("ADBE Corner Pin-0004", "Lower Left", 3),
    ("ADBE Corner Pin-0005", "Lower Right", 2),
)
DEFAULT_FRAME_OFFSET = 0


def format_fps(num: int, den: int) -> str:
    """Rational → AE 顯示字串：30/1→`30`、30000/1001→`29.97`、24000/1001→`23.976`。"""
    f = Fraction(int(num), int(den))
    if f.denominator == 1:
        return str(f.numerator)
    s = f"{float(f):.3f}".rstrip("0").rstrip(".")
    return s


def _fmt(v: float, precision: int = 4) -> str:
    s = f"{float(v):.{precision}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def _transform_of(quad: np.ndarray, template_wh: tuple[int, int]) -> tuple[tuple[float, float], tuple[float, float], float]:
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    c = q.mean(axis=0)
    top = q[1] - q[0]
    left = q[3] - q[0]
    w, h = template_wh
    sx = 100.0 * float(np.linalg.norm(top)) / max(float(w), 1e-9)
    sy = 100.0 * float(np.linalg.norm(left)) / max(float(h), 1e-9)
    rot = math.degrees(math.atan2(float(top[1]), float(top[0])))
    return (float(c[0]), float(c[1])), (sx, sy), rot


def ae_keyframes(
    frames: Mapping[int, Quad | None],
    *,
    fps: tuple[int, int],
    width: int,
    height: int,
    template_wh: tuple[int, int] = (630, 880),
    frame_offset: int = DEFAULT_FRAME_OFFSET,
    flavour: str = "cornerpin",
    precision: int = 4,
) -> str:
    if flavour not in ("cornerpin", "cornerpin+transform"):
        raise ValueError(f"未知口味 {flavour!r}（cornerpin | cornerpin+transform）")
    ks = sorted(k for k, q in frames.items() if q is not None)
    L: list[str] = [HEADER, ""]
    L.append(f"\tUnits Per Second\t{format_fps(*fps)}")
    L.append(f"\tSource Width\t{int(width)}")
    L.append(f"\tSource Height\t{int(height)}")
    L.append("\tSource Pixel Aspect Ratio\t1")
    L.append("\tComp Pixel Aspect Ratio\t1")
    L.append("")
    for prop_id, _label, ci in AE_CORNER_ORDER:
        L.append(f"Effects\t{EFFECT_MATCH}\t{prop_id}")
        L.append("\tFrame\tX pixels\tY pixels\t")
        for k in ks:
            q = np.asarray(frames[k], dtype=np.float64).reshape(4, 2)  # type: ignore[arg-type]
            L.append(f"\t{int(k) + int(frame_offset)}\t{_fmt(q[ci, 0], precision)}\t{_fmt(q[ci, 1], precision)}\t")
        L.append("")
    if flavour == "cornerpin+transform":
        pos: list[str] = ["Transform\tPosition", "\tFrame\tX pixels\tY pixels\tZ pixels\t"]
        scl: list[str] = ["Transform\tScale", "\tFrame\tX percent\tY percent\tZ percent\t"]
        rot: list[str] = ["Transform\tRotation", "\tFrame\tdegrees\t"]
        for k in ks:
            q = np.asarray(frames[k], dtype=np.float64).reshape(4, 2)  # type: ignore[arg-type]
            (cx, cy), (sx, sy), deg = _transform_of(q, template_wh)
            f = int(k) + int(frame_offset)
            pos.append(f"\t{f}\t{_fmt(cx, precision)}\t{_fmt(cy, precision)}\t0\t")
            scl.append(f"\t{f}\t{_fmt(sx, precision)}\t{_fmt(sy, precision)}\t100\t")
            rot.append(f"\t{f}\t{_fmt(deg, precision)}\t")
        L += pos + [""] + scl + [""] + rot + [""]
    L.append(FOOTER)
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- 解析


@dataclass
class ParsedAE:
    fps: float = 0.0
    width: int = 0
    height: int = 0
    blocks: dict[tuple[str, str], dict[int, tuple[float, ...]]] = field(default_factory=dict)  # (group, prop) → frame → values
    columns: dict[tuple[str, str], list[str]] = field(default_factory=dict)

    def corner_block(self, prop_id: str) -> dict[int, tuple[float, ...]]:
        return self.blocks.get(("Effects", prop_id), {})


_HEADER_KV = re.compile(r"^\t([A-Za-z ]+)\t(.+)$")


def parse_ae_keyframes(text: str) -> ParsedAE:
    p = ParsedAE()
    lines = text.splitlines()
    if not lines or lines[0].strip() != HEADER:
        raise ValueError("不是 AE 關鍵幀剪貼簿文字（首行不對）")
    cur: tuple[str, str] | None = None
    for line in lines[1:]:
        if not line.strip():
            cur = None
            continue
        if line.strip() == FOOTER:
            break
        if not line.startswith("\t"):
            parts = line.split("\t")
            if len(parts) >= 2:
                group = parts[0]
                prop = parts[-1] if len(parts) >= 3 else parts[1]
                cur = (group, prop)
                p.blocks.setdefault(cur, {})
            continue
        if cur is None:
            m = _HEADER_KV.match(line)
            if m:
                key, val = m.group(1).strip(), m.group(2).strip()
                if key == "Units Per Second":
                    p.fps = float(val)
                elif key == "Source Width":
                    p.width = int(float(val))
                elif key == "Source Height":
                    p.height = int(float(val))
            continue
        cells = [c for c in line.split("\t")[1:] if c != ""]
        if not cells:
            continue
        if cells[0] == "Frame":
            p.columns[cur] = cells[1:]
            continue
        try:
            f = int(float(cells[0]))
            vals = tuple(float(c) for c in cells[1:])
        except ValueError:
            continue
        p.blocks[cur][f] = vals
    return p


def corners_from_parsed_ae(parsed: ParsedAE, *, frame_offset: int = DEFAULT_FRAME_OFFSET) -> dict[int, np.ndarray]:
    """依 `AE_CORNER_ORDER` 把四個角釘區塊組回 {k_proxy: quad(4,2) TL,TR,BR,BL}。"""
    blocks = [(parsed.corner_block(pid), ci) for pid, _l, ci in AE_CORNER_ORDER]
    frames: set[int] | None = None
    for b, _ in blocks:
        frames = set(b) if frames is None else frames & set(b)
    out: dict[int, np.ndarray] = {}
    for f in sorted(frames or ()):
        q = np.zeros((4, 2), dtype=np.float64)
        for b, ci in blocks:
            q[ci] = b[f][:2]
        out[int(f) - int(frame_offset)] = q
    return out
