//! App 更新後第一次啟動引擎：把 venv 裡的引擎 wheel 換成安裝檔內建的那一份（**不重抓 torch**）。
//!
//! 問題：App 升版（自動更新或重裝安裝檔）之後，安裝目錄的 `resources/engine/` 換成新版的 wheel，
//! 使用者資料根裡的 venv 卻還是舊版的 `aivc`。pyenv 偵測只看 `.stamp`（requirements.lock.txt 的 hash），
//! lock 沒變就回 ready；引擎一啟動，hello 的版本比對（`engine::hello_compatible`）就拒絕：
//! 「引擎版本 X 與 App 版本 Y 不同，請到「設定 → 引擎」重新安裝引擎」—— 每次更新都要使用者手動重裝一次。
//!
//! 修法：啟動引擎之前（`AppState::engine_config`，引擎不是 Ready 時）比對兩份清單：
//! - 安裝目錄 `<resource_dir>/resources/engine/` 裡**版本等於 App 版本**的全部 `*.whl`（核心 `aivc` 加上外掛 wheel，
//!   例如 cards 外掛的 `aivc_cards`）；版本不符的不算 —— NSIS 的 `/UPDATE` 不刪舊檔，上一版的 wheel 會留在原地；
//! - venv 裡的 `pyenv/.wheels`（上次換 wheel 時寫下的「檔名 + sha256」）。
//!
//! 不同就跑 `uv pip install --offline --no-deps --reinstall <全部 wheel>`（找不到 uv 時退回 venv 的 pip）：只裝這幾顆純 Python
//! wheel，不解析依賴、不連網、不碰 torch，幾秒內完成；成功後寫 `.wheels`。失敗只記 log —— 引擎照樣啟動，
//! 版本真的對不上時 hello 的錯誤訊息會請使用者到設定重新安裝（跟沒有這個機制時一樣，不會更糟）。
//!
//! 只在 `.stamp` 是 `Current`（上次 App 安裝成功、lock 沒變）時做：lock 變了代表依賴也要換，那是完整重裝
//! （「stale」狀態，設定 → 引擎）的事，只換 wheel 會讓新程式碼跑在舊依賴上；安裝失敗 / 沒跑完、手動 bootstrap、
//! 自訂 python（`AIVC_PYTHON` / python_override）一律不碰。debug build 也不碰：開發期是 `-e engine`，拿 wheel 蓋掉會讓改的程式碼不生效。
//! 完整安裝（bootstrap 腳本）只裝核心 wheel：裝完 `.wheels` 還是舊的，下一次啟動引擎時這裡會把外掛 wheel 一起補上。
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::proc;
use crate::pyenv::{self, PyEnvPaths, StampState};

/// venv 裡記錄「目前裝的是哪幾顆內建 wheel」的檔（每行 `<檔名> <sha256>`，依檔名排序）。只有這個模組會寫。
pub const WHEELS_STAMP: &str = ".wheels";
/// 換 wheel 的上限（正常幾秒；防毒掃描很慢的機器留餘裕）。
pub const REFRESH_TIMEOUT: Duration = Duration::from_secs(180);

/// 安裝目錄裡的一顆 wheel。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledWheel {
    pub path: PathBuf,
    pub file_name: String,
    /// 正規化的套件名（`normalize_dist`）。
    pub dist: String,
    pub sha256: String,
}

/// PEP 503 式正規化：小寫、`-` `.` 換成 `_`（wheel 檔名裡的套件名本來就把 `-` 換成 `_` 了）。
pub fn normalize_dist(d: &str) -> String {
    d.to_ascii_lowercase().replace(['-', '.'], "_")
}

/// wheel 檔名（`{dist}-{version}(-{build})?-{py}-{abi}-{plat}.whl`）→ (正規化的套件名, 版本)。
/// 不是 wheel、段數不對、版本不是數字開頭 → None。
pub fn parse_wheel_file_name(name: &str) -> Option<(String, String)> {
    let stem = name.strip_suffix(".whl")?;
    let parts: Vec<&str> = stem.split('-').collect();
    if !(5..=6).contains(&parts.len()) {
        return None;
    }
    let (dist, version) = (parts[0], parts[1]);
    if dist.is_empty() || !version.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((normalize_dist(dist), version.to_string()))
}

/// `dir` 裡版本等於 `app_version`（PEP 440 正規化後比，見 `pyenv::py_version`）的全部 wheel（核心 + 外掛），依檔名排序；同一個套件有兩顆時只留第一顆
/// （uv 遇到同名套件的兩個檔會直接報錯，整批都裝不起來）。讀檔算 sha256：wheel 是幾 MB 的純 Python 包，很快。
pub fn bundled_wheels(dir: &Path, app_version: &str) -> Vec<BundledWheel> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let want = pyenv::py_version(app_version);
    let mut out: Vec<BundledWheel> = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        let Some((dist, version)) = parse_wheel_file_name(&name) else { continue };
        if pyenv::py_version(&version) != want {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else { continue };
        out.push(BundledWheel { path: dunce::simplified(&p).to_path_buf(), file_name: name, dist, sha256: pyenv::sha256_hex(&bytes) });
    }
    out.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    let mut seen = std::collections::HashSet::new();
    out.retain(|w| seen.insert(w.dist.clone()));
    out
}

/// `.wheels` 的內容（也是比對的鍵）：每行 `<檔名> <sha256>`。沒有 wheel → 空字串。
pub fn stamp_text(wheels: &[BundledWheel]) -> String {
    wheels.iter().map(|w| format!("{} {}\n", w.file_name, w.sha256)).collect()
}

/// 要不要換 wheel；不換的話為什麼（log 用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Refresh,
    Skip(&'static str),
}

/// `decide` 的輸入（全部由呼叫端讀好，規則本身是純函式）。
#[derive(Debug, Clone)]
pub struct Inputs<'a> {
    /// release build（debug build 用 `-e engine`，不拿 wheel 蓋掉）。
    pub release: bool,
    /// 要啟動的 python 就是受管 venv 的那一支（不是 `AIVC_PYTHON` / python_override）。
    pub managed: bool,
    /// 完整安裝（bootstrap 腳本）正在跑。
    pub installing: bool,
    pub stamp: &'a StampState,
    /// `stamp_text(bundled_wheels(...))`。
    pub bundled: &'a str,
    /// venv 的 `.wheels`；None＝沒有（venv 是舊版 App 裝的，或從沒換過）。
    pub recorded: Option<&'a str>,
}

pub fn decide(i: &Inputs) -> Decision {
    if !i.release {
        return Decision::Skip("debug build：開發期用 -e engine");
    }
    if !i.managed {
        return Decision::Skip("自訂 python 不是受管 venv");
    }
    if i.installing {
        return Decision::Skip("完整安裝進行中");
    }
    if i.bundled.trim().is_empty() {
        return Decision::Skip("安裝目錄沒有版本相符的 wheel");
    }
    match i.stamp {
        StampState::Current => {}
        StampState::Outdated => return Decision::Skip("requirements.lock 變了：要完整重裝（設定 → 引擎）"),
        StampState::Failed { .. } => return Decision::Skip("上次安裝沒有成功：要完整重裝"),
        StampState::Missing | StampState::Unverified => return Decision::Skip("不是 App 裝的環境，或無法核對 lock"),
    }
    if i.recorded.map(str::trim) == Some(i.bundled.trim()) {
        return Decision::Skip("已是安裝檔內建的 wheel");
    }
    Decision::Refresh
}

/// 換 wheel 的指令（純函式）。有 uv（引導腳本放在 `<資料根>/tools/uv/`）就用 uv：`--offline`（不連網）、`--no-deps`（不解析、
/// 不碰 torch 與其他依賴）、`--reinstall`（同版號也真的換掉）。沒有 uv 退回 venv 的 pip（stdlib venv 才有 pip）：
/// `--no-index --no-deps --force-reinstall`，同樣不連網、不碰依賴。wheel 路徑一個 argv 一個，不經 shell 拆字。
pub fn refresh_command(uv: Option<&Path>, python: &Path, wheels: &[PathBuf]) -> Vec<String> {
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let mut v: Vec<String> = match uv {
        Some(uv) => vec![s(uv), "pip".into(), "install".into(), "--python".into(), s(python), "--offline".into(), "--no-deps".into(), "--reinstall".into()],
        None => vec![
            s(python),
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--disable-pip-version-check".into(),
            "--no-index".into(),
            "--no-deps".into(),
            "--force-reinstall".into(),
        ],
    };
    v.extend(wheels.iter().map(|w| w.to_string_lossy().into_owned()));
    v
}

/// 引導腳本下載的 uv（`bootstrap-engine.ps1` 的 `$tools\uv.exe`、`.sh` 的 `$DATA_ROOT/tools/uv/uv`）。
pub fn uv_path(paths: &PyEnvPaths) -> Option<PathBuf> {
    let p = paths.tools_uv.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    p.is_file().then_some(p)
}

/// 跑換 wheel 的指令；成功才寫 `.wheels`（失敗時下一次啟動引擎會再試）。輸出附掛到 `log`（`logs/bootstrap.log`）。
pub async fn apply(argv: &[String], venv: &Path, stamp: &str, log: Option<&Path>) -> Result<(), String> {
    let (prog, rest) = argv.split_first().ok_or("指令是空的")?;
    let mut c = proc::cmd(prog);
    c.args(rest).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let out = match tokio::time::timeout(REFRESH_TIMEOUT, c.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("啟動 {prog} 失敗：{e}")),
        Err(_) => return Err(format!("超過 {} 秒沒有完成", REFRESH_TIMEOUT.as_secs())),
    };
    if let Some(log) = log {
        append_log(log, argv, &out);
    }
    if !out.status.success() {
        let err = pyenv::decode_console_bytes(&out.stderr);
        let last = err.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
        return Err(format!("結束碼 {}：{last}", out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())));
    }
    std::fs::write(venv.join(WHEELS_STAMP), stamp).map_err(|e| format!("寫入 {WHEELS_STAMP} 失敗：{e}"))
}

fn append_log(log: &Path, argv: &[String], out: &std::process::Output) {
    use std::io::Write;
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) else { return };
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let _ = writeln!(f, "{ts} ==> refresh bundled wheels: {}", argv.join(" "));
    for (bytes, mark) in [(&out.stdout, ""), (&out.stderr, "! ")] {
        for l in pyenv::decode_console_bytes(bytes).lines().filter(|l| !l.trim().is_empty()) {
            let _ = writeln!(f, "{ts} {mark}{l}");
        }
    }
}

/// 同一時間只跑一支：兩個 engine_call 同時進來時，第二個等第一個換完再判斷，看到 `.wheels` 已更新就跳過。
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `AppState::engine_config` 在引擎不是 Ready 時呼叫：需要就換 wheel（規則見 `decide`）。從不回錯 —— 結果只進 log。
pub async fn ensure_fresh(resource_dir: Option<&Path>, paths: &PyEnvPaths, python: &Path, lock_file: Option<&Path>) {
    let release = !cfg!(debug_assertions);
    let managed = python == paths.python;
    // 同 decide 的前三條：先擋掉，免得每次啟動引擎都白算一次 wheel 的 hash
    if !release || !managed || pyenv::install_in_progress() {
        return;
    }
    let Some(dir) = resource_dir.map(|r| r.join("resources").join("engine")) else { return };
    let _g = REFRESH_LOCK.lock().await;
    let wheels = tokio::task::spawn_blocking(move || bundled_wheels(&dir, env!("CARGO_PKG_VERSION"))).await.unwrap_or_default();
    let bundled = stamp_text(&wheels);
    let recorded = std::fs::read_to_string(paths.venv.join(WHEELS_STAMP)).ok();
    let stamp = pyenv::stamp_state(&paths.venv, lock_file);
    let inputs = Inputs { release, managed, installing: pyenv::install_in_progress(), stamp: &stamp, bundled: &bundled, recorded: recorded.as_deref() };
    if let Decision::Skip(why) = decide(&inputs) {
        if !bundled.is_empty() && recorded.as_deref().map(str::trim) != Some(bundled.trim()) {
            eprintln!("[wheels] 不換：{why}");
        }
        return;
    }
    let names: Vec<&str> = wheels.iter().map(|w| w.file_name.as_str()).collect();
    eprintln!("[wheels] App 版本換了，重裝內建 wheel：{}", names.join("、"));
    let argv = refresh_command(uv_path(paths).as_deref(), python, &wheels.iter().map(|w| w.path.clone()).collect::<Vec<_>>());
    match apply(&argv, &paths.venv, &bundled, Some(&paths.logs.join("bootstrap.log"))).await {
        Ok(()) => eprintln!("[wheels] 完成"),
        Err(e) => eprintln!("[wheels] 失敗：{e}（引擎啟動時的版本檢查會請使用者到「設定 → 引擎」重新安裝）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aivc wheels {tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parses_core_and_plugin_wheel_names() {
        assert_eq!(parse_wheel_file_name("aivc-0.0.7-py3-none-any.whl"), Some(("aivc".into(), "0.0.7".into())));
        assert_eq!(parse_wheel_file_name("aivc_cards-0.0.7-py3-none-any.whl"), Some(("aivc_cards".into(), "0.0.7".into())));
        assert_eq!(parse_wheel_file_name("AIVC.Cards-0.0.7-py3-none-any.whl"), Some(("aivc_cards".into(), "0.0.7".into())), "正規化");
        assert_eq!(parse_wheel_file_name("aivc-0.0.7-1-py3-none-any.whl"), Some(("aivc".into(), "0.0.7".into())), "帶 build tag");
        assert_eq!(parse_wheel_file_name("numpy-2.4.6-cp312-cp312-win_amd64.whl"), Some(("numpy".into(), "2.4.6".into())));
        for bad in ["README.txt", "aivc-0.0.7.tar.gz", "aivc-py3-none-any.whl", "aivc-x.y-py3-none-any.whl", "-0.0.7-py3-none-any.whl", "aivc-0.0.7.whl", "requirements.lock.txt"] {
            assert_eq!(parse_wheel_file_name(bad), None, "{bad}");
        }
    }

    /// 安裝目錄（NSIS `/UPDATE` 蓋過去的）：新版的核心 + 外掛 wheel、上一版留下的舊 wheel、其他檔案。只挑版本相符的。
    #[test]
    fn picks_every_version_matched_wheel_including_plugins() {
        let dir = tmpdir("挑選");
        for (name, body) in [
            ("aivc-0.0.6-py3-none-any.whl", "舊版留下的"),
            ("aivc-0.0.7-py3-none-any.whl", "core"),
            ("aivc_cards-0.0.7-py3-none-any.whl", "cards"),
            ("aivc_cards-0.0.6-py3-none-any.whl", "舊外掛"),
            ("numpy-2.4.6-cp312-cp312-win_amd64.whl", "別家的"),
            ("requirements.lock.txt", "numpy==2.4.6"),
            ("README.txt", "x"),
        ] {
            std::fs::write(dir.join(name), body).unwrap();
        }
        std::fs::create_dir_all(dir.join("aivc_dir-0.0.7-py3-none-any.whl")).unwrap(); // 目錄不算
        let got = bundled_wheels(&dir, "0.0.7");
        assert_eq!(got.iter().map(|w| w.file_name.as_str()).collect::<Vec<_>>(), ["aivc-0.0.7-py3-none-any.whl", "aivc_cards-0.0.7-py3-none-any.whl"]);
        assert_eq!(got[0].dist, "aivc");
        assert_eq!(got[0].sha256, pyenv::sha256_hex(b"core"));
        assert!(got.iter().all(|w| w.path.is_file() && !w.path.to_string_lossy().starts_with("\\\\?\\")));
        assert_eq!(stamp_text(&got), format!("aivc-0.0.7-py3-none-any.whl {}\naivc_cards-0.0.7-py3-none-any.whl {}\n", pyenv::sha256_hex(b"core"), pyenv::sha256_hex(b"cards")));
        // 沒有版本相符的 → 空（安裝檔壞了：交給 hello 的版本檢查去講）
        assert!(bundled_wheels(&dir, "0.0.8").is_empty());
        assert!(bundled_wheels(&dir.join("沒有這個目錄"), "0.0.7").is_empty());
        // 同一個套件兩顆（build tag 不同）：只留一顆，不然 uv 整批報錯
        std::fs::write(dir.join("aivc-0.0.7-1-py3-none-any.whl"), "core build 1").unwrap();
        let got = bundled_wheels(&dir, "0.0.7");
        assert_eq!(got.iter().filter(|w| w.dist == "aivc").count(), 1);
        // 預先發布版：App 的 0.0.8-beta.1 在 wheel 檔名裡是 PEP 440 的 0.0.8b1（setuptools 正規化），一樣要挑得到
        std::fs::write(dir.join("aivc-0.0.8b1-py3-none-any.whl"), "beta core").unwrap();
        std::fs::write(dir.join("aivc_cards-0.0.8b1-py3-none-any.whl"), "beta cards").unwrap();
        let got = bundled_wheels(&dir, "0.0.8-beta.1");
        assert_eq!(got.iter().map(|w| w.file_name.as_str()).collect::<Vec<_>>(), ["aivc-0.0.8b1-py3-none-any.whl", "aivc_cards-0.0.8b1-py3-none-any.whl"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn inputs<'a>(stamp: &'a StampState, bundled: &'a str, recorded: Option<&'a str>) -> Inputs<'a> {
        Inputs { release: true, managed: true, installing: false, stamp, bundled, recorded }
    }

    #[test]
    fn refreshes_only_when_the_lock_is_unchanged_and_the_wheels_differ() {
        let cur = StampState::Current;
        let new = "aivc-0.0.8-py3-none-any.whl aaa\n";
        let old = "aivc-0.0.7-py3-none-any.whl bbb\n";
        // venv 是舊版 App 裝的（沒有 .wheels）或記錄的是舊版 → 換
        assert_eq!(decide(&inputs(&cur, new, None)), Decision::Refresh);
        assert_eq!(decide(&inputs(&cur, new, Some(old))), Decision::Refresh);
        // 外掛 wheel 是新加的（完整安裝只裝了核心）→ 也要換
        assert_eq!(decide(&inputs(&cur, &format!("{new}aivc_cards-0.0.8-py3-none-any.whl ccc\n"), Some(new))), Decision::Refresh);
        // 已經換過 → 不動（換行 / 結尾空白不影響）
        assert!(matches!(decide(&inputs(&cur, new, Some(new.trim_end()))), Decision::Skip(_)));
        // lock 變了：完整重裝的事（依賴也要換），不能只換 wheel
        assert!(matches!(decide(&inputs(&StampState::Outdated, new, Some(old))), Decision::Skip(w) if w.contains("lock")));
        assert!(matches!(decide(&inputs(&StampState::Failed { detail: "x".into() }, new, None)), Decision::Skip(_)));
        assert!(matches!(decide(&inputs(&StampState::Missing, new, None)), Decision::Skip(_)));
        assert!(matches!(decide(&inputs(&StampState::Unverified, new, None)), Decision::Skip(_)));
        // 沒有內建 wheel（dev / 壞掉的安裝檔）、debug build、自訂 python、完整安裝中 → 不動
        assert!(matches!(decide(&inputs(&cur, "", None)), Decision::Skip(_)));
        assert!(matches!(decide(&Inputs { release: false, ..inputs(&cur, new, None) }), Decision::Skip(_)));
        assert!(matches!(decide(&Inputs { managed: false, ..inputs(&cur, new, None) }), Decision::Skip(_)));
        assert!(matches!(decide(&Inputs { installing: true, ..inputs(&cur, new, None) }), Decision::Skip(_)));
    }

    /// 換 wheel 絕不重抓 torch：不連網、不解析依賴、不讀 requirements。
    #[test]
    fn refresh_command_never_touches_torch_or_the_network() {
        let wheels = vec![PathBuf::from("C:\\Program Files\\AI Video Cut\\resources\\engine\\aivc-0.0.8-py3-none-any.whl"), PathBuf::from("C:\\Program Files\\AI Video Cut\\resources\\engine\\aivc_cards-0.0.8-py3-none-any.whl")];
        let py = Path::new("C:\\data\\pyenv\\Scripts\\python.exe");
        let uv = refresh_command(Some(Path::new("C:\\data\\tools\\uv\\uv.exe")), py, &wheels);
        assert_eq!(&uv[..8], &["C:\\data\\tools\\uv\\uv.exe", "pip", "install", "--python", "C:\\data\\pyenv\\Scripts\\python.exe", "--offline", "--no-deps", "--reinstall"]);
        assert_eq!(&uv[8..], &[wheels[0].to_string_lossy().into_owned(), wheels[1].to_string_lossy().into_owned()], "每顆 wheel 一個 argv（路徑有空白）");
        let pip = refresh_command(None, py, &wheels);
        assert_eq!(&pip[..3], &["C:\\data\\pyenv\\Scripts\\python.exe", "-m", "pip"]);
        for flag in ["--no-index", "--no-deps", "--force-reinstall"] {
            assert!(pip.contains(&flag.to_string()), "{flag}");
        }
        for argv in [&uv, &pip] {
            assert!(!argv.iter().any(|a| a == "-r" || a.contains("requirements") || a.contains("torch") || a.contains("index-url")), "{argv:?}");
        }
    }

    #[test]
    fn uv_path_is_the_one_the_bootstrap_scripts_download() {
        let dir = tmpdir("uv");
        let p = pyenv::paths_under(&dir);
        assert_eq!(uv_path(&p), None);
        std::fs::create_dir_all(&p.tools_uv).unwrap();
        let exe = p.tools_uv.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(uv_path(&p), Some(exe));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `AIVC_TEST_PYTHON` → `python3` → `python`（同 engine.rs 的假引擎測試）；要真的能跑 `-c` 才算。
    fn find_python() -> Option<String> {
        let mut cands: Vec<String> = std::env::var("AIVC_TEST_PYTHON").ok().filter(|s| !s.trim().is_empty()).into_iter().collect();
        cands.extend(["python3".to_string(), "python".to_string()]);
        cands.into_iter().find(|c| {
            let mut cmd = std::process::Command::new(c);
            cmd.args(["-c", "print(1)"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(proc::CREATE_NO_WINDOW);
            }
            cmd.status().is_ok_and(|s| s.success())
        })
    }

    /// 執行與記帳：成功才寫 `.wheels`（下一次啟動就不再換）；失敗不寫（下一次再試），錯誤帶 stderr 最後一行；輸出進 log。
    #[tokio::test]
    async fn apply_records_the_wheels_only_on_success() {
        let Some(py) = find_python() else {
            eprintln!("SKIP: 找不到可用的 python");
            return;
        };
        let dir = tmpdir("執行");
        let venv = dir.join("pyenv");
        std::fs::create_dir_all(&venv).unwrap();
        let log = dir.join("bootstrap.log");
        let stamp = "aivc-0.0.8-py3-none-any.whl abc\n";

        let fail = vec![py.clone(), "-c".into(), "import sys; sys.stderr.write('boom: 磁碟滿了\\n'); sys.exit(3)".into()];
        let e = apply(&fail, &venv, stamp, Some(&log)).await.unwrap_err();
        assert!(e.contains('3') && e.contains("boom"), "{e}");
        assert!(!venv.join(WHEELS_STAMP).exists(), "失敗不能記成已換");

        let ok = vec![py.clone(), "-c".into(), "print('Installed 2 packages')".into()];
        apply(&ok, &venv, stamp, Some(&log)).await.unwrap();
        assert_eq!(std::fs::read_to_string(venv.join(WHEELS_STAMP)).unwrap(), stamp);
        let logged = std::fs::read_to_string(&log).unwrap();
        assert!(logged.contains("refresh bundled wheels") && logged.contains("Installed 2 packages") && logged.contains("! boom"), "{logged}");

        assert!(apply(&[], &venv, stamp, None).await.is_err());
        assert!(apply(&[dir.join("沒有這支程式.exe").to_string_lossy().into_owned()], &venv, stamp, None).await.unwrap_err().contains("啟動"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 整段情境（不跑 uv）：0.0.7 的 App 裝好引擎 → 更新到 0.0.8（安裝目錄多了新版核心 + 外掛 wheel，舊 wheel 還在）
    /// → 第一次啟動引擎要換、換完不再換 → 之後 lock 也變了就交給完整重裝。
    #[test]
    fn app_update_scenario_refreshes_once_and_defers_lock_changes() {
        let dir = tmpdir("情境");
        let paths = pyenv::paths_under(&dir.join("data"));
        std::fs::create_dir_all(&paths.venv).unwrap();
        let res = dir.join("install").join("resources").join("engine");
        std::fs::create_dir_all(&res).unwrap();
        let lock = res.join(pyenv::LOCK_FILE);
        std::fs::write(&lock, b"numpy==2.4.6\n").unwrap();
        // 0.0.7 時代：App 安裝成功（.stamp = lock 的 hash），當時的 wheel 記在 .wheels
        pyenv::record_install_outcome(&paths.venv, Some(&lock), Some(0)).unwrap();
        std::fs::write(res.join("aivc-0.0.7-py3-none-any.whl"), b"core 7").unwrap();
        let v7 = stamp_text(&bundled_wheels(&res, "0.0.7"));
        std::fs::write(paths.venv.join(WHEELS_STAMP), &v7).unwrap();
        let state = |v: &str| {
            let b = stamp_text(&bundled_wheels(&res, v));
            let rec = std::fs::read_to_string(paths.venv.join(WHEELS_STAMP)).ok();
            let st = pyenv::stamp_state(&paths.venv, Some(&lock));
            (decide(&Inputs { release: true, managed: true, installing: false, stamp: &st, bundled: &b, recorded: rec.as_deref() }), b)
        };
        assert!(matches!(state("0.0.7").0, Decision::Skip(_)), "還沒更新：不動");

        // 更新到 0.0.8：NSIS /UPDATE 不刪舊檔
        std::fs::write(res.join("aivc-0.0.8-py3-none-any.whl"), b"core 8").unwrap();
        std::fs::write(res.join("aivc_cards-0.0.8-py3-none-any.whl"), b"cards 8").unwrap();
        let (d, b8) = state("0.0.8");
        assert_eq!(d, Decision::Refresh, "第一次啟動引擎要換");
        assert!(b8.contains("aivc-0.0.8") && b8.contains("aivc_cards-0.0.8") && !b8.contains("0.0.7"), "{b8}");
        // 換完（apply 成功會寫 .wheels）
        std::fs::write(paths.venv.join(WHEELS_STAMP), &b8).unwrap();
        assert!(matches!(state("0.0.8").0, Decision::Skip(_)), "換過就不再換");

        // 下一版連 lock 都變了：只換 wheel 會讓新程式碼跑在舊依賴上 → 不換，pyenv 會報 stale 請使用者完整重裝
        std::fs::write(&lock, b"numpy==2.5.0\n").unwrap();
        std::fs::write(res.join("aivc-0.0.9-py3-none-any.whl"), b"core 9").unwrap();
        assert!(matches!(state("0.0.9").0, Decision::Skip(w) if w.contains("lock")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
