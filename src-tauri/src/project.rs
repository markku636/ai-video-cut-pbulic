//! 專案檔（`*.aivc.json`）讀寫：原子寫入、大小上限。內容結構由前端 `project/format.ts` 定義
//! （`migrate.ts` 負責升版），後端只當 JSON 搬運工（不解析），前端 schema 升級不需動 Rust。
//! v1 沒有專案 sidecar：遮罩 / 解算 / proxy 全在快取目錄，缺了就標 `stale` 重生。
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// 64 MB：向量資料（關鍵幀 / 提示點 / 格位）遠不到這個量；超過幾乎一定是有人把光柵塞進專案檔。
const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 原子寫入（`store::write_atomic`：唯一 tmp、同路徑排隊、失敗清 tmp）。自動儲存、Ctrl+S、
/// 引擎 op 前的 projectFileFor 可能同時寫同一個檔，後呼叫的那份留在磁碟上。
pub async fn save(path: &str, value: &serde_json::Value) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Storage(format!("序列化專案失敗：{e}")))?;
    crate::store::write_atomic(&PathBuf::from(path), bytes).await.map_err(|(stage, e)| {
        AppError::Storage(match stage {
            crate::store::WriteStage::Write => format!("寫入專案失敗：{e}"),
            crate::store::WriteStage::Replace => format!("更新專案檔失敗：{e}"),
        })
    })
}

pub async fn load(path: &str) -> AppResult<serde_json::Value> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::NotFound(format!("{path}：{e}")))?;
    if meta.len() > MAX_BYTES {
        return Err(AppError::Invalid(format!("專案檔過大（{} MB），拒絕載入", meta.len() / 1024 / 1024)));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| AppError::Storage(format!("讀取專案失敗：{e}")))?;
    serde_json::from_slice(&bytes).map_err(|e| AppError::Storage(format!("專案檔不是合法 JSON：{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn roundtrip_keeps_key_order_and_is_opaque() {
        // 路徑刻意含空白與中文：`01 qen3_tts` 這種目錄就是我們的日常
        let dir = std::env::temp_dir().join(format!("aivc proj 測試-{}", uuid::Uuid::new_v4()));
        let p = dir.join("sub").join("a.aivc.json");
        let doc: serde_json::Value =
            serde_json::from_str(r#"{"schemaVersion":1,"zeta":1,"alpha":{"tracks":[]},"app":"AI Video Cut"}"#).unwrap();
        save(p.to_str().unwrap(), &doc).await.unwrap();
        let back = load(p.to_str().unwrap()).await.unwrap();
        assert_eq!(back, doc);
        // preserve_order：鍵序照原樣寫回，diff 才好讀
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.find("zeta").unwrap() < text.find("alpha").unwrap());
        assert!(!dir.join("sub").join("a.aivc.json.tmp").exists(), ".tmp 要 rename 掉");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tmp_leftovers(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    /// 自動儲存和 Ctrl+S（或 projectFileFor 在匯出前的存檔）撞在一起：兩筆 project_save 同時在跑。
    /// 舊版共用固定的 `{path}.tmp`，先 rename 的那筆把 tmp 搬走，另一筆就 os error 2
    /// （改前實測：400 筆存檔失敗 197 筆、200 輪有 147 輪磁碟上留的是先呼叫的那份）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn overlapping_saves_never_fail_and_the_later_call_wins() {
        let dir = std::env::temp_dir().join(format!("aivc proj 測試-{}", uuid::Uuid::new_v4()));
        let p = dir.join("專案 race.aivc.json");
        let path = p.to_str().unwrap().to_string();
        let doc = |tag: &str, n: usize| {
            let kfs: Vec<serde_json::Value> =
                (0..n).map(|i| serde_json::json!({"frame": i, "quad": [[1.5, 2.5], [3.5, 4.5], [5.5, 6.5], [7.5, 8.5]]})).collect();
            serde_json::json!({"schemaVersion": 1, "tag": tag, "tracks": {"m1": [{"id": "t1", "keyframes": kfs}]}})
        };
        // 長度不同：編輯落在兩次存檔之間的情況（撕裂的檔會解析失敗）
        let (a, b) = (doc("autosave", 300), doc("ctrl-s", 200));
        let rounds = 200;
        let (mut failed, mut unparseable, mut wrong_winner) = (0, 0, 0);
        let mut first_err = None;
        for _ in 0..rounds {
            let (ra, rb) = tokio::join!(save(&path, &a), save(&path, &b));
            for r in [ra, rb] {
                if let Err(e) = r {
                    failed += 1;
                    first_err.get_or_insert_with(|| e.to_string());
                }
            }
            match std::fs::read(&p).ok().and_then(|x| serde_json::from_slice::<serde_json::Value>(&x).ok()) {
                Some(v) if v["tag"] == "ctrl-s" => {}
                Some(_) => wrong_winner += 1,
                None => unparseable += 1,
            }
        }
        let leftovers = tmp_leftovers(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            (failed, unparseable, wrong_winner, leftovers.len()),
            (0, 0, 0, 0),
            "{rounds} 輪：失敗 {failed}、壞檔 {unparseable}、不是後呼叫的那份 {wrong_winner}、殘留 tmp {leftovers:?}；例：{first_err:?}"
        );
    }

    /// rename 失敗（這裡用「目標是資料夾」逼它失敗）不可在使用者的專案資料夾留下 tmp 垃圾。
    #[tokio::test]
    async fn failed_replace_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("aivc proj 測試-{}", uuid::Uuid::new_v4()));
        let p = dir.join("被資料夾佔住.aivc.json");
        std::fs::create_dir_all(p.join("inner")).unwrap();
        let doc = serde_json::json!({"schemaVersion": 1});
        assert!(matches!(save(p.to_str().unwrap(), &doc).await, Err(AppError::Storage(_))));
        let leftovers = tmp_leftovers(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(leftovers.is_empty(), "殘留 tmp：{leftovers:?}");
    }

    /// 引擎（Python `read_text`）或防毒剛好開著專案檔時，Windows 的 replace 會 os error 5。
    /// 讀取只佔用幾十毫秒：等它放手再換，不要把「存檔失敗」丟給使用者。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replace_waits_out_a_short_lived_reader() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("aivc proj 測試-{}", uuid::Uuid::new_v4()));
        let p = dir.join("引擎正在讀.aivc.json");
        save(p.to_str().unwrap(), &serde_json::json!({"v": 1})).await.unwrap();
        // FILE_SHARE_READ only：跟 CPython open() 一樣不給 FILE_SHARE_DELETE
        let reader = std::fs::OpenOptions::new().read(true).share_mode(0x1).open(&p).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _r = reader;
            let _ = rx.recv_timeout(std::time::Duration::from_millis(80));
        });
        let res = save(p.to_str().unwrap(), &serde_json::json!({"v": 2})).await;
        let _ = tx.send(());
        holder.join().unwrap();
        let back = load(p.to_str().unwrap()).await;
        let _ = std::fs::remove_dir_all(&dir);
        res.unwrap();
        assert_eq!(back.unwrap(), serde_json::json!({"v": 2}));
    }

    #[tokio::test]
    async fn missing_file_is_not_found_and_junk_is_storage_error() {
        let dir = std::env::temp_dir().join(format!("aivc-proj-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("nope.aivc.json");
        assert!(matches!(load(missing.to_str().unwrap()).await, Err(AppError::NotFound(_))));
        let junk = dir.join("junk.aivc.json");
        std::fs::write(&junk, b"{not json").unwrap();
        assert!(matches!(load(junk.to_str().unwrap()).await, Err(AppError::Storage(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
