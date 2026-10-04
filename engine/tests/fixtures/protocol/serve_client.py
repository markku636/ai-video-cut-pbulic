"""serve 整合測試共用（test_serve_shutdown 等）：真的 spawn `aivc serve` 的客戶端 + 合成渲染場景。

Client 的讀取執行緒把回覆依 id 存起來（附收到時刻），事件照順序存；stderr 一定排空（Windows 64 KB 管線）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

ENGINE = Path(__file__).resolve().parents[3]
PROTOCOL_DIR = Path(__file__).resolve().parent
E1_DIR = PROTOCOL_DIR.parent / "e1"
# 測試外掛（通用貼圖插入來源）：子行程的 sidecar 也要載得到它，render.run 才有東西合成
PLUGINS_DIR = PROTOCOL_DIR.parent / "plugins"


class Client:
    def __init__(self, extra_env: dict[str, str] | None = None, extra_ops: str = "aivc_fake_ops") -> None:
        env = dict(os.environ)
        env.pop("AIVC_NO_PLUGINS", None)  # 安全模式會連測試外掛 aivc_test_insert 一起關掉 → 沒東西合成、渲染瞬間跑完
        env["AIVC_EXTRA_OPS"] = extra_ops
        env["PYTHONPATH"] = os.pathsep.join([str(PROTOCOL_DIR), str(PLUGINS_DIR), str(ENGINE / "src"), env.get("PYTHONPATH", "")])
        # 原本有的外掛（例如跑「含牌局外掛」的整套測試時的 aivc_cards）照留，再加上測試外掛
        env["AIVC_PLUGINS"] = ",".join(x for x in (env.get("AIVC_PLUGINS", ""), "aivc_test_insert") if x)
        env["PYTHONUTF8"] = "1"
        env.pop("AIVC_RUN_GPU_TESTS", None)
        env.update(extra_env or {})
        self.proc = subprocess.Popen(
            [sys.executable, "-X", "utf8", "-m", "aivc", "serve", "--no-torch-probe"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(ENGINE), env=env,
        )
        self.replies: dict[Any, tuple[float, dict[str, Any]]] = {}
        self.events: list[tuple[float, dict[str, Any]]] = []
        self.stderr: list[str] = []
        self._cv = threading.Condition()
        threading.Thread(target=self._pump_out, daemon=True).start()
        threading.Thread(target=self._pump_err, daemon=True).start()

    def _pump_out(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            msg = json.loads(raw.decode("utf-8"))
            now = time.monotonic()
            with self._cv:
                if "ok" in msg:
                    self.replies[msg["id"]] = (now, msg)
                else:
                    self.events.append((now, msg))
                self._cv.notify_all()

    def _pump_err(self) -> None:
        assert self.proc.stderr is not None
        for raw in self.proc.stderr:
            self.stderr.append(raw.decode("utf-8", "replace").rstrip())

    def send(self, obj: dict[str, Any]) -> float:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n")
        self.proc.stdin.flush()
        return time.monotonic()

    def reply(self, rid: Any, timeout: float = 30.0) -> tuple[float, dict[str, Any]]:
        deadline = time.monotonic() + timeout
        with self._cv:
            while rid not in self.replies:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError(f"{rid!r} 沒有回覆（stderr 尾巴：{self.stderr[-5:]}）")
                self._cv.wait(left)
            return self.replies[rid]

    def wait_event(self, pred: Any, timeout: float = 30.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        with self._cv:
            while True:
                for _, e in self.events:
                    if pred(e):
                        return e
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError("等不到事件")
                self._cv.wait(left)

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                self.send({"id": "bye-close", "op": "shutdown"})
                self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            self.proc.kill()
        finally:
            for s in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                try:
                    if s:
                        s.close()
                except Exception:  # noqa: BLE001
                    pass


def make_scene(root: Path, n_frames: int, deck_root: Path) -> tuple[Path, Path]:
    """合成影片（n 幀、一塊「原圖」平面 → 換成新圖）+ 專案檔／solve／遮罩（寫進目前的 AIVC_CACHE_DIR）。回 (專案檔, 影片)。

    插入來源是測試外掛 aivc_test_insert（Client 已經讓 sidecar 載入它）；兩張貼圖放 `deck_root`（名字沿用：以前放合成牌組）。"""
    if str(E1_DIR) not in sys.path:
        sys.path.insert(0, str(E1_DIR))
    import synth_scene as SC  # noqa: WPS433

    new, orig = SC.write_sign_pngs(deck_root / "signs")
    q = SC.card_quad(250, 410, 122, 80)
    orig_rgba = SC.make_sign_rgba("orig")
    frames = []
    for k in range(n_frames):
        img = SC.felt_frame()
        SC.paste_rgba(img, orig_rgba, q, shade=0.92)
        frames.append(img)
    video = SC.write_clip(root / "牌桌 clip.mkv", frames)
    ppath, _proj, _cache = SC.make_project(video, n_frames, [{"id": "t1", "quad": q, "image": new, "original": orig, "name": "Player1"}])
    return ppath, video
