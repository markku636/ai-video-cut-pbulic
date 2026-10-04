// 命名一次定死（計畫決策 1）：產品 "AI Video Cut"、identifier net.markkulab.aivideocut、CLI/套件 aivc、
// env AIVC_、keychain service "ai-video-cut"、專案檔 *.aivc.json、localStorage 前綴 aivc:。
// ai-music-cut 有六個不一致的名字（AI Music Cut / AI Podcast Cut / aicut / aimusiccut…），這裡不重蹈。
export const APP_NAME = "AI Video Cut";
export const APP_ID = "net.markkulab.aivideocut";
export const REPO_URL = "https://github.com/markku636/ai-video-cut-pbulic";
/** 部落格上的工具介紹頁（有安裝說明與截圖；Release 頁對非工程師只是一串檔名）。 */
export const TOOL_PAGE_URL = "https://blog.markkulab.net/tools/ai-video-cut";
/** 專案檔副檔名（含點）；`kindOf()` / 拖放過濾 / 另存都認這一個。 */
export const PROJECT_EXT = ".aivc.json";
/** 影片容器：WebView2 只播 proxy.mp4（引擎產生），來源容器不限。 */
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "mts", "m2ts", "flv", "wmv"];
/** 素材圖片（替換圖、貼圖；外掛的素材匯入也用這一份）。 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "svg"];

export function isVideoPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.includes(ext);
}

export function isProjectPath(p: string): boolean {
  return p.toLowerCase().endsWith(PROJECT_EXT);
}
