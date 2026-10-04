/**
 * 助手工具的**顯示**名稱（zh key）。
 *
 * 跟 `catalogue.ts` 分開的理由很實際：catalogue 裡的 `describe` 是**寫給模型看的**
 * （`toolsPrompt` 直接送進 system prompt），從來不會顯示在畫面上，所以不需要、也不應該翻譯。
 * 但 i18n 稽核只認得「檔案」不認得「哪一個欄位」，整個 catalogue 進稽核清單的話
 * 會要求翻譯幾十條 prompt 文字。所以使用者看得到的那一半放這裡。
 */
export const TOOL_TITLE = {
  seek_to: "把播放線移到",
  set_range: "設定入出點",
  clear_range: "清除入出點",
  cut_range: "剪掉選取的範圍",
  split_at_playhead: "在播放線分割",
  split_at_shots: "在鏡頭切點分割",
  remove_silence: "移除靜音（開對話框）",
  remove_fillers: "移除語助詞（開對話框）",
  normalize_audio: "音量正規化",
  blur_background: "背景虛化 / 換色",
  remove_object: "移除物件",
  mark_subject: "描框 / 描邊標出來",
  find_subject: "用文字找目標",
  track_subject: "追蹤目標產生遮罩",
  auto_reframe: "自動重構圖（算路徑）",
  apply_reframe: "套用重構圖並輸出",
  cut_shot_at_playhead: "在播放線切鏡頭",
  export_video: "輸出影片（開對話框）",
  play_range: "播放這一段",
  undo: "復原上一步",
  generate_captions: "產生字幕（開對話框）",
  make_chapters: "AI 章節與摘要（開對話框）",
  find_highlights: "AI 精華片段（開對話框）",
  find_in_transcript: "在字幕裡找一句話",
  list_shots: "列出鏡頭",
  view_frame: "看一幀畫面",
  add_marker: "加標記",
  narrate: "AI 配音（開對話框）",
} as const;

export type ToolName = keyof typeof TOOL_TITLE;

/** 情境提示要看的狀態（由面板從 AssistantState 攤出來）。 */
export interface SuggestInput {
  hasCaptions: boolean;
  hasRange: boolean;
  shots: number;
  durationSeconds: number;
}

/**
 * 面板上的例句（zh key）：**跟著狀態走**，不是固定四句。
 *
 * 有選範圍時第一句就是「把選取的範圍剪掉」；沒有字幕時建議先產生字幕（章節、語助詞、找一句話都要它）；
 * 有字幕時換成那三件事。每一句都是點一下就填進輸入框、改幾個字就能送的樣子。
 *
 * 放這裡而不是面板裡：`t(變數)` 字面量掃描看不到，而這個檔在 check-i18n 的清單上 ——
 * 以後加例句忘了翻譯會被當場擋下來。最多 6 句：再多就沒有「建議」的意思了。
 */
export function suggestedPrompts(s: SuggestInput): string[] {
  const out: string[] = [];
  if (s.hasRange) out.push("把選取的範圍剪掉", "播放這一段");
  if (!s.hasCaptions) out.push("幫我產生字幕");
  else out.push("幫我分章節、寫摘要", "找出最精彩的幾段");
  if (s.shots > 1) out.push("在鏡頭切點分割");
  if (s.hasCaptions) out.push("把「呃」「嗯」那些語助詞拿掉", "跳到我講到「重點」的那句");
  out.push("幫我把背景虛化", "轉成直幅");
  if (!s.hasRange && s.durationSeconds > 4) out.push("把 2 到 4 秒剪掉");
  return out.slice(0, 6);
}
