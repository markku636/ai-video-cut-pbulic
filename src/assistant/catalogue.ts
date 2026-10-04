/**
 * AI 助手能動的東西（工具表）。
 *
 * ## 為什麼是「精選」而不是「把指令登記表整份倒給模型」
 *
 * 登記表有兩百多個指令。整份丟過去有三個問題：吃掉大量 token、大部分與「幫我剪片」無關、
 * 而且**指令的 `run()` 不吃參數**（它們讀的是目前的播放線、選取、範圍），
 * 模型沒辦法用「把 12 秒到 20 秒剪掉」這種話直接對上任何一個指令。
 *
 * 所以工具表是手寫的，而且分三種：
 *
 * - `state`：先把狀態擺好（跳到某一秒、設定範圍、選片段）。**這是讓無參數指令變得可用的關鍵。**
 * - `command`：擺好狀態之後派發既有指令。權限檢查完全沿用 `enabled()` —— 不可以做的事，
 *   模型也一樣做不了，而且回給它的是同一句人話原因。
 * - `op`：直接呼叫引擎（背景虛化、移除物件、自動重構圖…）。這些本來就吃參數。
 * - `query`：只**查**不動（在字幕裡找一句話、列鏡頭）。模型看不到字幕全文與鏡頭表 —— 那會吃掉 context
 *   而且它會開始亂編時間 —— 所以給它查詢工具：它講要找什麼、我們回秒數，下一輪它再用 set_range / seek_to 接。
 *
 * ## 每一步都要人按過才會動
 *
 * 模型只產生**計畫**，`AssistantPanel` 列出來給人看，按了才執行（`danger` 的還會標紅）。
 * 理由不是不信任模型，是這些動作會改專案與寫檔案，而「看得懂正在發生什麼」本身就是功能的一部分。
 */
import type { Enabled } from "../commands/types";
import { TOOL_TITLE } from "./labels";

export type ToolKind = "state" | "command" | "op" | "query";

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  /** 沒給的話模型可以省略；執行時用 `fallback`（沒有就讓引擎 / 指令自己決定預設）。 */
  required?: boolean;
  describe: string;
  /** 只能是這幾個值。 */
  choices?: readonly string[];
  min?: number;
  max?: number;
}

export interface ToolSpec {
  /** 給模型的名字：小寫底線，穩定不變（改名等於換一個工具）。 */
  name: string;
  kind: ToolKind;
  /** 人看的標題（zh key）。 */
  title: string;
  /** 一句話告訴模型**什麼時候**用它。寫得好壞直接決定計畫對不對。 */
  describe: string;
  params: ToolParam[];
  /** 對應的指令 id（`kind: "command"`）或引擎 op（`kind: "op"`）。 */
  target?: string;
  /** 會改專案或寫檔案：計畫上標紅，而且永遠要人按過。 */
  danger?: boolean;
}

/**
 * 工具表。
 *
 * 排序照「使用者會怎麼講」：先定位（跳到哪、選哪段），再剪輯，最後是影像處理（OpenCV 那一批）。
 */
export const TOOLS: readonly ToolSpec[] = [
  // ---- 定位：讓後面那些無參數的指令有東西可以作用 ----
  {
    name: "seek_to",
    kind: "state",
    title: TOOL_TITLE.seek_to,
    describe: "把播放線移到指定的秒數或幀號。要對某一個時間點做事時先用它。",
    params: [
      { name: "seconds", type: "number", describe: "秒（與 frame 二選一）", min: 0 },
      { name: "frame", type: "number", describe: "幀號（與 seconds 二選一）", min: 0 },
    ],
  },
  {
    name: "set_range",
    kind: "state",
    title: TOOL_TITLE.set_range,
    describe: "選取一段時間（入點到出點）。使用者說「把 12 秒到 20 秒…」時先用它，再接剪輯或影像處理的工具。",
    params: [
      { name: "start_seconds", type: "number", required: true, describe: "起點（秒，含）", min: 0 },
      { name: "end_seconds", type: "number", required: true, describe: "終點（秒，不含）", min: 0 },
    ],
  },
  { name: "clear_range", kind: "state", title: TOOL_TITLE.clear_range, describe: "取消目前選取的範圍。", params: [] },
  {
    name: "find_in_transcript",
    kind: "query",
    title: TOOL_TITLE.find_in_transcript,
    describe: "在字幕裡找一句話，回報它出現的秒數。使用者說「跳到我講 XX 的地方」「把我講 XX 那段剪掉」時先用它；結果會以「執行結果」回給你，下一輪再用 seek_to / set_range 接。需要先有字幕。",
    params: [{ name: "text", type: "string", required: true, describe: "要找的字（字幕裡出現的原話，不用完整一句）" }],
  },
  {
    name: "list_shots",
    kind: "query",
    title: TOOL_TITLE.list_shots,
    describe: "列出偵測到的每個鏡頭的起訖秒數。使用者說「第二個鏡頭」「最後一個鏡頭」時先用它拿到秒數，下一輪再 set_range。",
    params: [],
  },
  {
    name: "view_frame",
    kind: "query",
    title: TOOL_TITLE.view_frame,
    describe:
      "把某一幀存成圖給你看（看得到圖的模型會直接收到那張圖）。要知道畫面上有什麼、東西在哪裡、找到／追蹤的結果對不對時用它；grid=true 會疊 0–1000 的座標格線，讀座標用。沒給 frame / seconds 就是播放線那一幀。",
    params: [
      { name: "frame", type: "number", describe: "幀號（與 seconds 二選一）", min: 0 },
      { name: "seconds", type: "number", describe: "秒（與 frame 二選一）", min: 0 },
      { name: "grid", type: "boolean", describe: "疊 0–1000 座標格線（預設 true）" },
    ],
  },
  {
    name: "add_marker",
    kind: "state",
    title: TOOL_TITLE.add_marker,
    describe: "在指定的秒數加一個標記（可以取名）。使用者說「在 12 秒做個記號」「標一下這裡」時用它；「這裡」＝目前播放線的秒數（狀態裡有）。",
    params: [
      { name: "seconds", type: "number", required: true, describe: "秒", min: 0 },
      { name: "name", type: "string", describe: "標記的字（選填）" },
    ],
    danger: true,
  },

  // ---- 剪輯 ----
  {
    name: "cut_range",
    kind: "command",
    target: "sequence.extractRange",
    title: TOOL_TITLE.cut_range,
    describe: "把入出點之間那一段從序列上刪掉並把空隙接起來（波紋刪除）。要先有範圍。",
    params: [],
    danger: true,
  },
  {
    name: "split_at_playhead",
    kind: "command",
    target: "sequence.split",
    title: TOOL_TITLE.split_at_playhead,
    describe: "在播放線的位置把片段切一刀。",
    params: [],
    danger: true,
  },
  {
    name: "split_at_shots",
    kind: "command",
    target: "sequence.splitAtShots",
    title: TOOL_TITLE.split_at_shots,
    describe: "在偵測到的每一個鏡頭切換處都切一刀。",
    params: [],
    danger: true,
  },
  {
    name: "remove_silence",
    kind: "command",
    target: "sequence.removeSilence",
    title: TOOL_TITLE.remove_silence,
    describe: "打開「移除靜音」對話框讓使用者調參數並預覽。不會直接剪。",
    params: [],
  },
  {
    name: "remove_fillers",
    kind: "command",
    target: "sequence.removeFillers",
    title: TOOL_TITLE.remove_fillers,
    describe: "打開「移除語助詞」對話框（呃、嗯、重複的字），逐段勾選後才剪。需要先有字幕。",
    params: [],
  },
  {
    name: "normalize_audio",
    kind: "command",
    target: "sequence.normalizeAudio",
    title: TOOL_TITLE.normalize_audio,
    describe: "把選取片段的音量推到一致的響度。要先選片段。",
    params: [],
    danger: true,
  },

  // ---- 影像處理（OpenCV / 模型那一批）----
  {
    name: "blur_background",
    kind: "op",
    target: "bg.blur",
    title: TOOL_TITLE.blur_background,
    describe: "主體留著、背景糊掉或換成純色（人像模式）。需要主體的逐幀遮罩，所以通常先用 find_subject。",
    params: [
      { name: "masks", type: "string", required: true, describe: "主體遮罩檔（.aivm）的路徑；find_subject 會回傳" },
      { name: "out", type: "string", describe: "輸出影片的完整路徑；留空＝自動放到輸出資料夾（建議留空，你不知道使用者的資料夾在哪）" },
      { name: "strength", type: "number", describe: "虛化強度＝畫面寬度的百分比（預設 1.5）", min: 0.1, max: 8 },
      { name: "color", type: "string", describe: "改成換純色背景，寫成 \"R,G,B\"（0-255）；給了就不虛化" },
      { name: "frames", type: "string", describe: "只處理這段 proxy 幀，寫成 \"K0:K1\"" },
    ],
    danger: true,
  },
  {
    name: "remove_object",
    kind: "op",
    target: "inpaint.remove",
    title: TOOL_TITLE.remove_object,
    describe: "把遮罩裡的東西從畫面上拿掉，用其他幀真正拍到的背景補回來。要靜止機位。",
    params: [
      { name: "masks", type: "string", required: true, describe: "物件遮罩檔（.aivm）的路徑" },
      { name: "out", type: "string", describe: "輸出影片的完整路徑；留空＝自動放到輸出資料夾（建議留空）" },
      { name: "frames", type: "string", describe: "只處理這段 proxy 幀，寫成 \"K0:K1\"" },
    ],
    danger: true,
  },
  {
    name: "mark_subject",
    kind: "op",
    target: "bg.mark",
    title: TOOL_TITLE.mark_subject,
    describe: "把追蹤到的東西標出來疊在畫面上（圈重點）：沿輪廓描邊、外接方框、或半透明填色。需要主體的逐幀遮罩，所以先 find_subject 再 track_subject。",
    params: [
      { name: "masks", type: "string", required: true, describe: "目標遮罩檔（.aivm）的路徑" },
      { name: "mode", type: "string", describe: "怎麼標（預設描邊）", choices: ["contour", "box", "fill"] },
      { name: "color", type: "string", describe: "顏色，寫成 \"R,G,B\"（0-255，預設紅 255,64,64）" },
      { name: "opacity", type: "number", describe: "填色的不透明度 0-1（只有 fill 用得到，預設 0.28）", min: 0, max: 1 },
      { name: "out", type: "string", describe: "輸出影片；留空＝自動（建議留空）" },
      { name: "frames", type: "string", describe: "只處理這段 proxy 幀，寫成 \"K0:K1\"" },
    ],
    danger: true,
  },
  {
    name: "find_subject",
    kind: "op",
    target: "seg.text_boxes",
    title: TOOL_TITLE.find_subject,
    describe: "在某一幀用一個英文詞找出目標的框（person、hand、logo…）。找到之後要用 track_subject 產生逐幀遮罩。",
    params: [
      { name: "text", type: "string", required: true, describe: "要找什麼，英文通常比較準" },
      { name: "frame", type: "number", required: true, describe: "在哪一幀找（取範圍中點比第一幀可靠）", min: 0 },
    ],
  },
  {
    name: "track_subject",
    kind: "op",
    target: "seg.run",
    title: TOOL_TITLE.track_subject,
    describe: "從 find_subject 的框出發，逐幀傳播出遮罩檔。背景虛化與移除物件都要它。",
    params: [
      { name: "box", type: "string", required: true, describe: "框，寫成 \"x0,y0,x1,y1\"" },
      { name: "frames", type: "string", required: true, describe: "追哪一段，寫成 \"K0:K1\"" },
      { name: "anchor", type: "number", required: true, describe: "從哪一幀開始傳播（就是 find_subject 用的那一幀）", min: 0 },
    ],
  },
  {
    name: "auto_reframe",
    kind: "op",
    target: "reframe.plan",
    title: TOOL_TITLE.auto_reframe,
    describe: "第一步：算出鏡頭要怎麼跟著主體走（橫幅 → 直幅／方形）。這一步**還不會產生影片**，算完要接 apply_reframe。**它一定處理整支影片、不吃入出點**——使用者說「把某一段轉成直幅」時要先講清楚這件事，不要先 set_range 讓人以為只做那一段。",
    params: [
      { name: "aspect", type: "string", required: true, describe: "目標比例", choices: ["9:16", "1:1", "4:5", "16:9"] },
      { name: "text", type: "string", describe: "主體是什麼（預設自動找人）" },
      { name: "out", type: "string", describe: "路徑檔要寫到哪；留空＝自動（建議留空）" },
    ],
  },
  {
    name: "apply_reframe",
    kind: "op",
    target: "reframe.apply",
    title: TOOL_TITLE.apply_reframe,
    describe: "第二步：把上一步算好的路徑套成真正的影片。要等 auto_reframe 執行完、拿到路徑檔之後才規劃得出來。",
    params: [
      { name: "path", type: "string", required: true, describe: "auto_reframe 回傳的 *.reframe.json" },
      { name: "out", type: "string", describe: "輸出影片；留空＝自動（建議留空）" },
    ],
    danger: true,
  },
  {
    name: "cut_shot_at_playhead",
    kind: "command",
    target: "edit.shotCutAt",
    title: TOOL_TITLE.cut_shot_at_playhead,
    describe: "在播放線的位置手動切一個鏡頭邊界。鏡頭本身在引擎就緒後會自動偵測，這支是要手動補的時候用。",
    params: [],
    danger: true,
  },
  // ---- 輸出與收尾：使用者講完想做的事之後，下一句幾乎都是這幾個 ----
  {
    name: "export_video",
    kind: "command",
    target: "export.video",
    title: TOOL_TITLE.export_video,
    describe: "打開輸出對話框（挑格式、畫質、範圍）。使用者說「輸出」「匯出」「存成 mp4」時用它。真正的輸出由使用者在對話框裡按。",
    params: [],
  },
  {
    name: "play_range",
    kind: "command",
    target: "playback.playRange",
    title: TOOL_TITLE.play_range,
    describe: "播放入出點之間那一段，讓使用者先聽看看再決定要不要剪。要先有範圍。",
    params: [],
  },
  {
    name: "undo",
    kind: "command",
    target: "edit.undo",
    title: TOOL_TITLE.undo,
    describe: "復原上一步。使用者說「取消剛剛那個」「還原」時用它；一次只退一步，要退多步就規劃多個 undo。",
    params: [],
  },
  {
    name: "generate_captions",
    kind: "command",
    target: "captions.generate",
    title: TOOL_TITLE.generate_captions,
    describe: "打開字幕對話框（本機語音辨識）。移除語助詞需要先有字幕。",
    params: [],
  },
  {
    name: "make_chapters",
    kind: "command",
    target: "captions.chapters",
    title: TOOL_TITLE.make_chapters,
    describe: "打開「AI 章節與摘要」對話框：從字幕整理出章節標記、影片摘要、標題與 YouTube 章節文字。需要先有字幕。使用者說「分章節」「做摘要」「YouTube 章節」「幫我想標題」時用它。",
    params: [],
  },
  {
    name: "find_highlights",
    kind: "command",
    target: "ai.highlights",
    title: TOOL_TITLE.find_highlights,
    describe: "打開「AI 精華片段」對話框：從字幕挑出最值得單獨拿出來的幾段（短影音候選），可以加標記、只留這幾段、或逐段輸出。需要先有字幕。使用者說「找精華」「最精彩的地方」「剪成短影音」「哪幾段值得拿出來」時用它。",
    params: [],
  },
  {
    name: "narrate",
    kind: "state",
    title: TOOL_TITLE.narrate,
    describe: "打開「AI 配音」對話框並填好要唸的字（文字轉語音，合成的旁白放到播放線的音軌）。使用者說「幫我唸／配音／加旁白：…」時用它，把要唸的字放進 text；沒講要唸什麼就留空（會帶播放線上的字幕那句）。",
    params: [{ name: "text", type: "string", describe: "要唸的字（選填）" }],
  },
];

/** 依名字查工具；查不到回 null（呼叫端要講「不認得這個工具」而不是默默跳過）。 */
export function toolByName(name: string): ToolSpec | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

/**
 * 給模型看的工具說明（純文字）。
 *
 * 刻意不用 JSON Schema：本機小模型對 schema 的遵從度參差，而**這份說明同時是給人看的**
 * —— 助手面板的「它能做什麼」直接用同一份，不會兩邊講的不一樣。
 */
export function toolsPrompt(tools: readonly ToolSpec[] = TOOLS): string {
  return tools
    .map((t) => {
      const ps = t.params
        .map((p) => {
          const bits: string[] = [p.type];
          if (p.choices) bits.push(p.choices.join(" | "));
          if (p.min != null || p.max != null) bits.push(`${p.min ?? ""}..${p.max ?? ""}`);
          if (!p.required) bits.push("選填");
          return `    ${p.name} (${bits.join(", ")}): ${p.describe}`;
        })
        .join("\n");
      return `- ${t.name}${t.danger ? " [會改東西]" : ""}: ${t.describe}${ps ? `\n${ps}` : ""}`;
    })
    .join("\n");
}

/** 執行時查得到的「這個指令現在能不能按」。由呼叫端注入，純函式層才不必碰 store。 */
export type EnabledLookup = (commandId: string) => Enabled | null;
