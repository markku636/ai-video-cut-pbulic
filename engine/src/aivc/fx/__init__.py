"""fx：吃 ObjectTrack 的物件特效（隱私打碼、調色、描邊光暈、跟著物件走的貼紙與文字）。

- `params`     不可變參數 dataclass ＋ `from_json` 驗證；特效檔（stack.json）的三種寫法
- `footprint`  遮罩類特效的作用範圍（mask／box／ellipse、expand、feather）
- `effects`    純數學（線性光）：馬賽克、無光暈模糊、調色、光暈、screen
- `overlay`    貼紙／文字：擺放（錨點、樞紐、跟著縮放／旋轉）、字型（字幕那一套）、gamma 空間合成
- `apply`      `apply_effects(frame, k, objects, stacks)`：一幀套一整串，**作用範圍外逐位元相同**（定義見 apply.py）

ops：`aivc fx`（op `fx.apply`，整段渲染）、`aivc fx-preview`（op `fx.preview`，單幀 PNG）。
render.run 的整合點（專案檔裡的物件特效）見 docs/tracking-api.md 的「整合」一節。
"""
from __future__ import annotations

from .apply import FxResult, apply_effects
from .params import EFFECTS, FxError, ObjectStack, load_stack, parse_effect, parse_stack

__all__ = ["EFFECTS", "FxError", "FxResult", "ObjectStack", "apply_effects", "load_stack", "parse_effect", "parse_stack"]
