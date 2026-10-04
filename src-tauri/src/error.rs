use serde::Serialize;

/// 統一錯誤型別。對前端序列化成 `{ kind, code, message, status? }`。
///
/// `#[error(...)]` 為中性英文（Display / log 用）；使用者可見的 `message` 由 `message()` 產生（繁中）。
/// 引擎（Python sidecar）回的 `error.kind` 是 PascalCase
/// （`Invalid|Io|Ffmpeg|Canceled|Timeout|Gpu|Model|PyEnv|Engine|Internal`），
/// 由 `engine::wire_error_to_app` 映射進來；這裡的 `kind()` 維持 snake_case 給前端。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("ffmpeg error: {0}")]
    Ffmpeg(String),

    #[error("storage error: {0}")]
    Storage(String),

    #[error("agent error: {0}")]
    Agent(String),

    /// Python 引擎（sidecar）層的錯誤：行程死掉、協定不合、op 內部例外。
    #[error("engine error: {0}")]
    Engine(String),

    /// GPU / CUDA：不可用、OOM、arch 不符。
    #[error("gpu error: {0}")]
    Gpu(String),

    /// 受管 Python 環境：缺、壞、閘門未過、引導失敗。
    #[error("pyenv error: {0}")]
    PyEnv(String),

    #[error("canceled")]
    Canceled,

    #[error("timed out after {0} ms")]
    Timeout(u64),

    /// 對面（Python 引擎）說它逾時了：訊息是它給的（「ffprobe 超過 60s 沒回應」），我們不知道毫秒數。
    /// 分成兩個 variant 的理由：`Timeout(0)` 的 message() 是「逾時（0 ms）」，會把 Python 的死因整個吃掉（B-11）。
    /// 兩者刻意共用 `ERR_TIMEOUT` / kind `timeout`：對前端與 i18n 來說是同一類錯誤。
    #[error("timed out: {0}")]
    TimeoutMsg(String),

    #[error("invalid: {0}")]
    Invalid(String),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "not_found",
            AppError::Io(_) => "io",
            AppError::Ffmpeg(_) => "ffmpeg",
            AppError::Storage(_) => "storage",
            AppError::Agent(_) => "agent",
            AppError::Engine(_) => "engine",
            AppError::Gpu(_) => "gpu",
            AppError::PyEnv(_) => "pyenv",
            AppError::Canceled => "canceled",
            AppError::Timeout(_) | AppError::TimeoutMsg(_) => "timeout",
            AppError::Invalid(_) => "invalid",
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "ERR_NOT_FOUND",
            AppError::Io(_) => "ERR_IO",
            AppError::Ffmpeg(_) => "ERR_FFMPEG",
            AppError::Storage(_) => "ERR_STORAGE",
            AppError::Agent(_) => "ERR_AGENT",
            AppError::Engine(_) => "ERR_ENGINE",
            AppError::Gpu(_) => "ERR_GPU",
            AppError::PyEnv(_) => "ERR_PYENV",
            AppError::Canceled => "ERR_CANCELED",
            AppError::Timeout(_) | AppError::TimeoutMsg(_) => "ERR_TIMEOUT",
            AppError::Invalid(_) => "ERR_INVALID",
        }
    }

    /// HTTP status。A0 沒有任何遠端服務，一律 None；欄位保留是為了前端 `AppError` 型別不必分版本。
    pub fn status(&self) -> Option<u16> {
        None
    }

    pub fn message(&self) -> String {
        match self {
            AppError::NotFound(s) => format!("找不到：{s}"),
            AppError::Io(s) => format!("檔案讀寫錯誤：{s}"),
            AppError::Ffmpeg(s) => format!("ffmpeg 錯誤：{s}"),
            AppError::Storage(s) => format!("儲存錯誤：{s}"),
            AppError::Agent(s) => format!("AI 助手錯誤：{s}"),
            AppError::Engine(s) => format!("引擎錯誤：{s}"),
            AppError::Gpu(s) => format!("GPU 錯誤：{s}"),
            AppError::PyEnv(s) => format!("Python 環境：{s}"),
            AppError::Canceled => "已取消".to_string(),
            AppError::Timeout(ms) => format!("逾時（{ms} ms）"),
            AppError::TimeoutMsg(s) => format!("逾時：{s}"),
            AppError::Invalid(s) => s.clone(),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 4)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.message())?;
        s.serialize_field("status", &self.status())?;
        s.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            return AppError::Timeout(0);
        }
        // without_url：錯誤訊息不夾帶 URL（避免 query 或路徑洩漏到 log / toast）。
        AppError::Io(format!("HTTP：{}", e.without_url()))
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_has_a_code_and_kind() {
        let all = [
            AppError::NotFound("x".into()),
            AppError::Io("x".into()),
            AppError::Ffmpeg("x".into()),
            AppError::Storage("x".into()),
            AppError::Agent("x".into()),
            AppError::Engine("x".into()),
            AppError::Gpu("x".into()),
            AppError::PyEnv("x".into()),
            AppError::Canceled,
            AppError::Timeout(5),
            AppError::Invalid("x".into()),
            // TimeoutMsg 刻意與 Timeout 共用 ERR_TIMEOUT（同一類錯誤），所以不列進這個唯一性檢查
        ];
        let mut codes = std::collections::HashSet::new();
        for e in &all {
            assert!(e.code().starts_with("ERR_"), "{}", e.code());
            assert!(codes.insert(e.code()), "code 重複：{}", e.code());
            assert!(!e.kind().is_empty());
        }
    }

    #[test]
    fn serializes_to_the_shape_the_frontend_expects() {
        let v = serde_json::to_value(AppError::Engine("引擎死了".into())).unwrap();
        assert_eq!(v["kind"], "engine");
        assert_eq!(v["code"], "ERR_ENGINE");
        assert!(v["message"].as_str().unwrap().contains("引擎死了"));
        assert!(v["status"].is_null());
    }
}
