//! 受管 Python 環境（計畫 §7.1）：路徑、偵測（CUDA 閘門）、引導安裝（串流輸出）、引擎環境變數。
//!
//! 藍本是 ai-music-cut 的 `local_asr.rs`：`--version` 探測含 timeout、`run_streaming`（stdout + stderr
//! 都讀、`kind: step|line|done`）、`is_exception_line`、`parse_nvidia_smi`，以及那條**讀取迴圈規則**：
//! 不能寫 `while let Ok(Some(..))` —— 一行不是合法 UTF-8 就結束迴圈，之後沒有人讀管線、子程序卡死。
//!
//! **Python 解析順序 `AIVC_PYTHON` → 受管 venv → 錯誤，絕不退回 PATH**（決策 9）：
//! 這台機器 PATH 上的 torch 是 `2.14.0+cpu`，import 全成功、cuda 回 False、SAM 以 0.2 fps 安靜地跑。
//! 閘門（`gate`，依 OS）：
//! - Windows / Linux：`+cu130` ∧ `cuda.is_available()` ∧ `sm_XY ∈ get_arch_list()`（bf16 GEMM / cv2<5 由 `aivc doctor` 補）；
//! - macOS（Apple Silicon）：PyPI torch 沒有 `+cu130` 後綴，改看 `torch.backends.mps.is_available()`；
//! - 兩條都不過 → 拒絕，除非 `AIVC_ALLOW_CPU=1`（CI / 除錯才准 CPU，狀態訊息會寫明「很慢」）。
//!
//! 引導腳本也依 OS：Windows 用 `bootstrap-engine.ps1`（PowerShell），macOS / Linux 用 `bootstrap-engine.sh`（以 bash 執行），
//! 兩支的步驟、`==>` 步驟行與 uv 釘版（`uv-manifest.json`）一致。
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use sha2::Digest;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};

use crate::error::{AppError, AppResult};
use crate::proc;
use crate::store::{self, AppSettings};

pub const ENV_PYTHON: &str = "AIVC_PYTHON";
/// venv 內的印記，**只有 App 的安裝流程會寫**（引導腳本不碰）。內容是下面三種之一（規則見 `stamp_state`）：
/// - sha256(requirements.lock.txt) 的 hex：上次 App 安裝成功，裝的是這份 lock；lock 之後變了就是 `stale`；
/// - `installing`（`STAMP_INSTALLING`）：開始安裝時寫，沒有被結果蓋掉＝安裝沒跑完（App 被關、當掉）；
/// - `failed …`（`STAMP_FAILED`）：上次 App 安裝失敗（含 doctor 閘門沒過）。
pub const STAMP_FILE: &str = ".stamp";
pub const STAMP_INSTALLING: &str = "installing";
pub const STAMP_FAILED: &str = "failed";
pub const LOCK_FILE: &str = "requirements.lock.txt";
/// 第一次 `import torch` 在冷機上要十幾秒；90 秒是「真的卡住」的界線。
pub const DETECT_TIMEOUT: Duration = Duration::from_secs(90);
/// 引擎要求的 torch CUDA 後綴（cu128 只到 torch 2.11、沒有 sm_120 SASS）。Windows 與 Linux 都裝 cu130 index 的 wheel。
pub const REQUIRED_CUDA_SUFFIX: &str = "+cu130";
/// `AIVC_ALLOW_CPU=1` 才准沒有 GPU 後端時以 CPU 跑（CI 的 CPU torch / 除錯）。引擎 `device.allow_cpu()` 讀同一個變數；
/// 只認 `1`（兩邊認的值不一致時，App 說 ready、引擎卻拒絕，比兩邊都拒絕更難查）。
pub const ENV_ALLOW_CPU: &str = "AIVC_ALLOW_CPU";

/// 全部資料目錄（`data_root` 預設 `app_local_data_dir()`，設定 `engine.data_root` 可整體搬到 D:）。
#[derive(Debug, Clone, Serialize)]
pub struct PyEnvPaths {
    pub root: PathBuf,
    pub venv: PathBuf,
    pub python: PathBuf,
    pub models_hf: PathBuf,
    pub models_torch: PathBuf,
    pub tools_uv: PathBuf,
    pub logs: PathBuf,
}

/// venv 內的直譯器：Windows 的 venv 是 `Scripts\python.exe`，macOS / Linux 是 `bin/python`
/// （`uv venv` 與 `python -m venv` 都照這個慣例）。`os` 是 `std::env::consts::OS` 的值；
/// 抽成參數才能在任一平台上把兩種形狀都測到（CI 只在 Windows 跑時，unix 那條路徑錯了也不會紅）。
pub fn venv_python_for(venv: &Path, os: &str) -> PathBuf {
    if os == "windows" {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

pub fn paths_under(root: &Path) -> PyEnvPaths {
    let venv = root.join("pyenv");
    let python = venv_python_for(&venv, std::env::consts::OS);
    PyEnvPaths {
        root: root.to_path_buf(),
        venv,
        python,
        models_hf: root.join("models").join("hf"),
        models_torch: root.join("models").join("torch"),
        tools_uv: root.join("tools").join("uv"),
        logs: root.join("logs"),
    }
}

pub fn paths(app: &AppHandle, settings: &AppSettings) -> AppResult<PyEnvPaths> {
    let root = match settings.engine.data_root.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(r) => PathBuf::from(r),
        None => store::app_local_data_dir(app)?,
    };
    Ok(paths_under(&root))
}

/// 解析要用的 python：`AIVC_PYTHON`（或設定 `python_override`）→ 受管 venv → None。**永不看 PATH。**
pub fn resolve_python(paths: &PyEnvPaths, override_: Option<&str>) -> Option<PathBuf> {
    let env = std::env::var(ENV_PYTHON).ok();
    let cand = override_
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| env.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from));
    if let Some(p) = cand {
        return if p.is_file() { Some(p) } else { None };
    }
    if paths.python.is_file() {
        Some(paths.python.clone())
    } else {
        None
    }
}

/// 一行 python：印出 `{v, cuda, mps, name, cc, arch}`。不 import transformers（那要 10 秒以上，只是為了畫一個勾不值得）。
/// `mps` 用 getattr 取：老版 torch 沒有 `torch.backends.mps`，不能讓偵測腳本本身丟例外（那會被當成 broken 而不是「沒有 MPS」）。
/// `get_arch_list()` 在沒有 CUDA 的 build（macOS）回空清單，不會丟例外。
pub const DETECT_SCRIPT: &str = "import json,torch\n\
cuda=bool(torch.cuda.is_available())\n\
cc=torch.cuda.get_device_capability(0) if cuda else None\n\
m=getattr(torch.backends,'mps',None)\n\
mps=bool(m is not None and m.is_available())\n\
print(json.dumps({'v':torch.__version__,'cuda':cuda,'mps':mps,'name':torch.cuda.get_device_name(0) if cuda else None,'cc':('%d%d'%cc) if cc else None,'arch':list(torch.cuda.get_arch_list())}))";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct DetectInfo {
    pub torch: String,
    pub cuda: bool,
    /// Apple Silicon 的 Metal 後端（`torch.backends.mps.is_available()`）；舊版偵測輸出沒有這個鍵 → false。
    pub mps: bool,
    pub device: Option<String>,
    /// `"120"`（sm_120）之類；沒有 CUDA 就 None。
    pub cc: Option<String>,
    pub arch: Vec<String>,
}

/// 從偵測腳本的 stdout 取最後一行合法 JSON（torch 偶爾會在前面印警告）。
pub fn parse_detect_output(out: &str) -> Option<DetectInfo> {
    for line in out.lines().rev() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        return Some(DetectInfo {
            torch: v["v"].as_str().unwrap_or("").to_string(),
            cuda: v["cuda"].as_bool().unwrap_or(false),
            mps: v["mps"].as_bool().unwrap_or(false),
            device: v["name"].as_str().map(str::to_string),
            cc: v["cc"].as_str().map(str::to_string),
            arch: v["arch"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
        });
    }
    None
}

/// `AIVC_ALLOW_CPU` 的值是否代表放行：只認字面上的 `1`（不 trim），與引擎 `device.allow_cpu()` 的
/// `os.environ.get(...) == "1"` 逐字相同 —— 寬鬆一點（例如接受 ` 1 `）就會出現 App 說 ready、引擎 doctor 卻拒絕的分歧。
pub fn allow_cpu_value(v: Option<&str>) -> bool {
    v == Some("1")
}

pub fn allow_cpu_from_env() -> bool {
    allow_cpu_value(std::env::var(ENV_ALLOW_CPU).ok().as_deref())
}

/// 閘門通過：用哪個後端（`cuda` | `mps` | `cpu`），以及要不要附註（CPU 放行時要講清楚會很慢）。
#[derive(Debug, Clone, PartialEq)]
pub struct GateOk {
    pub backend: &'static str,
    pub note: Option<String>,
}

/// 閘門（決策 9）。回 Err 時是給使用者看的具體原因（哪一項、現況是什麼）。
///
/// `os` 是 `std::env::consts::OS`、`allow_cpu` 是 `AIVC_ALLOW_CPU=1`；兩者都由呼叫端給，測試才不受主機 OS / CI 環境變數影響
/// （check.yml 的引擎 job 就設了 `AIVC_ALLOW_CPU`，讀全域 env 的閘門測試在那裡會變綠得莫名其妙）。
///
/// `AIVC_ALLOW_CPU` 只救「完全沒有 GPU 後端」：CUDA 明明可用但 torch 版本 / arch 不對時照樣拒絕 ——
/// 那種環境引擎會挑 cuda 當裝置、在第一個 kernel 就炸，放行只是把錯誤延後到更難看懂的地方。
pub fn gate(info: &DetectInfo, os: &str, allow_cpu: bool) -> Result<GateOk, String> {
    let no_gpu = |why: String| {
        if allow_cpu {
            Ok(GateOk { backend: "cpu", note: Some(format!("{ENV_ALLOW_CPU}=1：{why}；以 CPU 執行（非常慢，只供 CI / 除錯）")) })
        } else {
            Err(why)
        }
    };
    if os == "macos" {
        // PyPI 的 macOS torch 版本字串沒有 local 後綴（就是 `2.14.0`），+cu130 規則不適用；能力就看 MPS。
        if info.mps {
            return Ok(GateOk { backend: "mps", note: None });
        }
        return no_gpu(format!(
            "torch {} 的 torch.backends.mps.is_available() 為 False（需要 Apple Silicon + macOS 14 以上；Intel Mac 不支援）",
            info.torch
        ));
    }
    if !info.torch.ends_with(REQUIRED_CUDA_SUFFIX) {
        let why = format!("torch 是 {}，需要 {REQUIRED_CUDA_SUFFIX} 版（PATH 上的全域 python 是 CPU 版，不能用）", info.torch);
        // CPU 版 torch 本來就沒有 CUDA：這正是 AIVC_ALLOW_CPU 要放行的情況；CUDA 可用卻不是 cu130 → 一律拒絕
        return if info.cuda { Err(why) } else { no_gpu(why) };
    }
    if !info.cuda {
        return no_gpu("torch.cuda.is_available() 為 False（驅動 / CUDA runtime 沒接上）".to_string());
    }
    let Some(cc) = info.cc.as_deref() else {
        return Err("讀不到顯示卡的 compute capability".to_string());
    };
    let sm = format!("sm_{cc}");
    if !info.arch.iter().any(|a| a == &sm) {
        return Err(format!("這張卡 {sm} 不在 torch 編譯的 arch 清單 {:?}", info.arch));
    }
    Ok(GateOk { backend: "cuda", note: None })
}

/// 前端 `EngineSetup` / `StatusBar` 用的狀態。`state`：missing | stale | installing | ready | broken。
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct PyEnvStatus {
    pub state: String,
    /// 解析到的 python 路徑（None = missing）。
    pub python: Option<String>,
    pub torch: Option<String>,
    pub cuda: bool,
    /// macOS 的 Metal 後端可用（`torch.backends.mps.is_available()`）。
    pub mps: bool,
    /// 閘門通過時實際用的後端：`cuda` | `mps` | `cpu`（`AIVC_ALLOW_CPU=1`）；沒通過 / 沒偵測就是 None。
    pub backend: Option<String>,
    /// GPU 名。venv 缺時改由 nvidia-smi（macOS 是 sysctl 的晶片名）補上，讓「硬體需求」區塊在安裝前就能講話。
    pub device: Option<String>,
    pub arch: Vec<String>,
    /// venv 的 `.stamp` == sha256(requirements.lock.txt)。沒有 stamp（例如手動 bootstrap）視為 true 但會在 message 註明；
    /// 上次 App 安裝失敗 / 沒跑完（`failed` / `installing` 印記）視為 false —— 依賴裝到哪裡不知道，重新安裝才能確定。
    pub lock_ok: bool,
    pub message: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// `.stamp` 讀出來代表什麼（`detect` 再與閘門結果合併，見 `apply_gate_and_stamp`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StampState {
    /// 沒有 `.stamp`：手動跑引導腳本（CLI）建的環境，App 無從核對 → 照閘門判斷，訊息註明。
    Missing,
    /// 上次 App 安裝成功，而且 lock 沒變。
    Current,
    /// 上次 App 安裝成功，但 lock 之後變了（印記內容看不懂也歸這裡：保守地要求重裝，而不是當成沒問題）。
    Outdated,
    /// 有成功印記，但找不到 lock 檔可以比對。
    Unverified,
    /// 上次 App 安裝沒有成功：腳本失敗（含 doctor 閘門沒過）或沒跑完。`detail` 是給人看的原因。
    Failed { detail: String },
}

/// 讀 `.stamp` 的規則。重點是 `Failed`：安裝失敗時 venv 往往已經建好、torch 也裝了，
/// `detect` 只 import torch 的閘門照樣會過 —— 沒有這條，一個 doctor 閘門沒過（例如缺 ffmpeg）的環境會被報成 ready。
pub fn stamp_state(venv: &Path, lock_file: Option<&Path>) -> StampState {
    let Ok(raw) = std::fs::read_to_string(venv.join(STAMP_FILE)) else {
        return StampState::Missing;
    };
    let s = raw.trim();
    if s == STAMP_INSTALLING {
        return StampState::Failed { detail: "上次安裝沒有跑完（安裝途中 App 被關閉或當掉）".into() };
    }
    // hex 雜湊不可能以 "failed" 開頭（i、l 不是十六進位字元），不會誤判
    if let Some(rest) = s.strip_prefix(STAMP_FAILED) {
        let rest = rest.trim();
        let detail = if rest.is_empty() { "上次安裝失敗".to_string() } else { format!("上次安裝失敗（{rest}）") };
        return StampState::Failed { detail };
    }
    let Some(lock) = lock_file.and_then(|p| std::fs::read(p).ok()) else {
        return StampState::Unverified;
    };
    if s == sha256_hex(&lock) {
        StampState::Current
    } else {
        StampState::Outdated
    }
}

pub fn write_stamp(venv: &Path, lock_file: &Path) -> AppResult<()> {
    let lock = std::fs::read(lock_file)?;
    std::fs::write(venv.join(STAMP_FILE), sha256_hex(&lock))?;
    Ok(())
}

/// 開始安裝：venv 已存在（重裝）就先把印記換成 `installing`。
/// 不先換的話，上一次成功留下的 hash 會一直在 —— 安裝途中 App 被關掉，半套環境下次開啟會顯示 ready。
/// venv 不存在（第一次安裝）時不建目錄：腳本會把「只有 .stamp 的 pyenv/」當成殘留清掉，寫了也沒用。
pub fn mark_install_started(venv: &Path) -> std::io::Result<()> {
    if venv.is_dir() {
        std::fs::write(venv.join(STAMP_FILE), STAMP_INSTALLING)?;
    }
    Ok(())
}

/// 失敗印記的內容：`failed exit 1`；沒有結束碼（被訊號殺掉、腳本根本沒啟動）另外講。
pub fn failed_stamp_text(code: Option<i32>) -> String {
    match code {
        Some(c) => format!("{STAMP_FAILED} exit {c}"),
        None => format!("{STAMP_FAILED} 沒有結束碼（被終止或無法啟動）"),
    }
}

/// 安裝結束（不論成敗）時更新印記：
/// - 成功（exit 0）：有 lock → 寫 hash；找不到 lock → 刪掉印記（不能留著 `installing` 讓 `detect` 以為沒跑完）；
///   寫 hash 失敗也刪掉，寧可退回「沒有 .stamp」（ready + 註明）也不要誤報失敗；
/// - 失敗：venv 目錄在 → 寫 `failed …`（蓋掉上一次成功的 hash）；
///   venv 目錄不在（腳本在建 venv 之前就停了，例如 ffmpeg 預檢、磁碟空間）→ 不寫，`detect` 本來就回 missing。
pub fn record_install_outcome(venv: &Path, lock_file: Option<&Path>, code: Option<i32>) -> std::io::Result<()> {
    let stamp = venv.join(STAMP_FILE);
    let remove = || match std::fs::remove_file(&stamp) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    };
    if code == Some(0) {
        let Some(lock) = lock_file else { return remove() };
        let written = std::fs::read(lock).and_then(|bytes| std::fs::write(&stamp, sha256_hex(&bytes)));
        if let Err(e) = written {
            let _ = remove();
            return Err(e);
        }
        return Ok(());
    }
    if venv.is_dir() {
        std::fs::write(&stamp, failed_stamp_text(code))?;
    }
    Ok(())
}

/// 引擎原始碼 / lock 檔在哪：正式版 `<resource_dir>/resources/engine/`，dev 是 repo 的 `engine/`
/// （用 `CARGO_MANIFEST_DIR` 算，只在 debug build）。
pub fn engine_source_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(r) = resource_dir {
        let d = r.join("resources").join("engine");
        if d.join(LOCK_FILE).is_file() {
            return Some(d);
        }
    }
    if cfg!(debug_assertions) {
        let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("engine");
        if d.join(LOCK_FILE).is_file() {
            return Some(dunce::simplified(&d).to_path_buf());
        }
    }
    None
}

// ---------------- 引擎 wheel ----------------

/// `aivc-0.0.4-py3-none-any.whl` → `"0.0.4"`（wheel 檔名規格 `{dist}-{version}(-{build})?-{py}-{abi}-{plat}.whl`）。
/// 不是 aivc 的 wheel、或版本段不是數字開頭 → None。
pub fn wheel_version(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".whl")?;
    let mut it = stem.split('-');
    let dist = it.next()?;
    if !dist.eq_ignore_ascii_case("aivc") {
        return None;
    }
    let v = it.next()?;
    if !v.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(v.to_string())
}

/// App 的 semver 版號 → wheel 檔名裡的 PEP 440 寫法：setuptools 建 wheel 時會正規化 `_version.py` 的版本，
/// `0.0.8-beta.1` 變成 `aivc-0.0.8b1-…whl`，直接拿字串比永遠對不上（預先發布版的 wheel 就挑不到、更新後也不會換）。
/// 只認 sync-version.mjs 准的後綴：`-alpha[.N]` → `aN`、`-beta[.N]` → `bN`、`-rc[.N]` → `rcN`（沒寫 N 是 0）；
/// 已經是 PEP 440 的（`0.0.8b1`）原樣回（小寫），所以兩邊都過一次再比就好。認不得的後綴也原樣回 —— 比不上就是比不上。
pub fn py_version(v: &str) -> String {
    let v = v.trim().to_ascii_lowercase();
    let Some((base, pre)) = v.split_once('-') else { return v };
    let (label, num) = pre.split_once('.').unwrap_or((pre, "0"));
    let tag = match label {
        "alpha" | "a" => "a",
        "beta" | "b" => "b",
        "rc" | "c" => "rc",
        _ => return v,
    };
    match num.parse::<u64>() {
        Ok(n) => format!("{base}{tag}{n}"),
        Err(_) => v,
    }
}

/// 版本排序鍵：`0.1.0` < `0.1.2` < `0.2.0`；非數字段（`0.2.0rc1`）只取前面的數字。
fn version_key(v: &str) -> Vec<u64> {
    v.split(['.', '+', '-'])
        .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0))
        .collect()
}

/// 目錄裡挑一個 `aivc-*.whl`：版本＝App 版本的優先；`strict` 時沒有就 None，否則挑最新的。
/// dev 用 strict（版本不對就退回 `-e engine`，不會把舊 wheel 裝進去讓 hello 拒絕）；
/// 正式版不 strict（安裝檔只帶一個 wheel，且 build-engine-wheel.mjs 已驗過版本，這裡只是最後的保險）。
pub fn pick_wheel(dir: &Path, app_version: &str, strict: bool) -> Option<PathBuf> {
    let mut found: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            wheel_version(&name).filter(|_| p.is_file()).map(|v| (v, p))
        })
        .collect();
    let want = py_version(app_version);
    if let Some((_, p)) = found.iter().find(|(v, _)| py_version(v) == want) {
        return Some(p.clone());
    }
    if strict {
        return None;
    }
    found.sort_by(|a, b| version_key(&a.0).cmp(&version_key(&b.0)).then_with(|| a.1.cmp(&b.1)));
    found.pop().map(|(_, p)| p)
}

/// 內建的引擎 wheel：正式版 `<resource_dir>/resources/engine/`（tauri `bundle.resources`）；
/// dev 時 `resource_dir` 就是 `src-tauri`，同一條路徑指到 `scripts/build-engine-wheel.mjs` 放的地方（gitignore）。
/// 找不到就回 None → 引導腳本退回 `-e engine`（editable，開發期預設）。
pub fn find_engine_wheel(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let app_version = env!("CARGO_PKG_VERSION");
    let strict = cfg!(debug_assertions);
    if let Some(r) = resource_dir {
        if let Some(w) = pick_wheel(&r.join("resources").join("engine"), app_version, strict) {
            return Some(dunce::simplified(&w).to_path_buf());
        }
    }
    if cfg!(debug_assertions) {
        let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("engine");
        if let Some(w) = pick_wheel(&d, app_version, strict) {
            return Some(dunce::simplified(&w).to_path_buf());
        }
    }
    None
}

/// 閘門結果與 `.stamp` 合併成最終的 state / message / lock_ok / backend（純函式，規則在這裡測）：
/// - 閘門沒過 → `broken`（閘門原因最具體，優先講）；
/// - 閘門過了但上次 App 安裝失敗 / 沒跑完（`StampState::Failed`）→ **`broken`，絕不 `ready`**：
///   偵測只 import torch，doctor 閘門的其他項目（ffmpeg、cv2、依賴）有沒有過它看不到，失敗印記是唯一的證據；
/// - lock 變了 → `stale`；成功印記相符 → `ready`；沒有印記（手動 bootstrap）/ 找不到 lock → `ready` 並註明無法核對。
pub fn apply_gate_and_stamp(st: &mut PyEnvStatus, gate: Result<GateOk, String>, stamp: &StampState) {
    st.lock_ok = !matches!(stamp, StampState::Outdated | StampState::Failed { .. });
    let ok = match gate {
        Err(why) => {
            st.state = "broken".into();
            st.message = why;
            return;
        }
        Ok(ok) => ok,
    };
    st.backend = Some(ok.backend.to_string());
    match stamp {
        StampState::Failed { detail } => {
            st.state = "broken".into();
            st.message = format!(
                "{detail}：環境可能不完整，請重新安裝引擎（輸出記錄在 logs/bootstrap.log；若已用指令列 bootstrap 修好，刪除 pyenv/{STAMP_FILE} 後重新檢查）"
            );
        }
        StampState::Outdated => {
            st.state = "stale".into();
            st.message = "requirements.lock.txt 已變更，請重新安裝依賴".into();
        }
        StampState::Current => st.state = "ready".into(),
        StampState::Missing => {
            st.state = "ready".into();
            st.message = format!("（沒有 {STAMP_FILE}：不是 App 安裝的環境（手動 bootstrap 或自訂 python），無法核對 lock）");
        }
        StampState::Unverified => {
            st.state = "ready".into();
            st.message = format!("（找不到 {LOCK_FILE}，無法核對 lock）");
        }
    }
    if let Some(note) = ok.note {
        st.message = if st.message.is_empty() { note } else { format!("{note}；{}", st.message) };
    }
}

/// `detect_hardware` 會 spawn nvidia-smi（macOS 是 sysctl）並同步等它結束，nvidia-smi 冷啟動可能要好幾秒：
/// 直接在 async 的 `detect()` 裡呼叫會佔住 tokio worker 執行緒，期間排在同一條 worker 上的 command 與事件全部卡住。
/// 丟到 blocking 執行緒池；那邊 panic / 被取消時回預設值（「問不到」），和 spawn 失敗同一種結果。
pub async fn detect_hardware_async() -> Hardware {
    tokio::task::spawn_blocking(detect_hardware).await.unwrap_or_default()
}

/// 偵測目前狀態（跑 venv python 一次；timeout 90 s）。不會擲錯 —— 任何失敗都變成一個 `state`。
pub async fn detect(paths: &PyEnvPaths, override_: Option<&str>, lock_file: Option<&Path>) -> PyEnvStatus {
    let Some(py) = resolve_python(paths, override_) else {
        // 還沒裝：把 GPU 名先找出來，安裝面板的「硬體需求」才有東西講
        let gpu = detect_hardware_async().await.gpus.into_iter().next();
        return PyEnvStatus {
            state: "missing".into(),
            device: gpu.map(|g| format!("{} ({} MB)", g.name, g.vram_mb)),
            message: format!("尚未安裝引擎環境（{}）", paths.venv.display()),
            ..Default::default()
        };
    };
    let py_s = py.to_string_lossy().into_owned();
    let mut c = proc::cmd(&py_s);
    c.args(["-X", "utf8", "-c", DETECT_SCRIPT]).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let out = match tokio::time::timeout(DETECT_TIMEOUT, c.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return PyEnvStatus { state: "broken".into(), python: Some(py_s), message: format!("python 無法啟動：{e}"), ..Default::default() }
        }
        Err(_) => {
            return PyEnvStatus {
                state: "broken".into(),
                python: Some(py_s),
                message: format!("import torch 超過 {} 秒沒有回應", DETECT_TIMEOUT.as_secs()),
                ..Default::default()
            }
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let Some(info) = parse_detect_output(&stdout) else {
        let exc = stderr.lines().rev().find(|l| is_exception_line(l)).map(str::trim).unwrap_or("").to_string();
        let tail = if exc.is_empty() { stderr.lines().last().unwrap_or("").trim().to_string() } else { exc };
        return PyEnvStatus {
            state: "broken".into(),
            python: Some(py_s),
            message: if tail.is_empty() { "偵測腳本沒有輸出".into() } else { tail },
            ..Default::default()
        };
    };
    // 自訂 python（AIVC_PYTHON / 設定 python_override）不是受管 venv：受管 venv 上次安裝失敗的印記與它無關，不能拿來判它 broken
    let stamp = match stamp_state(&paths.venv, lock_file) {
        StampState::Failed { .. } if py != paths.python => StampState::Missing,
        s => s,
    };
    // MPS 沒有 get_device_name：用 sysctl 的晶片名（Apple M2 Pro…）補上，面板才不會顯示「未知裝置」
    let device = match (&info.device, info.mps) {
        (None, true) => detect_hardware_async().await.gpus.into_iter().next().map(|g| g.name),
        (d, _) => d.clone(),
    };
    let mut st = PyEnvStatus {
        state: String::new(),
        python: Some(py_s),
        torch: Some(info.torch.clone()),
        cuda: info.cuda,
        mps: info.mps,
        backend: None,
        device,
        arch: info.arch.clone(),
        lock_ok: true,
        message: String::new(),
    };
    apply_gate_and_stamp(&mut st, gate(&info, std::env::consts::OS, allow_cpu_from_env()), &stamp);
    st
}

// ---------------- 安裝 ----------------

/// 引導步驗（事件 `step` 的值）。順序就是 `scripts/bootstrap-engine.ps1` 的步驗。
pub const STEPS: [&str; 8] = ["base", "uv", "venv", "torch", "deps", "wheel", "gate", "models"];

/// 從 bootstrap 腳本的 `==> …` 行判斷進到哪一步（腳本是給人看的，這裡只認關鍵字）。
pub fn step_of_line(line: &str) -> Option<&'static str> {
    let l = line.trim().strip_prefix("==>")?.trim().to_ascii_lowercase();
    // venv 要先於 uv 判斷：「uv venv left Scripts empty -> fallback」那一行是 venv 步驗，不是 uv 步驗。
    // `ffmpeg: <路徑> <版本>`（bootstrap-engine.sh 下載前的預檢）歸 base，而且要最先判斷：路徑裡可能剛好有 venv / torch 字樣
    if l.starts_with("free space") || l.starts_with("ffmpeg") {
        Some("base")
    } else if l.contains("venv") {
        Some("venv")
    } else if l.contains("download uv") || l.starts_with("uv ") {
        Some("uv")
    } else if l.contains("torch") {
        Some("torch")
    } else if l.contains("requirements.lock") {
        Some("deps")
    } else if l.contains("install aivc") {
        Some("wheel")
    } else if l.starts_with("gate") {
        Some("gate")
    } else if l.contains("models") {
        Some("models")
    } else {
        None
    }
}

pub const BOOTSTRAP_SCRIPT_PS1: &str = "bootstrap-engine.ps1";
pub const BOOTSTRAP_SCRIPT_SH: &str = "bootstrap-engine.sh";

/// 這個 OS 用哪一支引導腳本：Windows 是 PowerShell 版；macOS / Linux 沒有 PowerShell（pwsh 不是預設安裝），用 POSIX shell 版。
pub fn bootstrap_script_name(os: &str) -> &'static str {
    if os == "windows" {
        BOOTSTRAP_SCRIPT_PS1
    } else {
        BOOTSTRAP_SCRIPT_SH
    }
}

/// 本機（編譯目標）的引導腳本檔名。
pub const BOOTSTRAP_SCRIPT: &str = if cfg!(windows) { BOOTSTRAP_SCRIPT_PS1 } else { BOOTSTRAP_SCRIPT_SH };
/// 覆寫引導腳本位置（離線環境 / 自己改過的腳本 / 測試）。
pub const ENV_BOOTSTRAP_SCRIPT: &str = "AIVC_BOOTSTRAP_SCRIPT";

fn existing_file(p: PathBuf) -> Option<PathBuf> {
    if p.is_file() {
        Some(dunce::canonicalize(&p).unwrap_or(p))
    } else {
        None
    }
}

/// 引導腳本解析順序（純函式，測得到；`name` 是 `bootstrap_script_name(os)`）：
/// 1. `env_override`（`AIVC_BOOTSTRAP_SCRIPT`）—— 指到的檔要存在才算，指錯就往下找，不會因為一個環境變數讓「安裝」按不下去；
///    檔名不限（自己改過的腳本叫什麼都行），但要和本機的直譯器相符（Windows 餵 PowerShell、其他餵 bash）；
/// 2. `<resource_dir>/resources/engine/<name>` —— 正式版：`build-engine-wheel.mjs` 把腳本連同 wheel、
///    兩份 requirements、`uv-manifest.json` 一起放進 `bundle.resources`，所以安裝檔在乾淨機器上也有腳本可跑
///    （macOS 的 resource_dir 是 `.app/Contents/Resources`、deb 是 `/usr/lib/<產品名>`，Tauri 會算好）；
/// 3. `<dev_scripts_dir>/<name>` —— repo 的 `scripts/`（只有在原始碼樹上跑才存在）。
pub fn resolve_bootstrap_script(
    name: &str,
    env_override: Option<&str>,
    resource_dir: Option<&Path>,
    dev_scripts_dir: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(p) = env_override.map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from) {
        if let Some(f) = existing_file(p) {
            return Some(f);
        }
    }
    if let Some(r) = resource_dir {
        if let Some(f) = existing_file(r.join("resources").join("engine").join(name)) {
            return Some(f);
        }
    }
    if let Some(d) = dev_scripts_dir {
        if let Some(f) = existing_file(d.join(name)) {
            return Some(f);
        }
    }
    None
}

/// 正式 / dev 都走這裡：env → 內建 resources → repo `scripts/`，檔名依本機 OS（`BOOTSTRAP_SCRIPT`）。
/// `CARGO_MANIFEST_DIR` 是編譯期路徑，使用者機器上不存在就自然跳過（不再用 debug_assertions 當閘門）。
pub fn bootstrap_script(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let env = std::env::var(ENV_BOOTSTRAP_SCRIPT).ok();
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("scripts");
    resolve_bootstrap_script(BOOTSTRAP_SCRIPT, env.as_deref(), resource_dir, Some(&dev))
}

/// 安裝時實際會執行的 argv —— 畫面上要先給人看過再按（`pyenv_install_command`）。本機 OS 版；形狀見 `install_command_for`。
pub fn install_command(script: &Path, root: &Path, with_models: bool, wheel: Option<&Path>) -> Vec<String> {
    install_command_for(std::env::consts::OS, script, root, with_models, wheel)
}

/// 依 OS 組安裝 argv（純函式：兩種形狀在任何主機上都測得到）。
///
/// - Windows：`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <ps1> -DataRoot <root> [-Wheel <whl>] [-WithModels]`。
///   使用者的 profile / 執行原則 / 任何提示都不能擋住或卡住它（腳本本身沒有互動；卡住＝安裝面板永遠 99%）。
/// - macOS / Linux：`bash <sh> --data-root <root> [--wheel <whl>] [--with-models]`。
///   以直譯器執行而不是直接 exec 腳本：`bundle.resources` 複製進 .app / deb / AppImage 時不保證保留執行權限，
///   exec 會 EACCES；而 bash 在 macOS（/bin/bash）與各發行版桌面環境都一定有，腳本寫成 POSIX sh 時 bash 也照跑。
///   旗標名與 `scripts/bootstrap-engine.sh` 的參數解析一致（`--skip-torch` App 不帶，只給手動 CLI 用）。
///
/// `wheel`：內建的 `aivc-*.whl`（腳本以 `--no-deps --reinstall` 裝它）；None 就是開發期的 `-e engine`。
/// 路徑都是單一 argv 元素、不經 shell 拆字：macOS 的 `Application Support`、使用者名稱含空白都安全。
pub fn install_command_for(os: &str, script: &Path, root: &Path, with_models: bool, wheel: Option<&Path>) -> Vec<String> {
    let windows = os == "windows";
    let mut v: Vec<String> = if windows {
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"].iter().map(|s| s.to_string()).collect()
    } else {
        vec!["bash".to_string()]
    };
    let (data_root, wheel_flag, models_flag) =
        if windows { ("-DataRoot", "-Wheel", "-WithModels") } else { ("--data-root", "--wheel", "--with-models") };
    v.push(script.to_string_lossy().into_owned());
    v.push(data_root.into());
    v.push(root.to_string_lossy().into_owned());
    if let Some(w) = wheel {
        v.push(wheel_flag.into());
        v.push(w.to_string_lossy().into_owned());
    }
    if with_models {
        v.push(models_flag.into());
    }
    v
}

/// 安裝子程序的額外環境變數（純函式）。
///
/// - `AIVC_DATA_ROOT`：腳本裡的 `aivc doctor` / 模型下載是在引擎外跑的 python，不設的話引擎 `env.data_root()` 退回預設根，
///   使用者把資料根搬到別的磁碟（`engine.data_root`）時 HF 快取仍寫回系統碟；
/// - `HF_HOME` / `TORCH_HOME` / `HF_HUB_DISABLE_TELEMETRY`：和 `engine_env` 同一套，安裝時抓的模型就是引擎之後讀的那一份；
/// - `AIVC_FFMPEG_DIR`（App 解析得到 ffmpeg 時）：doctor 閘門要找得到 ffmpeg。macOS 從 Finder 開的 App 的 PATH
///   沒有 `/opt/homebrew/bin`，不帶這個的話 `brew install ffmpeg` 過的機器也會在閘門那一步失敗。
pub fn install_env(paths: &PyEnvPaths, ffmpeg_dir: Option<&Path>) -> Vec<(String, String)> {
    let mut v = vec![
        ("AIVC_DATA_ROOT".to_string(), paths.root.to_string_lossy().into_owned()),
        ("HF_HOME".to_string(), paths.models_hf.to_string_lossy().into_owned()),
        ("TORCH_HOME".to_string(), paths.models_torch.to_string_lossy().into_owned()),
        ("HF_HUB_DISABLE_TELEMETRY".to_string(), "1".to_string()),
    ];
    if let Some(d) = ffmpeg_dir {
        v.push(("AIVC_FFMPEG_DIR".to_string(), d.to_string_lossy().into_owned()));
    }
    v
}

#[derive(Serialize, Clone)]
struct InstallEvent {
    job_id: String,
    /// "step" | "line" | "done"
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

pub const INSTALL_EVENT: &str = "pyenv-install";
pub const STATUS_EVENT: &str = "pyenv-status";

fn emit(app: &AppHandle, job_id: &str, kind: &str, step: Option<&str>, line: Option<String>, ok: Option<bool>, code: Option<i32>) {
    let _ = app.emit(
        INSTALL_EVENT,
        InstallEvent {
            job_id: job_id.to_string(),
            kind: kind.to_string(),
            step: step.map(|s| s.to_string()),
            line,
            ok,
            code,
        },
    );
}

pub fn emit_status(app: &AppHandle, st: &PyEnvStatus) {
    let _ = app.emit(STATUS_EVENT, st);
}

/// 讀一行（到 `\n` 或 EOF）並解碼成字串；EOF 回 None。行尾的 `\r` / `\n` 去掉。
/// 位元組不是合法 UTF-8 時不回錯、不丟行（見 `decode_console_bytes`）。
pub async fn next_lossy_line<R: AsyncBufRead + Unpin>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<Option<String>> {
    buf.clear();
    if reader.read_until(b'\n', buf).await? == 0 {
        return Ok(None);
    }
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    Ok(Some(decode_console_bytes(buf)))
}

/// 子程序輸出的一行 → 字串：合法 UTF-8 原樣；否則（Windows）以 ANSI 代碼頁解碼（zh-TW 是 cp950，
/// PowerShell 5.1 寫進管線的就是它）；再不行就 `from_utf8_lossy`（壞字元變 U+FFFD，但這一行一定留下來）。
pub fn decode_console_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => decode_ansi(bytes).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned()),
    }
}

#[cfg(windows)]
mod win_cp {
    // 直接呼叫 kernel32（std 本來就連結它）：只為了解碼一行錯誤訊息，不值得多拉 encoding_rs / windows-sys 相依。
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(code_page: u32, flags: u32, src: *const u8, src_len: i32, dst: *mut u16, dst_len: i32) -> i32;
        #[cfg(test)]
        fn GetACP() -> u32;
    }
    const CP_ACP: u32 = 0;

    /// 測試用：只有 zh-TW（950）機器才驗「解回中文」，其他代碼頁只驗「不丟行」。
    #[cfg(test)]
    pub fn ansi_code_page() -> u32 {
        // SAFETY: 無參數、無副作用的查詢。
        unsafe { GetACP() }
    }

    pub fn decode(bytes: &[u8]) -> Option<String> {
        let len = i32::try_from(bytes.len()).ok().filter(|n| *n > 0)?;
        // SAFETY: src 指向 len 個有效位元組；第一次 dst 為 null / 0 只查需要的 UTF-16 長度。
        let need = unsafe { MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
        if need <= 0 {
            return None;
        }
        let mut wide = vec![0u16; need as usize];
        // SAFETY: dst 是剛配置的 need 個 u16；API 最多寫 need 個。
        let got = unsafe { MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), len, wide.as_mut_ptr(), need) };
        if got <= 0 {
            return None;
        }
        wide.truncate(got as usize);
        Some(String::from_utf16_lossy(&wide))
    }
}

#[cfg(windows)]
fn decode_ansi(bytes: &[u8]) -> Option<String> {
    win_cp::decode(bytes)
}

#[cfg(not(windows))]
fn decode_ansi(_bytes: &[u8]) -> Option<String> {
    None
}

/// 跑一個子行程，把 stdout / stderr 逐行送到前端（`==>` 行同時發 `step`）；回傳結束碼。
/// 同時把每一行附掛到 `logs/bootstrap.log`，出事時有東西可看。
async fn run_streaming(app: &AppHandle, job_id: &str, argv: &[String], env: &[(String, String)], log_path: &Path) -> AppResult<Option<i32>> {
    let (prog, rest) = argv.split_first().ok_or_else(|| AppError::Invalid("argv 為空".into()))?;
    let mut cmd = proc::cmd(prog);
    cmd.args(rest).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| AppError::PyEnv(format!("啟動 {prog} 失敗：{e}")))?;

    let log: std::sync::Arc<parking_lot::Mutex<Option<std::fs::File>>> = std::sync::Arc::new(parking_lot::Mutex::new(
        std::fs::OpenOptions::new().create(true).append(true).open(log_path).ok(),
    ));
    let mut tasks = Vec::new();
    // stdout 與 stderr 都要收：uv / pip 把警告與錯誤寫在 stderr，只讀 stdout 會漏掉失敗原因；
    // 而且沒人讀的管線一滿（Windows 64 KB）子程序就卡死。
    for (stream, is_err) in [(child.stdout.take().map(tokio_util::either::Either::Left), false), (child.stderr.take().map(tokio_util::either::Either::Right), true)] {
        let Some(stream) = stream else { continue };
        let (a, j, log) = (app.clone(), job_id.to_string(), log.clone());
        tasks.push(tokio::spawn(async move {
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            loop {
                // 不能用 `lines()`：PowerShell 5.1 把錯誤（中文 throw 原因）以 ANSI 代碼頁（cp950）寫進管線，
                // `next_line` 遇到非 UTF-8 回 InvalidData 且**吃掉那一行**，安裝面板與 bootstrap.log 都看不到失敗原因。
                // 改讀原始位元組再解碼（UTF-8 → ANSI 代碼頁 → lossy），一行都不丟。
                let l = match next_lossy_line(&mut reader, &mut buf).await {
                    Ok(Some(l)) => l,
                    Ok(None) => break,
                    // 真正的 IO 錯誤（管線壞了）：read_until 不會再有進展，continue 只會空轉
                    Err(_) => break,
                };
                if let Some(f) = log.lock().as_mut() {
                    use std::io::Write;
                    let _ = writeln!(f, "{} {}{}", chrono::Local::now().format("%H:%M:%S"), if is_err { "! " } else { "" }, l);
                }
                if !is_err {
                    if let Some(step) = step_of_line(&l) {
                        emit(&a, &j, "step", Some(step), None, None, None);
                    }
                }
                emit(&a, &j, "line", None, Some(l), None, None);
            }
        }));
    }
    let status = child.wait().await.map_err(|e| AppError::PyEnv(format!("執行失敗：{e}")))?;
    for t in tasks {
        let _ = t.await;
    }
    Ok(status.code())
}

/// 行程內唯一的「安裝進行中」旗標。
/// 不能只看 `AppState.pyenv.state == "installing"`：`pyenv_status`（「重新檢查」按鈕）與啟動偵測會在安裝途中
/// 把它改寫成 broken（venv 已建、torch 還沒裝），SetupBanner 又冒出「安裝引擎」→ 第二支 bootstrap 同時改同一個 venv。
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// 持有期間旗標為 true；drop（含安裝途中出錯提早 return / panic 展開）時放掉。
pub struct FlagGuard<'a>(&'a AtomicBool);

impl Drop for FlagGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 原子地 false → true；已經是 true（別人持有）回 None。
pub fn try_acquire(flag: &AtomicBool) -> Option<FlagGuard<'_>> {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| FlagGuard(flag))
}

/// `pyenv_install` 入口用：拿不到就代表已有一支安裝在跑。
pub fn try_begin_install() -> Option<FlagGuard<'static>> {
    try_acquire(&INSTALLING)
}

pub fn install_in_progress() -> bool {
    INSTALLING.load(Ordering::SeqCst)
}

/// 一鍵安裝：跑引導腳本（`bootstrap_script()` 解析到的那一份：Windows 是 .ps1、macOS / Linux 是 .sh）串流輸出；
/// 開始時把 `.stamp` 換成 `installing`、結束時依成敗寫 hash 或 `failed …`（`record_install_outcome`），
/// 再重新偵測並發 `pyenv-status`。`wheel` 有值就裝內建 wheel（`find_engine_wheel`），沒有就 editable。
/// `ffmpeg_dir`：App 已解析到的 ffmpeg 目錄，交給腳本裡的 doctor 閘門（見 `install_env`）。
#[allow(clippy::too_many_arguments)]
pub async fn install(
    app: AppHandle,
    job_id: String,
    paths: PyEnvPaths,
    lock_file: Option<PathBuf>,
    with_models: bool,
    wheel: Option<PathBuf>,
    script: PathBuf,
    ffmpeg_dir: Option<PathBuf>,
) -> AppResult<bool> {
    if !script.is_file() {
        return Err(AppError::PyEnv(format!("引導腳本不存在：{}", script.display())));
    }
    std::fs::create_dir_all(&paths.logs)?;
    let argv = install_command(&script, &paths.root, with_models, wheel.as_deref());
    let env = install_env(&paths, ffmpeg_dir.as_deref());
    emit(&app, &job_id, "step", Some("base"), None, None, None);
    emit_status(&app, &PyEnvStatus { state: "installing".into(), message: "安裝中".into(), ..Default::default() });
    if let Err(e) = mark_install_started(&paths.venv) {
        emit(&app, &job_id, "line", None, Some(format!("寫入 {STAMP_FILE} 失敗：{e}")), None, None);
    }
    let code = match run_streaming(&app, &job_id, &argv, &env, &paths.logs.join("bootstrap.log")).await {
        Ok(code) => code,
        Err(e) => {
            // 腳本根本沒跑起來也是一次失敗的安裝：不能留著剛寫的 installing（訊息會誤導成「被關閉」）
            let _ = record_install_outcome(&paths.venv, lock_file.as_deref(), None);
            return Err(e);
        }
    };
    let ok = code == Some(0);
    if let Err(e) = record_install_outcome(&paths.venv, lock_file.as_deref(), code) {
        emit(&app, &job_id, "line", None, Some(format!("寫入 {STAMP_FILE} 失敗：{e}")), None, None);
    }
    emit(&app, &job_id, "done", None, None, Some(ok), code);
    let st = detect(&paths, None, lock_file.as_deref()).await;
    emit_status(&app, &st);
    Ok(ok)
}

// ---------------- 引擎環境變數 ----------------

/// 引擎子程序的環境：模型快取進 App 資料目錄（解除安裝找得到）、關 HF 遙測、UTF-8、CUDA lazy loading、
/// 資料根 / 快取目錄 / ffmpeg 目錄交給引擎（`AIVC_FFMPEG_DIR` → resources → PATH 的解析順序在 Python `env.py`）。
pub fn engine_env(paths: &PyEnvPaths, ffmpeg_dir: Option<&Path>, cache_dir: &Path) -> Vec<(String, String)> {
    let mut v = vec![
        ("HF_HOME".to_string(), paths.models_hf.to_string_lossy().into_owned()),
        ("TORCH_HOME".to_string(), paths.models_torch.to_string_lossy().into_owned()),
        ("HF_HUB_DISABLE_TELEMETRY".to_string(), "1".to_string()),
        ("PYTHONUTF8".to_string(), "1".to_string()),
        ("CUDA_MODULE_LOADING".to_string(), "LAZY".to_string()),
        ("AIVC_DATA_ROOT".to_string(), paths.root.to_string_lossy().into_owned()),
        ("AIVC_CACHE_DIR".to_string(), cache_dir.to_string_lossy().into_owned()),
    ];
    if let Some(d) = ffmpeg_dir {
        v.push(("AIVC_FFMPEG_DIR".to_string(), d.to_string_lossy().into_owned()));
    }
    v
}

// ---------------- 從 local_asr.rs 原封搬來 ----------------

/// 這一行看起來是不是 Python 的例外（traceback 的最後一行）。
///
/// 形狀是 `SomeError: 說明` —— 開頭不縮排、冒號前是一個結尾為 Error / Exception 的識別字。
/// 縮排的是呼叫堆疊，`Traceback (most recent call last):` 也不算（冒號後面是空的）。
pub fn is_exception_line(line: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    let Some((head, rest)) = line.split_once(':') else { return false };
    if rest.trim().is_empty() {
        return false;
    }
    // `torch.cuda.OutOfMemoryError` 這種帶模組前綴的也要認得
    let name = head.rsplit('.').next().unwrap_or(head);
    (name.ends_with("Error") || name.ends_with("Exception"))
        && name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 這台機器的顯示卡與顯存。
///
/// Windows / Linux **只問 nvidia-smi**：引擎走 CUDA，AMD / Intel 的卡它用不到，報出來只會讓人以為跑得動。
/// 問不到就是 `nvidia = false`，UI 要講的是「找不到 NVIDIA 驅動」，而不是「你沒有顯示卡」。
/// macOS 不跑 nvidia-smi（不存在，每次偵測都白 spawn 一次），改問 sysctl：Apple Silicon 的 GPU 用統一記憶體，
/// `vram_mb` 填的是整機記憶體（MPS 能用的上限就是它）；Intel Mac 回空（引擎不支援）。
#[derive(Serialize, Clone, Default)]
pub struct Hardware {
    pub nvidia: bool,
    /// Apple Silicon（MPS 後端）；只有 macOS 會是 true。
    pub apple_silicon: bool,
    pub gpus: Vec<GpuInfo>,
}

#[derive(Serialize, Clone)]
pub struct GpuInfo {
    pub name: String,
    pub vram_mb: u32,
}

/// 解析 `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` 的輸出。
/// 抽出來才測得到 —— CI 與開發機不一定有 NVIDIA 卡。
pub fn parse_nvidia_smi(out: &str) -> Vec<GpuInfo> {
    out.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            // 顯示卡名字本身不會有逗號，但保險起見用**最後一個**逗號切
            let idx = line.rfind(',')?;
            let name = line[..idx].trim();
            let mb: u32 = line[idx + 1..].trim().parse().ok()?;
            if name.is_empty() || mb == 0 {
                return None;
            }
            Some(GpuInfo { name: name.to_string(), vram_mb: mb })
        })
        .collect()
}

/// `sysctl -n machdep.cpu.brand_string` 與 `sysctl -n hw.memsize` 的輸出 → Apple Silicon 的 GpuInfo。
/// 抽出來才測得到（CI 的 Windows / Linux runner 沒有 sysctl 這兩個鍵）。
/// 晶片名不是 `Apple …`（Intel Mac）→ None：PyPI 沒有 x86_64 macOS 的 torch 2.14，引擎跑不起來，不能讓面板看起來像支援。
pub fn parse_apple_silicon(brand: &str, memsize: &str) -> Option<GpuInfo> {
    let brand = brand.trim();
    if !brand.starts_with("Apple") {
        return None;
    }
    let bytes: u64 = memsize.trim().parse().ok()?;
    let mb = u32::try_from(bytes / (1024 * 1024)).ok().filter(|mb| *mb > 0)?;
    Some(GpuInfo { name: format!("{brand} (MPS)"), vram_mb: mb })
}

#[cfg(target_os = "macos")]
pub fn detect_hardware() -> Hardware {
    // 絕對路徑：從 Finder 開的 App PATH 雖然有 /usr/sbin，但不值得賭使用者環境
    let sysctl = |key: &str| {
        std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", key])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let (Some(brand), Some(mem)) = (sysctl("machdep.cpu.brand_string"), sysctl("hw.memsize")) else {
        return Hardware::default();
    };
    match parse_apple_silicon(&brand, &mem) {
        Some(g) => Hardware { nvidia: false, apple_silicon: true, gpus: vec![g] },
        None => Hardware::default(),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn detect_hardware() -> Hardware {
    let mut c = std::process::Command::new("nvidia-smi");
    c.args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(proc::CREATE_NO_WINDOW);
    }
    // Linux：沒裝驅動就沒有 nvidia-smi → spawn 失敗 → 同「問不到」
    match c.output() {
        Ok(o) if o.status.success() => {
            let gpus = parse_nvidia_smi(&String::from_utf8_lossy(&o.stdout));
            Hardware { nvidia: !gpus.is_empty(), apple_silicon: false, gpus }
        }
        _ => Hardware::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(v: &str, cuda: bool, cc: Option<&str>, arch: &[&str]) -> DetectInfo {
        DetectInfo {
            torch: v.into(),
            cuda,
            mps: false,
            device: Some("RTX 5090".into()),
            cc: cc.map(str::to_string),
            arch: arch.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn mac(v: &str, mps: bool) -> DetectInfo {
        DetectInfo { torch: v.into(), cuda: false, mps, device: None, cc: None, arch: vec![] }
    }

    #[test]
    fn gate_passes_only_cu130_with_cuda_and_matching_arch() {
        // Windows 與 Linux 同一套規則（Linux 也裝 cu130 index 的 wheel）
        for os in ["windows", "linux"] {
            let ok = gate(&info("2.14.0+cu130", true, Some("120"), &["sm_90", "sm_100", "sm_120"]), os, false).unwrap();
            assert_eq!(ok, GateOk { backend: "cuda", note: None });
            // PATH 上的 CPU torch：這就是頭號風險，訊息要點名 +cu130
            let e = gate(&info("2.14.0+cpu", true, Some("120"), &["sm_120"]), os, false).unwrap_err();
            assert!(e.contains("+cu130"), "{e}");
            let e = gate(&info("2.14.0+cpu", false, None, &[]), os, false).unwrap_err();
            assert!(e.contains("+cu130"), "{e}");
            // cu128 沒有 sm_120 SASS
            assert!(gate(&info("2.11.0+cu128", true, Some("120"), &["sm_90"]), os, false).is_err());
            assert!(gate(&info("2.14.0+cu130", false, None, &[]), os, false).unwrap_err().contains("is_available"));
            let e = gate(&info("2.14.0+cu130", true, Some("121"), &["sm_120"]), os, false).unwrap_err();
            assert!(e.contains("sm_121"), "{e}");
            // 就算機器上 torch 回報 MPS（不可能，但偵測輸出是外部資料）也不能讓 Windows / Linux 跳過 CUDA 閘門
            let mut weird = info("2.14.0+cpu", false, None, &[]);
            weird.mps = true;
            assert!(gate(&weird, os, false).is_err());
        }
    }

    #[test]
    fn gate_on_macos_requires_mps() {
        // PyPI 的 macOS torch 沒有 +cu130 後綴：看 MPS
        assert_eq!(gate(&mac("2.14.0", true), "macos", false).unwrap(), GateOk { backend: "mps", note: None });
        let e = gate(&mac("2.14.0", false), "macos", false).unwrap_err();
        assert!(e.contains("mps") && e.contains("Apple Silicon"), "{e}");
        // 同一份 macOS 偵測結果拿到 Windows 規則下一定不過（+cu130 規則沒有被 macOS 分支偷偷放寬）
        assert!(gate(&mac("2.14.0", true), "windows", false).is_err());
    }

    #[test]
    fn allow_cpu_only_rescues_the_no_gpu_case() {
        // 沒有 GPU 後端 + AIVC_ALLOW_CPU=1 → 放行成 cpu，訊息要講清楚
        for (i, os) in [(info("2.14.0+cpu", false, None, &[]), "linux"), (info("2.14.0+cu130", false, None, &[]), "windows"), (mac("2.14.0", false), "macos")] {
            let ok = gate(&i, os, true).unwrap();
            assert_eq!(ok.backend, "cpu", "{os}");
            let note = ok.note.unwrap();
            assert!(note.contains(ENV_ALLOW_CPU) && note.contains("CPU"), "{note}");
        }
        // CUDA 可用但版本 / arch 不對：放行只會讓第一個 kernel 炸在更難懂的地方 → 照樣拒絕
        assert!(gate(&info("2.11.0+cu128", true, Some("120"), &["sm_90"]), "windows", true).is_err());
        assert!(gate(&info("2.14.0+cu130", true, Some("121"), &["sm_120"]), "linux", true).is_err());
        // GPU 可用時 allow_cpu 不影響後端選擇
        assert_eq!(gate(&info("2.14.0+cu130", true, Some("120"), &["sm_120"]), "linux", true).unwrap().backend, "cuda");
        assert_eq!(gate(&mac("2.14.0", true), "macos", true).unwrap().backend, "mps");
        // 只認 1
        assert!(allow_cpu_value(Some("1")));
        for v in [None, Some(""), Some("0"), Some(" 1 "), Some("true"), Some("yes")] {
            assert!(!allow_cpu_value(v), "{v:?}");
        }
    }

    #[test]
    fn parses_detect_output_and_skips_warnings() {
        let out = "UserWarning: something noisy\n{\"v\": \"2.14.0+cu130\", \"cuda\": true, \"mps\": false, \"name\": \"NVIDIA GeForce RTX 5090\", \"cc\": \"120\", \"arch\": [\"sm_90\", \"sm_120\"]}\n";
        let i = parse_detect_output(out).unwrap();
        assert_eq!(i.torch, "2.14.0+cu130");
        assert!(i.cuda && !i.mps);
        assert_eq!(i.cc.as_deref(), Some("120"));
        assert_eq!(i.arch, vec!["sm_90", "sm_120"]);
        assert!(parse_detect_output("Traceback...\nModuleNotFoundError: No module named 'torch'\n").is_none());
        // 舊版偵測輸出沒有 mps 鍵 → false
        let cpu = parse_detect_output("{\"v\":\"2.14.0+cpu\",\"cuda\":false,\"name\":null,\"cc\":null,\"arch\":[]}").unwrap();
        assert!(!cpu.cuda && !cpu.mps && cpu.cc.is_none() && cpu.device.is_none());
        // macOS（Apple Silicon）
        let m = parse_detect_output("{\"v\":\"2.14.0\",\"cuda\":false,\"mps\":true,\"name\":null,\"cc\":null,\"arch\":[]}").unwrap();
        assert!(m.mps && !m.cuda);
        assert_eq!(gate(&m, "macos", false).unwrap().backend, "mps");
    }

    #[test]
    fn detect_script_is_one_python_c_argument_that_prints_json() {
        // 進 `-c` 的字串：不能有 Windows 換行、要印 json、要有六個鍵
        assert!(!DETECT_SCRIPT.contains('\r'));
        for k in ["'v'", "'cuda'", "'mps'", "'name'", "'cc'", "'arch'"] {
            assert!(DETECT_SCRIPT.contains(k), "{k}");
        }
        assert!(DETECT_SCRIPT.contains("json.dumps"));
        assert!(DETECT_SCRIPT.contains("getattr(torch.backends,'mps',None)"), "沒有 mps 模組的 torch 不能讓偵測腳本丟例外");
        assert!(!DETECT_SCRIPT.contains("transformers"), "偵測不 import transformers（太慢）");
    }

    #[test]
    fn venv_python_path_depends_on_os() {
        let venv = Path::new("data").join("pyenv");
        assert_eq!(venv_python_for(&venv, "windows"), venv.join("Scripts").join("python.exe"));
        assert_eq!(venv_python_for(&venv, "linux"), venv.join("bin").join("python"));
        assert_eq!(venv_python_for(&venv, "macos"), venv.join("bin").join("python"));
        // 本機的 paths_under 用的就是本機 OS 那一種
        assert_eq!(paths_under(Path::new("data")).python, venv_python_for(&venv, std::env::consts::OS));
    }

    #[test]
    fn paths_follow_the_planned_layout() {
        let p = paths_under(Path::new("D:\\aivc-data"));
        assert_eq!(p.venv, Path::new("D:\\aivc-data").join("pyenv"));
        if cfg!(windows) {
            assert!(p.python.ends_with(Path::new("pyenv").join("Scripts").join("python.exe")));
        } else {
            assert!(p.python.ends_with(Path::new("pyenv").join("bin").join("python")));
        }
        assert!(p.models_hf.ends_with(Path::new("models").join("hf")));
        assert!(p.models_torch.ends_with(Path::new("models").join("torch")));
        assert!(p.tools_uv.ends_with(Path::new("tools").join("uv")));
        assert!(p.logs.ends_with("logs"));
    }

    #[test]
    fn py_version_maps_semver_prereleases_to_pep440() {
        for (semver, pep) in [
            ("0.0.8", "0.0.8"),
            ("0.0.8-beta.1", "0.0.8b1"),
            ("0.0.8-beta", "0.0.8b0"),
            ("0.1.0-alpha.2", "0.1.0a2"),
            ("1.0.0-rc.3", "1.0.0rc3"),
            ("1.0.0-RC.3", "1.0.0rc3"),
            ("0.0.8b1", "0.0.8b1"),
        ] {
            assert_eq!(py_version(semver), pep, "{semver}");
            assert_eq!(py_version(&py_version(semver)), pep, "冪等：{semver}");
        }
        assert_eq!(py_version("0.0.8-foo.1"), "0.0.8-foo.1", "認不得的後綴原樣回");
        // 預先發布版：App 是 0.0.8-beta.1，wheel 檔名是 0.0.8b1
        let dir = std::env::temp_dir().join(format!("aivc wheel pep440-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("aivc-0.0.7-py3-none-any.whl"), b"a").unwrap();
        std::fs::write(dir.join("aivc-0.0.8b1-py3-none-any.whl"), b"b").unwrap();
        assert!(pick_wheel(&dir, "0.0.8-beta.1", true).unwrap().ends_with("aivc-0.0.8b1-py3-none-any.whl"));
        assert_eq!(pick_wheel(&dir, "0.0.8-beta.2", true), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wheel_lookup_prefers_app_version_and_is_strict_in_dev() {
        assert_eq!(wheel_version("aivc-0.0.4-py3-none-any.whl").as_deref(), Some("0.0.4"));
        assert_eq!(wheel_version("aivc-0.1.0rc1-py3-none-any.whl").as_deref(), Some("0.1.0rc1"));
        assert_eq!(wheel_version("numpy-2.4.6-cp312-cp312-win_amd64.whl"), None, "別家的 wheel 不算");
        assert_eq!(wheel_version("aivc-py3-none-any.whl"), None);
        assert_eq!(wheel_version("aivc-0.0.4.tar.gz"), None);

        let dir = std::env::temp_dir().join(format!("aivc wheel 測試-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(pick_wheel(&dir, "0.0.4", false), None, "空目錄");
        std::fs::write(dir.join("aivc-0.0.3-py3-none-any.whl"), b"a").unwrap();
        std::fs::write(dir.join("aivc-0.0.10-py3-none-any.whl"), b"b").unwrap();
        std::fs::write(dir.join("aivc-0.0.4-py3-none-any.whl"), b"c").unwrap();
        std::fs::write(dir.join("README.txt"), b"x").unwrap();
        // 版本＝App 版本優先
        assert!(pick_wheel(&dir, "0.0.4", true).unwrap().ends_with("aivc-0.0.4-py3-none-any.whl"));
        // 沒有相同版本：strict → None（dev 退回 editable）；非 strict → 最新（數字比較，0.0.10 > 0.0.3）
        assert_eq!(pick_wheel(&dir, "0.0.5", true), None);
        assert!(pick_wheel(&dir, "0.0.5", false).unwrap().ends_with("aivc-0.0.10-py3-none-any.whl"));
        // find_engine_wheel 走 <resource_dir>/resources/engine
        let rd = dir.join("res");
        std::fs::create_dir_all(rd.join("resources").join("engine")).unwrap();
        std::fs::write(rd.join("resources").join("engine").join(format!("aivc-{}-py3-none-any.whl", env!("CARGO_PKG_VERSION"))), b"w").unwrap();
        let w = find_engine_wheel(Some(&rd)).expect("內建 wheel");
        assert!(w.starts_with(&rd) && !w.to_string_lossy().starts_with("\\\\?\\"));
        assert_eq!(find_engine_wheel(Some(&dir.join("nowhere"))).is_some(), find_engine_wheel(None).is_some(), "沒有內建 → 只剩 dev 目錄那條路");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_python_never_falls_back_to_path() {
        let dir = std::env::temp_dir().join(format!("aivc-pyenv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = paths_under(&dir);
        // 沒有 venv、沒有 override → None（不是 PATH 上的 python）
        assert_eq!(resolve_python(&p, None), None);
        // override 指到不存在的檔 → None（不是靜靜退回 venv）
        assert_eq!(resolve_python(&p, Some(dir.join("nope.exe").to_str().unwrap())), None);
        // venv 有 python → 用它
        std::fs::create_dir_all(p.python.parent().unwrap()).unwrap();
        std::fs::write(&p.python, b"").unwrap();
        assert_eq!(resolve_python(&p, None), Some(p.python.clone()));
        // override 存在 → 優先
        let ov = dir.join("other.exe");
        std::fs::write(&ov, b"").unwrap();
        assert_eq!(resolve_python(&p, Some(ov.to_str().unwrap())), Some(ov.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stamp_tracks_the_lock_file() {
        let dir = std::env::temp_dir().join(format!("aivc-stamp-{}", uuid::Uuid::new_v4()));
        let venv = dir.join("pyenv");
        std::fs::create_dir_all(&venv).unwrap();
        let lock = dir.join(LOCK_FILE);
        std::fs::write(&lock, b"numpy==2.4.6\n").unwrap();
        assert_eq!(stamp_state(&venv, Some(&lock)), StampState::Missing, "沒 stamp = 手動 bootstrap，不知道");
        write_stamp(&venv, &lock).unwrap();
        assert_eq!(stamp_state(&venv, Some(&lock)), StampState::Current);
        assert_eq!(stamp_state(&venv, None), StampState::Unverified, "有成功印記但沒有 lock 可比");
        std::fs::write(&lock, b"numpy==2.5.0\n").unwrap();
        assert_eq!(stamp_state(&venv, Some(&lock)), StampState::Outdated);
        // 看不懂的內容：保守地要求重裝，不當成沒問題
        std::fs::write(venv.join(STAMP_FILE), "garbage").unwrap();
        assert_eq!(stamp_state(&venv, Some(&lock)), StampState::Outdated);
        // sha256 是標準值（PowerShell Get-FileHash 也算得出來）
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn status_after(gate_result: Result<GateOk, String>, stamp: &StampState) -> PyEnvStatus {
        let mut st = PyEnvStatus { lock_ok: true, ..Default::default() };
        apply_gate_and_stamp(&mut st, gate_result, stamp);
        st
    }

    /// 規則：上次 App 安裝失敗（含 doctor 閘門沒過，例如 macOS / Linux 缺 ffmpeg）或沒跑完，就算 torch 閘門過了也絕不回報 ready。
    #[test]
    fn failed_or_interrupted_install_is_never_ready() {
        let dir = std::env::temp_dir().join(format!("aivc stamp 失敗-{}", uuid::Uuid::new_v4()));
        let venv = dir.join("pyenv");
        std::fs::create_dir_all(&venv).unwrap();
        let lock = dir.join(LOCK_FILE);
        std::fs::write(&lock, b"numpy==2.4.6\n").unwrap();
        let cuda_ok = || Ok(GateOk { backend: "cuda", note: None });

        // 第一次安裝成功 → ready
        record_install_outcome(&venv, Some(&lock), Some(0)).unwrap();
        assert_eq!(stamp_state(&venv, Some(&lock)), StampState::Current);
        let st = status_after(cuda_ok(), &stamp_state(&venv, Some(&lock)));
        assert_eq!((st.state.as_str(), st.lock_ok, st.message.as_str()), ("ready", true, ""));

        // 重裝開始：舊的成功 hash 必須先被換掉 —— 途中 App 被關掉，下次開啟不能是 ready
        mark_install_started(&venv).unwrap();
        assert_eq!(std::fs::read_to_string(venv.join(STAMP_FILE)).unwrap(), STAMP_INSTALLING);
        let st = status_after(cuda_ok(), &stamp_state(&venv, Some(&lock)));
        assert_eq!(st.state, "broken");
        assert!(st.message.contains("沒有跑完") && st.message.contains("重新安裝"), "{}", st.message);
        assert!(!st.lock_ok);
        assert_eq!(st.backend.as_deref(), Some("cuda"), "閘門本身有過，後端照實填");

        // 腳本失敗（例如 doctor 閘門：缺 ffmpeg）→ failed 印記 → broken，訊息帶結束碼
        record_install_outcome(&venv, Some(&lock), Some(1)).unwrap();
        assert_eq!(std::fs::read_to_string(venv.join(STAMP_FILE)).unwrap(), "failed exit 1");
        let stamp = stamp_state(&venv, Some(&lock));
        assert!(matches!(&stamp, StampState::Failed { detail } if detail.contains("exit 1")), "{stamp:?}");
        let st = status_after(cuda_ok(), &stamp);
        assert_eq!(st.state, "broken");
        assert!(st.message.contains("上次安裝失敗（exit 1）") && st.message.contains("bootstrap.log"), "{}", st.message);
        // CPU 放行（AIVC_ALLOW_CPU=1）也救不了失敗的安裝
        let st = status_after(Ok(GateOk { backend: "cpu", note: Some("CPU 很慢".into()) }), &stamp);
        assert_eq!(st.state, "broken");
        assert!(st.message.starts_with("CPU 很慢；"), "{}", st.message);
        // 閘門本身沒過：閘門原因優先（最具體）
        let st = status_after(Err("torch 是 2.14.0+cpu".into()), &stamp);
        assert_eq!((st.state.as_str(), st.message.as_str(), st.lock_ok), ("broken", "torch 是 2.14.0+cpu", false));
        assert_eq!(st.backend, None);
        // 沒有結束碼（被殺 / 無法啟動）
        record_install_outcome(&venv, Some(&lock), None).unwrap();
        assert!(matches!(stamp_state(&venv, Some(&lock)), StampState::Failed { .. }));

        // 重裝成功 → 印記回到 hash → ready
        record_install_outcome(&venv, Some(&lock), Some(0)).unwrap();
        assert_eq!(status_after(cuda_ok(), &stamp_state(&venv, Some(&lock))).state, "ready");
        // lock 變了 → stale
        std::fs::write(&lock, b"numpy==2.5.0\n").unwrap();
        let st = status_after(cuda_ok(), &stamp_state(&venv, Some(&lock)));
        assert_eq!((st.state.as_str(), st.lock_ok), ("stale", false));

        // 成功但找不到 lock：刪掉 installing 印記 → 視同手動 bootstrap（ready + 註明），不能被當成沒跑完
        mark_install_started(&venv).unwrap();
        record_install_outcome(&venv, None, Some(0)).unwrap();
        assert!(!venv.join(STAMP_FILE).exists());
        let st = status_after(cuda_ok(), &stamp_state(&venv, None));
        assert_eq!(st.state, "ready");
        assert!(st.message.contains(STAMP_FILE), "{}", st.message);

        // 腳本在建 venv 之前就停了（ffmpeg 預檢、磁碟空間）：不建目錄、不寫印記，detect 會回 missing
        let fresh = dir.join("fresh").join("pyenv");
        mark_install_started(&fresh).unwrap();
        record_install_outcome(&fresh, Some(&lock), Some(1)).unwrap();
        assert!(!fresh.exists(), "不能為了寫印記把 venv 目錄建出來（腳本會把它當殘留）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn hardware_detection_runs_off_the_async_worker() {
        // spawn_blocking 版與同步版回同一份結果（CI 沒有 GPU → 兩邊都是空的；開發機有卡 → 兩邊都有）
        let a = detect_hardware_async().await;
        let s = detect_hardware();
        assert_eq!((a.nvidia, a.apple_silicon, a.gpus.len()), (s.nvidia, s.apple_silicon, s.gpus.len()));
    }

    #[test]
    fn install_command_is_powershell_noninteractive_bypass_file() {
        let v = install_command_for("windows", Path::new("D:\\r\\scripts\\bootstrap-engine.ps1"), Path::new("D:\\data root"), true, None);
        assert_eq!(&v[..6], &["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
        assert!(v[6].ends_with("bootstrap-engine.ps1"));
        assert_eq!(v[7], "-DataRoot");
        assert_eq!(v[8], "D:\\data root", "含空白的路徑是一個 argv，不經 shell 拆字");
        assert_eq!(v.last().unwrap(), "-WithModels");
        assert!(!v.contains(&"-Wheel".to_string()), "沒有 wheel 就不帶 -Wheel（腳本退回 -e engine）");
        assert!(!install_command_for("windows", Path::new("x.ps1"), Path::new("d"), false, None).contains(&"-WithModels".to_string()));
        // 有內建 wheel：-Wheel <path> 緊接在 -DataRoot 之後
        let w = install_command_for("windows", Path::new("x.ps1"), Path::new("d"), false, Some(Path::new("C:\\r\\resources\\engine\\aivc-0.0.4-py3-none-any.whl")));
        assert_eq!(&w[9..], &["-Wheel", "C:\\r\\resources\\engine\\aivc-0.0.4-py3-none-any.whl"]);
    }

    #[test]
    fn install_command_is_bash_with_long_flags_on_macos_and_linux() {
        for os in ["macos", "linux"] {
            let root = "/Users/alice/Library/Application Support/net.markkulab.aivideocut";
            let v = install_command_for(os, Path::new("/r/scripts/bootstrap-engine.sh"), Path::new(root), true, None);
            assert_eq!(v, vec!["bash", "/r/scripts/bootstrap-engine.sh", "--data-root", root, "--with-models"], "{os}");
            assert!(!v.iter().any(|a| a.starts_with("-DataRoot") || a == "powershell"), "unix 不能出現 PowerShell 參數");
            assert!(!install_command_for(os, Path::new("x.sh"), Path::new("d"), false, None).contains(&"--with-models".to_string()));
            // 有內建 wheel：--wheel <path> 緊接在 --data-root 之後
            let w = install_command_for(os, Path::new("x.sh"), Path::new("d"), false, Some(Path::new("/opt/AI Video Cut/aivc-0.0.6-py3-none-any.whl")));
            assert_eq!(&w[..], &["bash", "x.sh", "--data-root", "d", "--wheel", "/opt/AI Video Cut/aivc-0.0.6-py3-none-any.whl"]);
        }
        // 本機版就是本機 OS 那一種
        let host = install_command(Path::new("s"), Path::new("d"), false, None);
        assert_eq!(host, install_command_for(std::env::consts::OS, Path::new("s"), Path::new("d"), false, None));
        assert_eq!(host[0], if cfg!(windows) { "powershell" } else { "bash" });
    }

    /// 正式版在乾淨機器上按「安裝」時實際會跑的 argv（乾跑，只印出來給人看；`cargo test -- --nocapture` 可見）。
    #[test]
    fn install_command_dry_run_release_layout() {
        let script = Path::new("C:\\Users\\alice\\AppData\\Local\\AI Video Cut\\resources\\engine\\bootstrap-engine.ps1");
        let wheel = Path::new("C:\\Users\\alice\\AppData\\Local\\AI Video Cut\\resources\\engine\\aivc-0.0.4-py3-none-any.whl");
        let root = Path::new("C:\\Users\\alice\\AppData\\Local\\net.markkulab.aivideocut");
        let v = install_command_for("windows", script, root, false, Some(wheel));
        let shown: Vec<String> = v.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }).collect();
        eprintln!("[dry-run] pyenv_install_command (windows) →\n  {}", shown.join(" "));
        assert_eq!(
            v,
            vec![
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script.to_str().unwrap(),
                "-DataRoot",
                root.to_str().unwrap(),
                "-Wheel",
                wheel.to_str().unwrap(),
            ]
        );
        // macOS .app：resource_dir 是 Contents/Resources；資料根是 Tauri 的 app_local_data_dir（Application Support，含空白）
        let script = "/Applications/AI Video Cut.app/Contents/Resources/resources/engine/bootstrap-engine.sh";
        let wheel = "/Applications/AI Video Cut.app/Contents/Resources/resources/engine/aivc-0.0.6-py3-none-any.whl";
        let root = "/Users/alice/Library/Application Support/net.markkulab.aivideocut";
        let v = install_command_for("macos", Path::new(script), Path::new(root), false, Some(Path::new(wheel)));
        let shown: Vec<String> = v.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }).collect();
        eprintln!("[dry-run] pyenv_install_command (macos) →\n  {}", shown.join(" "));
        assert_eq!(v, vec!["bash", script, "--data-root", root, "--wheel", wheel]);
    }

    /// App 傳的旗標名必須是兩支腳本真的認得的名字；名字改了這裡會先紅（腳本不存在時略過：另一個平台的 checkout 可能沒帶）。
    #[test]
    fn bootstrap_scripts_accept_the_flags_the_app_passes() {
        let scripts = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("scripts");
        let ps1 = std::fs::read_to_string(scripts.join(BOOTSTRAP_SCRIPT_PS1)).unwrap_or_default();
        if ps1.is_empty() {
            eprintln!("SKIP: 沒有 {BOOTSTRAP_SCRIPT_PS1}");
        } else {
            assert!(ps1.contains("[string]$DataRoot"), "腳本要有 -DataRoot 參數");
            assert!(ps1.contains("[string]$Wheel"), "腳本要有 -Wheel 參數");
            assert!(ps1.contains("[switch]$WithModels"), "腳本要有 -WithModels 參數");
            assert!(ps1.contains("uv-manifest.json"), "腳本要讀同目錄的 uv-manifest.json（釘版下載）");
        }
        let sh = std::fs::read_to_string(scripts.join(BOOTSTRAP_SCRIPT_SH)).unwrap_or_default();
        if sh.is_empty() {
            eprintln!("SKIP: 沒有 {BOOTSTRAP_SCRIPT_SH}");
        } else {
            let args = install_command_for("linux", Path::new("s.sh"), Path::new("d"), true, Some(Path::new("w.whl")));
            for flag in args.iter().filter(|a| a.starts_with("--")) {
                assert!(sh.contains(flag.as_str()), "{BOOTSTRAP_SCRIPT_SH} 要認得 {flag}");
            }
            assert!(sh.contains("--skip-torch"), "與 ps1 的 -SkipTorch 對等");
            assert!(sh.contains("uv-manifest.json"), "腳本要讀同目錄的 uv-manifest.json（釘版下載）");
            // macOS / Linux 不內建 ffmpeg：預檢必須排在任何下載之前（否則 6-7 GB 下載完才在 doctor 閘門失敗）
            let pos = |needle: &str| sh.find(needle).unwrap_or_else(|| panic!("{BOOTSTRAP_SCRIPT_SH} 要有 {needle}"));
            assert!(pos("step \"ffmpeg: ") < pos("step \"download uv"), "ffmpeg 預檢要在下載 uv 之前");
            assert!(pos("step \"ffmpeg: ") < pos("mkdir -p \"$DATA_ROOT\""), "找不到 ffmpeg 時連資料根都不要建");
            assert!(!sh.contains("glibc 2.28"), "glibc 基準統一講 2.35（README / release notes 同）");
            // 只在 macOS / Linux 驗：那裡的 checkout 才是真的會被 bash 執行的那一份；
            // Windows runner 預設 core.autocrlf=true，工作樹換行不代表 repo 內容，驗了只會誤報
            if !cfg!(windows) {
                assert!(!sh.contains('\r'), "{BOOTSTRAP_SCRIPT_SH} 必須是 LF 換行（CRLF 會讓 bash 把 \\r 當成指令的一部分）");
            }
        }
        // --with-models：兩支腳本呼叫的必須是引擎真的有的指令（曾經兩支都在叫不存在的 `aivc models pull`，ps1 印 invalid choice、sh 靜默略過）
        let models_py = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("engine").join("src").join("aivc").join("ops").join("models.py"))
            .unwrap_or_default();
        if models_py.is_empty() {
            eprintln!("SKIP: 沒有 engine/src/aivc/ops/models.py");
        } else {
            assert!(models_py.contains("cli=\"models\"") && models_py.contains("choices=[\"pull\"]"), "引擎的 CLI 是 `aivc models pull`");
            for (name, text) in [(BOOTSTRAP_SCRIPT_PS1, &ps1), (BOOTSTRAP_SCRIPT_SH, &sh)] {
                if !text.is_empty() {
                    assert!(text.contains("-m aivc models pull --sam small"), "{name} 的模型步驟要呼叫 `aivc models pull --sam small`");
                }
            }
        }
    }

    #[test]
    fn install_env_carries_data_root_models_and_ffmpeg() {
        let p = paths_under(Path::new("/data root"));
        let env = install_env(&p, Some(Path::new("/opt/homebrew/bin")));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("AIVC_DATA_ROOT").as_deref(), Some(p.root.to_str().unwrap()));
        assert_eq!(get("HF_HOME").as_deref(), Some(p.models_hf.to_str().unwrap()));
        assert_eq!(get("TORCH_HOME").as_deref(), Some(p.models_torch.to_str().unwrap()));
        assert_eq!(get("HF_HUB_DISABLE_TELEMETRY").as_deref(), Some("1"));
        assert_eq!(get("AIVC_FFMPEG_DIR").as_deref(), Some("/opt/homebrew/bin"));
        assert!(install_env(&p, None).iter().all(|(k, _)| k != "AIVC_FFMPEG_DIR"), "沒解析到 ffmpeg 就不設（腳本 / 引擎自己再找）");
        // 模型快取與引擎執行時一致
        let eng = engine_env(&p, None, Path::new("c"));
        for k in ["HF_HOME", "TORCH_HOME", "AIVC_DATA_ROOT"] {
            assert_eq!(eng.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()), get(k), "{k}");
        }
    }

    #[test]
    fn bootstrap_script_name_depends_on_os() {
        assert_eq!(bootstrap_script_name("windows"), "bootstrap-engine.ps1");
        assert_eq!(bootstrap_script_name("macos"), "bootstrap-engine.sh");
        assert_eq!(bootstrap_script_name("linux"), "bootstrap-engine.sh");
        assert_eq!(BOOTSTRAP_SCRIPT, bootstrap_script_name(std::env::consts::OS));
    }

    #[test]
    fn bootstrap_script_resolution_order() {
        let canon = |p: &Path| dunce::canonicalize(p).unwrap();
        for name in [BOOTSTRAP_SCRIPT_PS1, BOOTSTRAP_SCRIPT_SH] {
            let dir = std::env::temp_dir().join(format!("aivc bootstrap 測試-{}", uuid::Uuid::new_v4()));
            let res = dir.join("res"); // 假 resource_dir
            let dev = dir.join("repo").join("scripts");
            let bundled = res.join("resources").join("engine").join(name);
            let devscript = dev.join(name);
            let custom = dir.join("custom").join("my-script");
            std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
            std::fs::create_dir_all(&dev).unwrap();
            std::fs::create_dir_all(custom.parent().unwrap()).unwrap();
            // 什麼都沒有 → None（安裝檔沒帶腳本又不在原始碼樹上）
            assert_eq!(resolve_bootstrap_script(name, None, Some(&res), Some(&dev)), None);
            // 只有 dev → dev
            std::fs::write(&devscript, b"# dev").unwrap();
            assert_eq!(resolve_bootstrap_script(name, None, Some(&res), Some(&dev)), Some(canon(&devscript)));
            // 內建的存在 → 優先於 dev（正式版永遠用安裝檔裡那一份）
            std::fs::write(&bundled, b"# bundled").unwrap();
            assert_eq!(resolve_bootstrap_script(name, None, Some(&res), Some(&dev)), Some(canon(&bundled)));
            assert_eq!(resolve_bootstrap_script(name, None, None, Some(&dev)), Some(canon(&devscript)), "沒有 resource_dir 就退回 dev");
            assert_eq!(resolve_bootstrap_script(name, None, Some(&res), None), Some(canon(&bundled)), "沒有 dev 目錄也行");
            // 另一個 OS 的腳本不算數：Windows 不會拿 .sh 去餵 PowerShell，反之亦然
            let other = if name == BOOTSTRAP_SCRIPT_PS1 { BOOTSTRAP_SCRIPT_SH } else { BOOTSTRAP_SCRIPT_PS1 };
            assert_eq!(resolve_bootstrap_script(other, None, Some(&res), Some(&dev)), None, "{name} 不能被當成 {other}");
            // env 覆寫存在 → 最優先；指到不存在的檔 → 忽略往下找；空白視同沒設
            std::fs::write(&custom, b"# custom").unwrap();
            assert_eq!(resolve_bootstrap_script(name, Some(custom.to_str().unwrap()), Some(&res), Some(&dev)), Some(canon(&custom)));
            assert_eq!(resolve_bootstrap_script(name, Some(dir.join("nope").to_str().unwrap()), Some(&res), Some(&dev)), Some(canon(&bundled)));
            assert_eq!(resolve_bootstrap_script(name, Some("   "), Some(&res), Some(&dev)), Some(canon(&bundled)));
            // 回傳的路徑不帶 \\?\（要餵給 powershell -File / bash）
            assert!(!resolve_bootstrap_script(name, None, Some(&res), None).unwrap().to_string_lossy().starts_with("\\\\?\\"));
            let _ = std::fs::remove_dir_all(&dir);
        }
        // 真實入口：原始碼樹上 repo 有 scripts/<本機 OS 的腳本>，所以 env 沒設時一定解析得到；不再有 debug-only 閘門
        if std::env::var(ENV_BOOTSTRAP_SCRIPT).is_err() {
            let real = bootstrap_script(None).unwrap_or_else(|| panic!("repo 的 scripts/{BOOTSTRAP_SCRIPT}"));
            assert!(real.ends_with(BOOTSTRAP_SCRIPT) && real.is_file(), "{}", real.display());
            // 假的 resource_dir 裡有內建腳本 → 內建優先於 repo 的
            let dir = std::env::temp_dir().join(format!("aivc bootstrap real-{}", uuid::Uuid::new_v4()));
            let bundled = dir.join("resources").join("engine").join(BOOTSTRAP_SCRIPT);
            std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
            std::fs::write(&bundled, b"# bundled").unwrap();
            assert_eq!(bootstrap_script(Some(&dir)), Some(canon(&bundled)));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn steps_are_recognised_from_bootstrap_output() {
        assert_eq!(step_of_line("==> free space on C: 56.1 GB"), Some("base"));
        assert_eq!(step_of_line("==> download uv"), Some("uv"));
        assert_eq!(step_of_line("==> create venv (python 3.12)"), Some("venv"));
        assert_eq!(step_of_line("==> uv venv left Scripts empty -> fallback: py -3.12 -m venv"), Some("venv"));
        assert_eq!(step_of_line("==> install torch/torchvision from cu130 index"), Some("torch"));
        // bootstrap-engine.sh 的對應行（macOS / Linux）：資料根路徑含空白、MPS 的 torch 來源、venv 退路
        assert_eq!(step_of_line("==> free space on /Users/alice/Library/Application Support/net.markkulab.aivideocut: 120.5 GB"), Some("base"));
        // ffmpeg 預檢（下載前）：路徑裡有 venv / torch 字樣也不能被誤判成後面的步驟
        assert_eq!(step_of_line("==> ffmpeg: /opt/homebrew/bin/ffmpeg 8.0.1"), Some("base"));
        assert_eq!(step_of_line("==> ffmpeg: /home/u/venv-tools/torch/bin/ffmpeg 6.1.1-3ubuntu5"), Some("base"));
        assert_eq!(step_of_line("==> remove incomplete venv at /home/u/.local/share/net.markkulab.aivideocut/pyenv"), Some("venv"));
        assert_eq!(step_of_line("==> download uv 0.12.15 (pinned)"), Some("uv"));
        assert_eq!(step_of_line("==> uv venv failed -> fallback: python3.12 -m venv"), Some("venv"));
        assert_eq!(step_of_line("==> install torch/torchvision from PyPI (MPS)"), Some("torch"));
        assert_eq!(step_of_line("==> install requirements.lock.txt"), Some("deps"));
        assert_eq!(step_of_line("==> install aivc (editable)"), Some("wheel"));
        assert_eq!(step_of_line("==> install aivc (wheel)"), Some("wheel"));
        assert_eq!(step_of_line("==> gate: aivc doctor"), Some("gate"));
        assert_eq!(step_of_line("==> pull models"), Some("models"));
        assert_eq!(step_of_line("Resolved 40 packages in 1.2s"), None);
        assert_eq!(step_of_line("==> something else"), None);
        for s in STEPS {
            assert!(!s.is_empty());
        }
    }

    #[test]
    fn engine_env_points_models_and_ffmpeg_at_app_dirs() {
        let p = paths_under(Path::new("D:\\aivc"));
        let env = engine_env(&p, Some(Path::new("C:\\ff\\bin")), Path::new("C:\\cache"));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert!(get("HF_HOME").unwrap().ends_with("hf"));
        assert!(get("TORCH_HOME").unwrap().ends_with("torch"));
        assert_eq!(get("HF_HUB_DISABLE_TELEMETRY").as_deref(), Some("1"));
        assert_eq!(get("PYTHONUTF8").as_deref(), Some("1"));
        assert_eq!(get("CUDA_MODULE_LOADING").as_deref(), Some("LAZY"));
        assert_eq!(get("AIVC_FFMPEG_DIR").as_deref(), Some("C:\\ff\\bin"));
        assert_eq!(get("AIVC_CACHE_DIR").as_deref(), Some("C:\\cache"));
        assert_eq!(get("AIVC_DATA_ROOT").as_deref(), Some("D:\\aivc"));
        assert!(engine_env(&p, None, Path::new("c")).iter().all(|(k, _)| k != "AIVC_FFMPEG_DIR"));
    }

    #[test]
    fn picks_the_exception_line_out_of_a_traceback() {
        assert!(is_exception_line("RuntimeError: cuBLAS failed with status CUBLAS_STATUS_NOT_SUPPORTED"));
        assert!(is_exception_line("ValueError: bad input"));
        assert!(is_exception_line("torch.cuda.OutOfMemoryError: CUDA out of memory"));
        // 呼叫堆疊與其他雜訊都不是 —— 只留「最後 N 行」時它們會蓋掉真正的錯誤
        assert!(!is_exception_line("Traceback (most recent call last):"));
        assert!(!is_exception_line("  File \"x.py\", line 26, in main"));
        assert!(!is_exception_line("    sys.exit(main())"));
        assert!(!is_exception_line("RuntimeError:"), "冒號後面沒有說明就不算");
        assert!(!is_exception_line("warning: something"), "小寫開頭不是例外類別");
        assert!(!is_exception_line("no colon here"));
    }

    #[tokio::test]
    async fn non_utf8_output_lines_are_decoded_not_dropped() {
        // PowerShell 5.1 以 cp950 寫進管線的 throw 原因：「需要至少 15 GB」
        let cp950: &[u8] = b"\xbb\xdd\xadn\xa6\xdc\xa4\xd6 15 GB";
        let mut data: Vec<u8> = Vec::new();
        data.extend_from_slice(b"==> free space on C: 3.0 GB\r\n");
        data.extend_from_slice(cp950);
        data.extend_from_slice(b"\r\n+ ~~~~\n");
        data.extend_from_slice("中文 UTF-8 最後一行沒有換行".as_bytes());

        // 舊寫法（`lines()` + `Err(_) => continue`）的行為：非 UTF-8 那一行整行消失 —— 這就是 bug
        let mut old = Vec::new();
        let mut lines = BufReader::new(&data[..]).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(l)) => old.push(l),
                Ok(None) => break,
                Err(_) => continue,
            }
        }
        assert!(!old.iter().any(|l| l.contains("15 GB")), "前提：lines() 會吃掉非 UTF-8 行 {old:?}");

        let mut r = BufReader::new(&data[..]);
        let mut buf = Vec::new();
        let mut got = Vec::new();
        while let Some(l) = next_lossy_line(&mut r, &mut buf).await.unwrap() {
            got.push(l);
        }
        assert_eq!(got.len(), 4, "{got:?}");
        assert_eq!(got[0], "==> free space on C: 3.0 GB", "行尾 \\r\\n 要去掉");
        assert!(got[1].ends_with(" 15 GB") && !got[1].contains('\r'), "{:?}", got[1]);
        #[cfg(windows)]
        if win_cp::ansi_code_page() == 950 {
            assert_eq!(got[1], "需要至少 15 GB", "zh-TW 的 ANSI 代碼頁要解回中文");
        }
        assert_eq!(got[2], "+ ~~~~");
        assert_eq!(got[3], "中文 UTF-8 最後一行沒有換行");
        // 合法 UTF-8 原樣；空位元組 → 空字串
        assert_eq!(decode_console_bytes("好".as_bytes()), "好");
        assert_eq!(decode_console_bytes(b""), "");
    }

    #[test]
    fn install_guard_rejects_a_second_install_until_released() {
        let flag = AtomicBool::new(false);
        let g = try_acquire(&flag).expect("第一支安裝拿得到");
        assert!(flag.load(Ordering::SeqCst));
        assert!(try_acquire(&flag).is_none(), "安裝中再按一次要被擋，不管 pyenv.state 被改成什麼");
        drop(g);
        assert!(!flag.load(Ordering::SeqCst), "結束（含出錯提早 return）要放掉");
        let g2 = try_acquire(&flag).expect("放掉之後可以再裝");
        // 安裝途中 panic 展開也會放掉
        let flag2 = AtomicBool::new(false);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = try_acquire(&flag2).unwrap();
            panic!("boom");
        }));
        assert!(r.is_err() && !flag2.load(Ordering::SeqCst));
        drop(g2);
    }

    #[test]
    fn parses_nvidia_smi() {
        let g = parse_nvidia_smi("NVIDIA GeForce RTX 5090, 32607\n");
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].name, "NVIDIA GeForce RTX 5090");
        assert_eq!(g[0].vram_mb, 32607);
    }

    #[test]
    fn parses_multiple_gpus() {
        let g = parse_nvidia_smi("NVIDIA RTX A4000, 16376\nNVIDIA GeForce RTX 3060, 12288\n");
        assert_eq!(g.len(), 2);
        assert_eq!(g[1].vram_mb, 12288);
    }

    #[test]
    fn parses_apple_silicon_sysctl() {
        let g = parse_apple_silicon("Apple M2 Pro\n", "34359738368\n").expect("Apple Silicon");
        assert_eq!(g.name, "Apple M2 Pro (MPS)");
        assert_eq!(g.vram_mb, 32768, "統一記憶體 32 GB");
        // Intel Mac：引擎不支援，不能回一張「看起來可用」的卡
        assert!(parse_apple_silicon("Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz", "17179869184").is_none());
        assert!(parse_apple_silicon("Apple M1", "not a number").is_none());
        assert!(parse_apple_silicon("Apple M1", "0").is_none());
        assert!(parse_apple_silicon("", "").is_none());
    }

    #[test]
    fn ignores_junk_from_nvidia_smi() {
        // 沒有驅動時 nvidia-smi 會印錯誤訊息而不是 CSV
        assert!(parse_nvidia_smi("NVIDIA-SMI has failed because it couldn't communicate").is_empty());
        assert!(parse_nvidia_smi("").is_empty());
        assert!(parse_nvidia_smi("some gpu, notanumber").is_empty());
        assert!(parse_nvidia_smi(", 8192").is_empty());
        assert!(parse_nvidia_smi("no vram gpu, 0").is_empty());
    }
}
