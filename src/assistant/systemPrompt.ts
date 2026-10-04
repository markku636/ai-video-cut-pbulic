/**
 * 給模型的 system prompt。
 *
 * 兩個刻意的決定：
 *
 * 1. **工具表用同一份**（`toolsPrompt`）—— 面板的「它能做什麼」與模型看到的是同一段文字，
 *    不會養出「說明寫了但模型不知道」或反過來的情況。
 * 2. **把目前的狀態一起講**（影片多長、有沒有字幕、有沒有範圍）。少了這個，模型只能瞎猜，
 *    例如把 `set_range` 設到影片長度之外、或在沒有字幕時叫使用者去移除語助詞。
 */
import { toolsPrompt } from "./catalogue";

export interface AssistantState {
  /** 影片檔名（給模型講話時引用；路徑由執行層補，模型不該碰）。 */
  name: string;
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  /** 目前的入出點（秒）；null = 沒有。 */
  range: { start: number; end: number } | null;
  /** 播放線（秒）：使用者說「這裡」「從這裡開始」指的就是它。 */
  playheadSeconds: number;
  /** 序列上的標記數。 */
  markers: number;
  hasCaptions: boolean;
  hasSequence: boolean;
  shots: number;
  /**
   * 輸出資料夾。**刻意不進 prompt**：所有 `out` 參數都由執行層算（`run.opArgs`），
   * 讓模型看到它只會誘導它去編一個路徑 —— 而它編的一定不如 App 算的準。
   * 欄位留著是因為面板與測試還在用它描述目前的專案。
   */
  outDir: string;
}

/** 狀態摘要：短、而且只講模型真的會用到的事實。 */
export function stateBlock(s: AssistantState): string {
  const lines = [
    `檔名：${s.name}`,
    `長度：${s.durationSeconds.toFixed(1)} 秒（${s.fps.toFixed(2)} fps、${s.width}×${s.height}）`,
    `目前範圍：${s.range ? `${s.range.start.toFixed(1)}–${s.range.end.toFixed(1)} 秒` : "沒有"}`,
    `播放線：${s.playheadSeconds.toFixed(1)} 秒（使用者說「這裡」就是這個時間）`,
    `標記：${s.markers} 個`,
    `字幕：${s.hasCaptions ? "有" : "沒有"}`,
    `序列：${s.hasSequence ? "有" : "還沒建立（剪輯類的工具會自動建）"}`,
    `鏡頭：${s.shots} 個`,
  ];
  return lines.join("\n");
}

/**
 * CLI 後端（claude / codex 經 App 的 MCP server 直接呼叫工具）的系統提示：只放**這一刻的狀態**與幾條這個 App 特有的規矩。
 * 工具清單與操作守則不在這裡 —— 工具走 MCP 的 tools/list，守則走 MCP `initialize` 的 instructions（mcp.rs INSTRUCTIONS），
 * 兩邊各一份、不重複。也不要 JSON 計畫格式：CLI 自己就是工具迴圈。
 */
export function cliSystemPrompt(s: AssistantState | null, lang: string): string {
  const reply = lang.startsWith("en") ? "Reply in English." : "用繁體中文回答（台灣用語）。";
  const state = s ? `## 目前這支影片（每一輪送出時的狀態）\n\n${stateBlock(s)}` : "## 目前沒有開啟任何影片\n\n需要影片的工具都會失敗；請使用者先開一支影片。";
  return `你是 AI Video Cut 這套影片工具裡的助手，透過 aivc 這組 MCP 工具直接操作 App。${reply}

${state}

## 規矩

- 直接呼叫工具做事，不需要回 JSON 計畫。標著「會改東西」的工具，App 會先問使用者；被拒絕就停下來問他。
- 輸出檔要放哪不用你決定：out 參數一律留空，App 會照使用者的設定算好。
- 不知道一句話在第幾秒就用 find_in_transcript，不知道鏡頭的秒數就用 list_shots，要看畫面就用 view_frame；不要猜。
- 你沒有這台電腦的檔案權限，只能用 aivc 的工具；工具做不到的事就老實說。`;
}

export function systemPrompt(s: AssistantState): string {
  return `你是 AI Video Cut 這套影片剪輯軟體裡的助手。使用者用中文跟你講他想做什麼，你把它拆成一份**計畫**。

## 目前這支影片

${stateBlock(s)}

## 你可以用的工具

${toolsPrompt()}

## 回覆格式

**只回一個 JSON 物件**，不要有其他文字：

{"say": "用一兩句中文說明你要做什麼", "steps": [{"tool": "工具名", "args": {...}}]}

- 不需要動任何東西時（使用者只是在問問題），回 {"say": "你的回答", "steps": []}。
- 步驟會**照順序**執行，而且它們常常互相依賴：要對某一段做事，先 set_range 再接後面的工具。
- 需要遮罩的工具（blur_background、remove_object）要先 find_subject 再 track_subject。
  這幾步互相依賴（後面那步要前面那步算出來的框與遮罩路徑），而你在規劃的當下還沒有那些值，
  所以**一次只規劃到需要那個值為止**；使用者按了執行之後，結果會以
  「執行結果：…」回給你，那時候再規劃下一步。
- 要找使用者講到某句話的時間，用 find_in_transcript（要先有字幕）；要知道某個鏡頭的秒數，用 list_shots。
  這兩個只是查詢，結果會以「執行結果：…」回給你，那時候再規劃 seek_to / set_range / cut_range。
  **不要自己猜一句話出現在第幾秒。**
- **輸出檔要放哪不用你決定**：所有 out 參數都可以留空，App 會照使用者的設定算好。
  除非使用者自己指定了路徑，否則不要編一個 —— 你不知道他的資料夾長什麼樣。
- 不確定使用者要什麼的時候，用 say 問清楚、steps 留空，不要猜著做。
- 只能用上面列出來的工具。沒有的功能就在 say 裡老實說做不到。`;
}
