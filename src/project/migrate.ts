import { isRecord, ProjectFormatError, SCHEMA_VERSION } from "./format";

/**
 * 專案檔升版（計畫 §5.6、§12「專案 schema 變動」）。
 *
 * ai-music-cut 到 v0.136 都沒有 migrate：`format.ts:71-72` 看到版本不對就直接擲錯，等於「舊檔打不開、
 * 新檔也打不開」。影片專案的 schema 會更常變（每個里程碑都在加欄位），所以第一天就有這一層：
 * 依 `schemaVersion` **逐步**升到目前版本，只在版本**大於**目前才擲錯（那是未來的 App 寫的檔，我們不懂）。
 *
 * 每一步是一支純函式 `(doc) => doc`，只動它負責的那一版；新版本＝多加一支 step，舊的不改。
 * 這裡**不驗證內容**（那是 sanitize 的事），只把形狀搬到位。
 */

export type MigrationStep = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * 0 / undefined → 1：ai-music-cut 風格的骨架（`media` 陣列、沒有 schemaVersion）搬成 v1 的空專案。
 * profile 缺的話留給 sanitize（不認得 / 沒寫 → 外掛宣告的 legacy 工作模式，沒有就 generic）；
 * 外掛的頂層鍵（例如 cardSlots）缺的話由外掛的 sanitize 補，這裡不知道也不寫死。
 */
const toV1: MigrationStep = (doc) => {
  const media = Array.isArray(doc.media) ? doc.media : [];
  return {
    ...doc,
    schemaVersion: 1,
    media: media.map((m) => (isRecord(m) ? { proxy: null, ...m } : m)),
    shots: isRecord(doc.shots) ? doc.shots : {},
    tracks: isRecord(doc.tracks) ? doc.tracks : {},
    // insertDefaults / exportDefaults 缺的話留給 sanitize 補預設，這裡不重複寫死一份
  };
};

/**
 * 1 → 2：只加兩個鍵（docs/editor-m2-design.md §4.1）。隱含序列（null）就是 v1 的行為，所以不需要任何 proxy 幀數也能升。
 *
 * 刻意**不**在升版時就產生一條「整段片段」的序列：v1 檔的 `media[].proxy` 可能是 null（幀數未知），硬產一條會需要
 * 哨兵值（`srcOut: null`），而哨兵值會滲進每一個剪輯函式。第一次剪輯時才在 edits 裡實體化（那時 proxy 一定就緒）。
 * 已經有 sequence / audioMedia 的（手改過、或未來版本降回來的）原樣留著，交給 sanitize 驗。
 */
const toV2: MigrationStep = (doc) => ({
  ...doc,
  schemaVersion: 2,
  sequence: isRecord(doc.sequence) ? doc.sequence : null,
  audioMedia: Array.isArray(doc.audioMedia) ? doc.audioMedia : [],
});

/** index = 目標版本：STEPS[1] 把 0 升到 1、STEPS[2] 把 1 升到 2… */
const STEPS: Record<number, MigrationStep> = {
  1: toV1,
  2: toV2,
};

export interface MigrateResult {
  doc: Record<string, unknown>;
  /** 從哪一版升上來（= 目前版本表示沒動）。 */
  from: number;
  applied: number[];
}

function readVersion(doc: Record<string, unknown>): number {
  const v = doc.schemaVersion;
  if (v === undefined || v === null) return 0;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  throw new ProjectFormatError(`專案檔的 schemaVersion 不是整數：${String(v)}`);
}

/**
 * 把任何版本的專案 JSON 升到 SCHEMA_VERSION。
 * 不是物件 → 擲錯；版本 > 目前 → 擲錯（訊息可直接顯示）；其餘一步一步升。
 */
export function migrate(input: unknown): MigrateResult {
  if (!isRecord(input)) throw new ProjectFormatError("專案檔不是 JSON 物件");
  const from = readVersion(input);
  if (from > SCHEMA_VERSION) {
    throw new ProjectFormatError(`這個專案檔是較新版本的 App 存的（v${from}），本版只認得到 v${SCHEMA_VERSION}，請更新 AI Video Cut。`);
  }
  let doc: Record<string, unknown> = input;
  const applied: number[] = [];
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    const step = STEPS[v];
    if (!step) throw new ProjectFormatError(`缺少 v${v - 1} → v${v} 的升版步驟`);
    doc = step(doc);
    applied.push(v);
  }
  return { doc, from, applied };
}
