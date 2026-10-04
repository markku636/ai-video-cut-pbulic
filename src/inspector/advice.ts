// 「建議」分頁的內容：依專案目前的狀態算出「有什麼問題、下一步可以做什麼」。純函式。
//
// 這個檔案在 check-i18n 的 TABLE_SOURCES：下面那張文字表的中文都是 zh key。
//
// ## 這不是語言模型
//
// 分頁原本是「AI 助手（M6）」的佔位，點進去只會看到「之後才會有」—— 那是一個死路。
// 在補上真正的自然語言助手之前，同一個位置放**規則式的檢查**：每一條都是從專案狀態
// 直接算出來的事實，不是猜的。面板裡也照實說明這件事，不要讓人以為是模型在講話。
//
// ## 每一條都要能「按下去就處理掉」
//
// 只說「有 3 條追蹤沒有遮罩」而不給入口，等於把人丟回去自己找。所以每一條盡量帶一個
// 指令 id，面板直接長出按鈕；真的沒有單一入口的才不給，
// 那時文字本身就要講清楚去哪裡做。
//
// ## 排序與上限
//
// 問題排在建議前面，同類依「影響多少東西」由大到小。最多 6 條：
// 一次列十幾條等於沒有排序，而使用者一次也只會處理一兩件事。
//
// ## 外掛的建議
//
// 外掛依自己的狀態算出條目（plugins/api.ts AdviceContribution，例如 cards 的「原牌要確認」「格位還沒指定牌」），
// 面板把它們放進 input.extra，這裡依 slot 排進固定的位置；「還沒有追蹤」的一鍵指令看工作模式（profile 的 detectCommand）。
import type { PluginAdviceItem } from "../plugins/api";
import { confidenceBand, type Solve } from "../store/solves";

export type AdviceKind = "problem" | "suggestion";

export type CoreAdviceCode = "engine-not-ready" | "no-media" | "no-tracks" | "track-stale" | "track-not-solved" | "track-low-confidence" | "track-no-mask" | "sequence-silence";
/** 核心的 code ＋ 外掛的 code（外掛的文字在外掛的 AdviceContribution.text）。 */
export type AdviceCode = CoreAdviceCode | (string & {});

export interface AdviceItem {
  code: AdviceCode;
  kind: AdviceKind;
  /** 給 t() 的變數（通常是 {n}）。 */
  params?: Record<string, string | number>;
  /** 一鍵處理的指令 id；沒有就只有說明。 */
  command?: string;
}

/** 面板一次最多列幾條。 */
export const MAX_ADVICE = 6;

/** 一條追蹤在建議裡需要知道的事（由面板從 store 攤平出來，這支才能是純的）。 */
export interface TrackFacts {
  id: string;
  label: string;
  /** 使用者改過關鍵幀 / 目標，還沒重解。 */
  stale: boolean;
  /** 有沒有解算結果。 */
  solved: boolean;
  /** 解算結果裡「紅燈」的幀數（信心 <0.35 或 lost）。 */
  lowConfidenceFrames: number;
  /** 有沒有物件遮罩。 */
  hasMask: boolean;
}

export interface AdviceInput {
  engineReady: boolean;
  hasMedia: boolean;
  /** 工作模式（外掛的建議看它決定談不談）。 */
  profile: string;
  /** 平面 track 的事實（物件 track 沒有解算 / 關鍵幀，不在這裡）。 */
  tracks: TrackFacts[];
  /** 物件 track 有幾條（有物件就不提「還沒有任何追蹤」）；省略 = 0。 */
  objects?: number;
  /** 序列裡「夠長可以剪」的靜音段數；沒有序列就 0。 */
  silentRanges: number;
  /** 「還沒有任何追蹤」的一鍵指令（工作模式的自動偵測）；沒有 = 新增追蹤。 */
  noTracksCommand?: string;
  /** 外掛算好的條目（依 slot 排進固定的位置）。 */
  extra?: readonly PluginAdviceItem[];
}

/** 紅燈幀多到這個數才值得提（零星幾幀是正常的，提了只會變成雜訊）。 */
export const LOW_CONF_FRAMES = 8;

export function adviceFor(input: AdviceInput): AdviceItem[] {
  const problems: AdviceItem[] = [];
  const suggestions: AdviceItem[] = [];

  if (!input.engineReady) problems.push({ code: "engine-not-ready", kind: "problem", command: "help.engineSetup" });
  if (!input.hasMedia) {
    // 沒有素材時其餘的檢查都沒有意義（全部是 0），列出來只會變成一整頁「沒有問題」
    problems.push({ code: "no-media", kind: "problem", command: "file.open" });
    return problems;
  }

  const extra = (slot: PluginAdviceItem["slot"]): AdviceItem[] => (input.extra ?? []).filter((x) => x.slot === slot).map(({ slot: _slot, ...rest }) => rest);
  const stale = input.tracks.filter((t) => t.stale).length;
  const unsolved = input.tracks.filter((t) => !t.solved).length;
  const shaky = input.tracks.filter((t) => t.solved && t.lowConfidenceFrames >= LOW_CONF_FRAMES).length;
  const noMask = input.tracks.filter((t) => t.solved && !t.hasMask).length;

  problems.push(...extra("head"));
  if (stale) problems.push({ code: "track-stale", kind: "problem", params: { n: stale }, command: "track.trackToEnd" });
  if (shaky) problems.push({ code: "track-low-confidence", kind: "problem", params: { n: shaky }, command: "playback.nextLowConfidence" });

  if (!input.tracks.length && !input.objects) suggestions.push({ code: "no-tracks", kind: "suggestion", command: input.noTracksCommand ?? "track.new" });
  if (unsolved) suggestions.push({ code: "track-not-solved", kind: "suggestion", params: { n: unsolved }, command: "track.trackToEnd" });
  suggestions.push(...extra("afterUnsolved"));
  if (noMask) suggestions.push({ code: "track-no-mask", kind: "suggestion", params: { n: noMask }, command: "mask.propagateBoth" });
  if (input.silentRanges) suggestions.push({ code: "sequence-silence", kind: "suggestion", params: { n: input.silentRanges }, command: "sequence.removeSilence" });
  suggestions.push(...extra("tail"));

  return [...problems, ...suggestions].slice(0, MAX_ADVICE);
}

/** 一條解算結果裡有幾幀是紅燈。解算不存在時回 0（那是「還沒解」，不是「解得爛」）。 */
export function lowConfidenceFrames(solve: Solve | undefined): number {
  if (!solve) return 0;
  return solve.frames.reduce((n, f) => n + (confidenceBand(f) === "bad" ? 1 : 0), 0);
}

/**
 * 每一條建議的文字（zh key；{n} 由 params 帶入）。標題一句、說明一句，說明要講「為什麼這是問題」。
 *
 * **刻意沒有按鈕文字**：按鈕直接用指令自己的標題（`cmd.title`）。在這裡再寫一份「追到尾」
 * 只會變成第二個要維護的地方，而且指令改名之後兩邊就不一樣了。
 */
export const ADVICE_TEXT: Record<CoreAdviceCode, { title: string; hint: string }> = {
  "engine-not-ready": {
    title: "引擎尚未啟動",
    hint: "偵測、追蹤、遮罩、輸出全部由引擎執行。沒有引擎的話這個畫面上大多數按鈕都會是灰的。",
  },
  "no-media": { title: "還沒開啟任何影片", hint: "開一支影片或既有的專案檔就可以開始。" },
  "no-tracks": {
    title: "這支影片還沒有任何追蹤",
    hint: "追蹤是「畫面上要跟著走的那一塊」。用「找物件」打字找出人臉、車牌、logo；平面（螢幕、海報）自己拖出四個角。",
  },
  "track-stale": {
    title: "{n} 條追蹤改過之後還沒重新解算",
    hint: "關鍵幀或參考影格改了，但解算結果還是舊的 —— 現在看到的位置不是最後會輸出的位置。",
  },
  "track-not-solved": {
    title: "{n} 條追蹤還沒解算",
    hint: "沒有解算就沒有逐幀的位置，輸出時這些追蹤會被略過。",
  },
  "track-low-confidence": {
    title: "{n} 條追蹤有一段信心偏低",
    hint: "信心低通常是動態模糊、被擋住、或反光。跳過去看一眼；真的歪掉就在那裡釘一個關鍵幀。",
  },
  "track-no-mask": {
    title: "{n} 條追蹤還沒有遮罩",
    hint: "沒有遮罩的話，手或其他東西經過時新的表面會蓋在上面，一看就是合成的。",
  },
  "sequence-silence": {
    title: "序列裡有 {n} 段夠長的靜音",
    hint: "可以一次剪掉，套用前會先算給你看會剪掉幾段、共多少時間。",
  },
};
