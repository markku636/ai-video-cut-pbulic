// V1 拖曳重新排序（docs/editor-m2-design.md §13 M2.later「V1 拖曳重新排序」）。
//
// 跟 trimDrag.ts / rangeDrag.ts 同一個契約：純函式、每次 update 都從拖曳開始時的 origin 序列重算（無狀態）。
// 拖曳中不碰 store（每個 pointermove 都寫會洗出幾百筆 undo），預覽只活在 FrameTimeline 的 ref 裡，
// 放開時才用最後的 toIndex 走一次 editSequence（一筆 undo）；Esc 直接丟掉預覽，store 從頭到尾沒被碰過。
//
// 為什麼要「抽掉自己之後再算插入點」：拖曳中的項目在視覺上已經離開原位，
// 若拿含它的陣列去比中點，游標還沒離開自己的格子就會算出換位，手感會抖。
import type { SequenceV2, VideoItemV2 } from "../project/format";
import { itemLength } from "../sequence/map";

export interface ReorderDrag {
  /** 被拖的項目（片段或空白都可以拖）。 */
  id: string;
  /** 拖曳開始時的索引；只用來算「搬了幾格」，位置一律從 origin 重算。 */
  fromIndex: number;
  /** 拖曳開始時的序列：每次 update 都拿它重算，拖過頭再拖回來不會累積誤差。 */
  origin: SequenceV2;
}

export interface ReorderPreview {
  /** 搬移後的索引（直接餵給 ops.moveItemTo）。 */
  toIndex: number;
  /** 預覽用的項目順序；還沒進 store。 */
  video: VideoItemV2[];
  /** 相對原位搬了幾格（負 = 往前）；0 = 還在原位，不必 commit。 */
  delta: number;
  /** 被拖的項目會落在哪一幀（序列幀）。拖曳中就畫這一條線，不重繪整個順序。 */
  insertFrame: number;
}

/** 開始拖：id 不在 V1 上就回 null（呼叫端當作沒有拖曳）。 */
export function beginReorderDrag(seq: SequenceV2, id: string): ReorderDrag | null {
  const fromIndex = seq.video.findIndex((it) => it.id === id);
  return fromIndex < 0 ? null : { id, fromIndex, origin: seq };
}

/**
 * 游標在序列幀 `frame` 時，被拖的項目該插在第幾格。
 *
 * 在**抽掉自己之後**的陣列上比每一格的中點：過了中點才換位，所以手感是「推開」而不是抖動。
 * 超出尾端就回最後一格。
 */
export function reorderTargetIndex(seq: SequenceV2, id: string, frame: number): number {
  const rest = seq.video.filter((it) => it.id !== id);
  let t = 0;
  for (let i = 0; i < rest.length; i++) {
    const len = itemLength(rest[i]);
    if (frame < t + len / 2) return i;
    t += len;
  }
  return Math.max(0, rest.length - 1);
}

/** 更新拖曳：回預覽用的順序與目標索引。不碰 store。 */
export function updateReorderDrag(drag: ReorderDrag, frame: number): ReorderPreview {
  const toIndex = reorderTargetIndex(drag.origin, drag.id, frame);
  const rest = drag.origin.video.filter((it) => it.id !== drag.id);
  const item = drag.origin.video[drag.fromIndex];
  const video = [...rest.slice(0, toIndex), item, ...rest.slice(toIndex)];
  let insertFrame = 0;
  for (let i = 0; i < toIndex; i++) insertFrame += itemLength(rest[i]);
  return { toIndex, video, delta: toIndex - drag.fromIndex, insertFrame };
}

/** 拖曳中的提示：往前 / 往後幾格，還在原位就不給字（不要為了「有東西」而吵）。 */
export function reorderTipText(delta: number, t: (zh: string, vars?: Readonly<Record<string, string | number>>) => string): string | null {
  if (!delta) return null;
  return delta < 0 ? t("往前 {n} 格", { n: -delta }) : t("往後 {n} 格", { n: delta });
}
