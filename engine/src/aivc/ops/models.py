"""`aivc models pull [--sam tiny|small|base|large] [--owl base|large] [--sam3] [--force]`（op `models.pull`）：預先把模型權重下載進 HF_HOME。

`--sam3`（facebook/sam3，文字找物件 `aivc find` 的首選後端）是**需要申請存取**的模型庫：
下載會帶上使用者的 Hugging Face token（`seg.sam3_hf.find_hf_token`，含 `hf auth login` 存在預設位置的那份），
沒有權限時回 OpError(Model) 並說明去哪裡申請（作者人工審核）、token 怎麼設；`aivc find` 預設的 auto 會改用 OWLv2 + SAM 2.1。
它的檔案組成與 SAM 2.1 不同（沒有 preprocessor_config.json、tokenizer 有 merges.txt），所以必要檔與下載樣式另外一組。

為什麼要有：bootstrap-engine.ps1（-WithModels）與 bootstrap-engine.sh（--with-models）一直在呼叫 `aivc models pull --sam small`，
但引擎沒有這個指令 —— .ps1 印出 argparse 的 invalid choice、.sh 靜默略過；權重要到第一次按「分割」才在背景下載
（small 184 MB、large 898 MB），看起來像卡住，離線的電腦則直接失敗。

行為：
- 下載什麼：預設變體 small 一定下載（App 與 `aivc seg`／`aivc run` 預設都用它），`--sam` 另外指定的變體（例如 large）一起下載。
- 只抓 transformers 需要的檔（`*.json` + `*.safetensors`）：模型庫還放了原版 sam2 套件用的 `.pt`（一樣大），抓了等於下載兩倍。
- 冪等：先用 `local_files_only=True` 在快取裡找，而且自己確認必要檔都在（中斷過的下載會留下半套快照）；齊了就不連網。
- 進度：huggingface_hub 的 tqdm 進度條換成轉發到 `ctx.progress("models.pull", …)` 的版本（不印到 stderr）。
- 離線／連不上：回 OpError(Model)（CLI 退出碼 4），提示怎麼設 proxy／鏡像站、怎麼從別台電腦複製快取；
  bootstrap 腳本把這個失敗當警告，不擋安裝（第一次用到 SAM 2.1 時仍會自動下載）。
模型 id 與 `seg/sam2_hf.MODEL_IDS` 同一份；重 import（huggingface_hub、tqdm、sam2_hf 的 numpy）都放在函式內，`aivc --help` 不碰。
"""
from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .. import env
from . import Canceled, Ctx, OpError, register

VARIANTS = ("tiny", "small", "base", "large")  # 與 seg／run 的 --sam 選項同一組（argparse 建表時不 import sam2_hf）
#: OWLv2（文字提示找框）的變體，與 seg/text_box.MODEL_IDS 同一組。刻意**不預設下載**：
#: 它只給「打字追蹤」用，不是每個安裝都需要的 600 MB。
OWL_VARIANTS = ("base", "large")
DEFAULT_VARIANT = "small"
ALLOW_PATTERNS = ["*.json", "*.safetensors"]
REQUIRED_FILES = ("config.json", "preprocessor_config.json")
STAGE = "models.pull"

# 例外鏈上出現這些型別名＝連不上 Hugging Face（requests／httpx／urllib3／socket 各版本名稱不同，只比名字不 import）
_OFFLINE_ERRORS = {
    "LocalEntryNotFoundError", "OfflineModeIsEnabled", "IncompleteSnapshotError",
    "ConnectError", "ConnectTimeout", "ReadTimeout", "TimeoutException", "ProxyError", "NetworkError",
    "ConnectionError", "NewConnectionError", "MaxRetryError", "NameResolutionError", "gaierror", "Timeout",
}
_AUTH_ERRORS = {"GatedRepoError"}
_NOT_FOUND_ERRORS = {"RepositoryNotFoundError", "RevisionNotFoundError"}


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("action", choices=["pull"], help="pull：下載模型權重（已在本機快取就跳過）")
    p.add_argument(
        "--sam", choices=VARIANTS, default=DEFAULT_VARIANT,
        help=f"另外要下載的 SAM 2.1 變體；預設變體 {DEFAULT_VARIANT} 一定會一起下載（App 與 aivc seg／run 預設用它）",
    )
    p.add_argument(
        "--owl", choices=OWL_VARIANTS, default=None,
        help="另外下載 OWLv2（文字提示找框，aivc text-boxes 用）；不給就不下載",
    )
    p.add_argument(
        "--sam3", action="store_true",
        help="另外下載 SAM 3（facebook/sam3，aivc find 的首選後端，約 3.4 GB）；這個模型需要先在 Hugging Face 申請存取，並設定 HF_TOKEN 或 hf auth login",
    )
    p.add_argument("--force", action="store_true", help="忽略本機快取，重新下載（SAM 載入只讀本機快取、不會自動向 Hub 更新；要更新模型就用這個）")


@register("models.pull", cli="models", help="預先下載模型權重到 HF_HOME（aivc models pull --sam small|large [--owl base] [--sam3]）", args=_args)
def pull_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..seg.sam2_hf import MODEL_IDS

    action = args.get("action") or "pull"  # sidecar 的 op 名稱已經是 models.pull，args 不必再帶 action
    if action != "pull":
        raise OpError("Invalid", f"未知的 models 動作 {action!r}", hint="可用：pull")
    variants = variants_for(args.get("sam"))
    unknown = [v for v in variants if v not in MODEL_IDS]
    if unknown:
        raise OpError("Invalid", f"未知的 SAM 變體 {unknown}", hint=f"可選：{' '.join(VARIANTS)}")
    # 三個模型家族走同一條下載路徑：SAM 2.1（預設變體 + --sam）、OWLv2（只有給了 --owl 才下載）、SAM 3（只有給了 --sam3）
    targets: list[_Target] = [_Target(v, MODEL_IDS[v]) for v in variants]
    owl = args.get("owl")
    if owl:
        from ..seg.text_box import MODEL_IDS as OWL_IDS

        if owl not in OWL_IDS:
            raise OpError("Invalid", f"未知的 OWLv2 變體 {owl!r}", hint=f"可選：{' '.join(OWL_VARIANTS)}")
        targets.append(_Target(f"owl-{owl}", OWL_IDS[owl]))
    if args.get("sam3"):
        targets.append(_sam3_target())
    force = bool(args.get("force"))

    env.apply_model_env()
    hub = hub_cache_dir()
    models: list[dict[str, Any]] = []
    for t in targets:
        ctx.check_cancel()
        repo = t.repo
        path = None if force else cached_snapshot(repo, hub, allow_patterns=t.allow, required=t.required)
        cached = path is not None
        if cached:
            ctx.log("info", f"{repo} 已在本機快取，不必下載：{path}")
        else:
            ctx.log("info", f"下載 {repo} → {hub}" + (f"（Hugging Face token：{t.token_source}）" if t.gated else ""))
            try:
                path = download(repo, hub, ctx, force=force, allow_patterns=t.allow, required=t.required, token=t.token)
            except OpError as e:
                raise _gated_error(e, t) from e
        size = snapshot_bytes(path)
        models.append({"variant": t.variant, "repo": repo, "path": str(path), "cached": cached, "bytes": size})
        ctx.progress(STAGE, 1, 1, step=repo, unit="bytes", repo=repo)

    lines = [f"HF_HOME  {os.environ.get('HF_HOME')}"]
    for m in models:
        lines.append(f"{m['variant']:<6} {m['repo']:<32} {'已在快取' if m['cached'] else '已下載'}  {m['bytes'] / 1e6:.1f} MB  {m['path']}")
    return {"hfHome": os.environ.get("HF_HOME"), "hubCache": str(hub), "models": models, "_human": "\n".join(lines)}


# ---------------------------------------------------------------- 下載目標


@dataclass(frozen=True)
class _Target:
    """一個要下載的模型庫。SAM 2.1／OWLv2 沿用預設的樣式與必要檔、不帶 token（行為與以前逐字相同）。"""

    variant: str
    repo: str
    allow: tuple[str, ...] = tuple(ALLOW_PATTERNS)
    required: tuple[str, ...] = REQUIRED_FILES
    token: str | None = None
    token_source: str = ""
    gated: bool = False


def _sam3_target() -> _Target:
    from ..seg import sam3_hf as S3

    tok, src = S3.find_hf_token()
    return _Target("sam3", S3.MODEL_ID, tuple(S3.ALLOW_PATTERNS), tuple(S3.REQUIRED_FILES), tok, src or "沒有", True)


def _gated_error(e: OpError, t: _Target) -> OpError:
    """SAM 3 的權限錯誤換成說得清楚的版本（去哪裡申請、作者審核、token 怎麼設、沒有也能用後備）。其他錯誤原樣。"""
    if not t.gated or e.kind != "Model" or "沒有權限" not in str(e):
        return e
    from ..seg import sam3_hf as S3

    return OpError("Model", f"{S3.gated_message()}：{e}", S3.gated_hint())


def ensure_sam3(ctx: Ctx) -> Path | None:
    """`aivc find／select --backend sam3` 用：權重不在本機就先在這裡下載（**有進度、可取消**），再交給載入器。

    以前直接讓 transformers 的 from_pretrained 在 gpu op 裡默默抓 ~3.4 GB：沒有進度事件、取消要等下載完、
    GPU 號誌全程占著。現在走跟 `models pull --sam3` 同一條路（`progress_tqdm` 送進度、每塊檢查取消），
    沒權限一樣換成 gated 說明。權重已在本機（或 transformers 不支援 SAM 3，交給後面的錯誤處理）→ 什麼都不做。"""
    from ..seg import sam3_hf as S3

    st = S3.status()
    if st.ready or not st.supported:
        return None
    t = _sam3_target()
    env.apply_model_env()
    hub = hub_cache_dir()
    ctx.log("info", f"SAM 3 權重不在本機：下載 {t.repo} → {hub}（Hugging Face token：{t.token_source}；也可以先跑 aivc models pull --sam3）")
    try:
        path = download(t.repo, hub, ctx, allow_patterns=t.allow, required=t.required, token=t.token)
    except OpError as e:
        raise _gated_error(e, t) from e
    ctx.progress(STAGE, 1, 1, step=t.repo, unit="bytes", repo=t.repo)
    return path


# ---------------------------------------------------------------- 步驟（測試可個別替換）


def variants_for(sam: str | None) -> list[str]:
    """預設變體在前，再加使用者指定的（去重、保序）。"""
    out = [DEFAULT_VARIANT]
    if sam and sam not in out:
        out.append(str(sam))
    return out


def hub_cache_dir() -> Path:
    """與 huggingface_hub 的 constants.HF_HUB_CACHE 同規則（HF_HUB_CACHE → HF_HOME/hub）。

    明確傳給 snapshot_download：huggingface_hub 在 import 當下就讀好環境變數，若它比 apply_model_env 早被 import，
    預設快取會落在 ~/.cache/huggingface，之後 transformers 在 App 的資料目錄裡就找不到。
    """
    explicit = os.environ.get("HF_HUB_CACHE")
    if explicit:
        return Path(explicit)
    return Path(os.environ["HF_HOME"]) / "hub"


def _snapshot_download(**kwargs: Any) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(**kwargs)


def _safetensors_intact(p: Path) -> bool:
    """safetensors 的檔頭自洽：前 8 bytes 是 header 長度（小端 u64），header + 資料必須真的在檔案裡。

    只看「不是 0 bytes」抓不到**截斷**的權重（下載中斷、磁碟滿）：`snapshot_complete` 會說快取完整，
    `aivc models pull` 印「已在快取」什麼也不做，SAM 每次載入都在同一個地方失敗，使用者照著提示做沒有任何幫助（B-05）。
    整份 hash 太慢（185 MB～2.4 GB），檔頭 + 長度已經擋掉實務上會發生的那種壞法。
    """
    try:
        size = p.stat().st_size
        if size < 8:
            return False
        with open(p, "rb") as f:
            n = int.from_bytes(f.read(8), "little")
        if n <= 0 or 8 + n > size:
            return False
        return True
    except OSError:
        return False


def snapshot_complete(path: str | os.PathLike[str] | None, required: tuple[str, ...] | list[str] = REQUIRED_FILES) -> bool:
    """transformers 載入必要的檔都在（預設＝Sam2VideoModel／Sam2VideoProcessor 那組），而且 safetensors 沒有被截斷。"""
    if not path:
        return False
    d = Path(path)
    if not all((d / f).is_file() for f in required):
        return False
    try:
        weights = list(d.glob("*.safetensors"))
    except OSError:
        return False
    return bool(weights) and all(_safetensors_intact(w) for w in weights)


def cached_snapshot(
    repo: str, hub: Path, *, allow_patterns: list[str] | tuple[str, ...] | None = None, required: tuple[str, ...] | list[str] = REQUIRED_FILES,
) -> Path | None:
    """本機快取裡已有完整快照就回路徑（不連網）；沒有或不完整回 None。allow_patterns／required 省略＝SAM 2.1 那組。"""
    try:
        path = _snapshot_download(repo_id=repo, cache_dir=str(hub), local_files_only=True, allow_patterns=list(allow_patterns or ALLOW_PATTERNS))
    except Exception:  # noqa: BLE001 — 找不到、半套、版本差異的各種例外都等於「沒有快取」
        return None
    return Path(path) if snapshot_complete(path, required) else None


def download(
    repo: str, hub: Path, ctx: Ctx, *, force: bool = False, allow_patterns: list[str] | tuple[str, ...] | None = None,
    required: tuple[str, ...] | list[str] = REQUIRED_FILES, token: str | None = None,
) -> Path:
    kw: dict[str, Any] = {}
    if token:
        kw["token"] = token  # 只有 gated 模型庫（SAM 3）才帶；其他照舊讓 huggingface_hub 自己決定
    try:
        path = _snapshot_download(
            repo_id=repo, cache_dir=str(hub), allow_patterns=list(allow_patterns or ALLOW_PATTERNS), force_download=force,
            tqdm_class=progress_tqdm(ctx, repo), **kw,
        )
    except (Canceled, KeyboardInterrupt):
        raise
    except Exception as e:  # noqa: BLE001
        # 取消是在下載執行緒的進度回呼裡擲出的：huggingface_hub 可能把它包成自己的例外，要從例外鏈裡認回來
        if any(isinstance(x, Canceled) for x in _exception_chain(e)):
            raise Canceled() from e
        raise classify_error(e, repo, hub) from e
    if not snapshot_complete(path, required):
        raise OpError(
            "Model", f"{repo} 下載完成但缺必要檔（{', '.join(required)}、*.safetensors）：{path}",
            hint="加 --force 重新下載；仍然缺檔代表模型庫內容變了，請回報",
        )
    return Path(path)


def snapshot_bytes(path: str | os.PathLike[str]) -> int:
    """快照資料夾的實際大小（snapshots 裡是指向 blobs 的連結，stat 會跟著連結算真實大小）。"""
    total = 0
    for p in Path(path).rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            pass
    return total


# ---------------------------------------------------------------- 進度


class _NullWriter:
    def write(self, _s: str) -> int:
        return 0

    def flush(self) -> None:
        pass


def progress_tqdm(ctx: Ctx, repo: str) -> type:
    """回一個 tqdm 子類別：畫面輸出丟掉，更新轉成 `ctx.progress`，順便在每次更新時檢查取消。

    huggingface_hub 1.x 會開三條進度條：「Fetching N files」（檔數）、「Downloading bytes」（網路傳輸）、
    「Reconstructing …」（寫進磁碟的位元組，總量＝檔案大小總和）。只轉發寫入位元組那條，否則進度會在兩條之間跳；
    舊版（0.3x）只把 tqdm_class 用在檔數那條，那就退而求其次轉發檔數。
    """
    from tqdm.auto import tqdm as base

    state = {"bytes_seen": False}

    class CtxTqdm(base):  # type: ignore[misc, valid-type]
        def __init__(self, *a: Any, **kw: Any) -> None:
            kw.pop("name", None)  # huggingface_hub 自己的 tqdm 才收 name；原版 tqdm 會擲 TqdmKeyError
            kw["file"] = _NullWriter()  # CLI --json 的 stdout／sidecar 的 stderr 都不是給人看進度條的地方
            kw["disable"] = False  # 非 TTY 時 tqdm 預設停用，停用後 update 不會進來
            super().__init__(*a, **kw)

        def update(self, n: float | None = 1) -> bool | None:
            r = super().update(n)
            self._forward()
            return r

        def _forward(self) -> None:
            ctx.check_cancel()
            desc = str(self.desc or "")
            is_bytes = str(self.unit) == "B"
            if is_bytes:
                if desc.lower().startswith("downloading bytes"):
                    return
                state["bytes_seen"] = True
            elif state["bytes_seen"]:
                return
            done = int(self.n or 0)
            total = max(int(self.total or 0), done)
            ctx.progress(STAGE, done, total, step=repo, unit="bytes" if is_bytes else "files", repo=repo)

    return CtxTqdm


# ---------------------------------------------------------------- 錯誤


def _exception_chain(e: BaseException) -> list[BaseException]:
    out: list[BaseException] = []
    cur: BaseException | None = e
    while cur is not None and cur not in out and len(out) < 16:
        out.append(cur)
        cur = cur.__cause__ or cur.__context__
    return out


def _offline_env() -> bool:
    return (os.environ.get("HF_HUB_OFFLINE") or "").strip().lower() in ("1", "true", "yes", "on")


def classify_error(e: BaseException, repo: str, hub: Path) -> OpError:
    chain = _exception_chain(e)
    names = {type(x).__name__ for x in chain}
    status = next((getattr(getattr(x, "response", None), "status_code", None) for x in chain if getattr(x, "response", None) is not None), None)
    short = f"{type(e).__name__}: {str(e).splitlines()[0][:200] if str(e) else ''}"
    folder = "models--" + repo.replace("/", "--")
    if names & _AUTH_ERRORS or status in (401, 403):
        return OpError("Model", f"沒有權限下載 {repo}（{short}）", hint="這個模型庫需要 Hugging Face 帳號授權：設定 HF_TOKEN 後再試")
    if names & _NOT_FOUND_ERRORS or status == 404:
        return OpError("Model", f"Hugging Face 上找不到 {repo}（{short}）", hint="模型庫可能改名或下架；確認 HF_ENDPOINT 沒有指到不完整的鏡像站")
    disk_full = any(isinstance(x, OSError) and getattr(x, "errno", None) == 28 for x in chain)
    if disk_full:
        return OpError("Io", f"下載 {repo} 時磁碟空間不足", hint=f"清出空間（small 約 185 MB、large 約 900 MB）；快取位置 {hub}")
    if _offline_env() or names & _OFFLINE_ERRORS:
        why = "目前設了 HF_HUB_OFFLINE=1，不會連網，而本機快取裡沒有" if _offline_env() else "連不上 Hugging Face"
        return OpError(
            "Model",
            f"無法下載 {repo}：{why}（{short}）",
            hint=(
                "檢查網路或公司 proxy（HTTPS_PROXY），或設 HF_ENDPOINT 指向鏡像站；"
                f"離線電腦：在有網路的電腦執行 `aivc models pull`，再把它的 <HF_HOME>/hub/{folder} 整個資料夾複製到 {hub}。"
                "不預先下載也能用：第一次用到 SAM 2.1 時會自動下載"
            ),
        )
    return OpError("Model", f"下載 {repo} 失敗（{short}）", hint=f"加 --force 重試；快取位置 {hub}")


__all__ = ["pull_op", "variants_for", "cached_snapshot", "download", "classify_error", "progress_tqdm", "ensure_sam3", "ALLOW_PATTERNS"]
