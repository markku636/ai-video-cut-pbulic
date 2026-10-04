// 音量自動化曲線與片段層增益的純函式（docs/editor-m2-design.md §3.2 GainPointV2、§5.2）。
//
// 曲線語意跟 ai-music-cut `envelopeDb` 一樣（渲染的 volume 運算式、Web Audio 預覽、波形包絡都照這一份）：
// - 空陣列 = 0 dB；第一點之前維持第一點的值、最後一點之後維持最後一點的值（hold）。
// - 兩點之間在 **dB 域**線性內插。
// - 同一個 at 可以有兩點（階梯，閃避斜坡為 0 時會出現）：左側取先出現的那點、右側取後出現的那點。
// 剪輯（分割、修剪、波紋）只會「切一段曲線出來」或「把兩段接起來」，所以只要 slice / join 兩個動作保持取樣值不變，
// 剪過的片段聽起來就跟剪之前一樣（M2.3 驗收：切點兩側取樣誤差 < 0.01 dB）。
import { GAIN_DB_MAX, GAIN_DB_MIN, type ClipGainV2, type GainPointV2 } from "../project/format";

/** 內插出來的 dB 比較用的容差：切點會產生 −3.333… 這種值，接回去時要認得它跟原本的直線是同一條。 */
const DB_EPS = 1e-9;

export function clampDb(db: number): number {
  return Math.max(GAIN_DB_MIN, Math.min(GAIN_DB_MAX, db));
}

/**
 * 曲線在 at（片段內序列樣本）處的 dB。side 只在剛好落在階梯上時有差：
 * "left" = 從左邊逼近的值（先出現的點）、"right" = 從右邊逼近的值（後出現的點）。
 */
export function envelopeDbAt(env: readonly GainPointV2[], at: number, side: "left" | "right" = "left"): number {
  const n = env.length;
  if (n === 0) return 0;
  if (at < env[0].at) return env[0].db;
  if (at > env[n - 1].at) return env[n - 1].db;
  if (side === "left") {
    for (let i = 0; i < n; i++) {
      if (env[i].at === at) return env[i].db;
      if (env[i].at > at) return lerpDb(env[i - 1], env[i], at);
    }
  } else {
    for (let i = n - 1; i >= 0; i--) {
      if (env[i].at === at) return env[i].db;
      if (env[i].at < at) return lerpDb(env[i], env[i + 1], at);
    }
  }
  return env[n - 1].db;
}

function lerpDb(a: GainPointV2, b: GainPointV2, at: number): number {
  const span = b.at - a.at;
  return span <= 0 ? b.db : a.db + ((b.db - a.db) * (at - a.at)) / span;
}

/**
 * 去掉不影響取樣值的點：連續兩個相同的點、共線的中間點、開頭 / 結尾跟鄰點同值的點（hold 會給出同樣的值）。
 * 全部縮成一個 0 dB 的點時回空陣列 —— 「B 切一刀再合併」之後 envelope 要回到 []，`-c:a copy` 閘門（isUntouched）才會成立。
 */
export function simplifyEnvelope(env: readonly GainPointV2[]): GainPointV2[] {
  const pts: GainPointV2[] = [];
  for (const p of env) {
    const last = pts[pts.length - 1];
    if (last && last.at === p.at && Math.abs(last.db - p.db) < DB_EPS) continue;
    pts.push(p);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i + 1 < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      // 階梯的兩點不能拿掉（a.at === b.at 或 b.at === c.at）
      if (a.at < b.at && b.at < c.at && Math.abs(lerpDb(a, c, b.at) - b.db) < DB_EPS) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  while (pts.length >= 2 && pts[0].at < pts[1].at && Math.abs(pts[0].db - pts[1].db) < DB_EPS) pts.shift();
  while (pts.length >= 2 && pts[pts.length - 2].at < pts[pts.length - 1].at && Math.abs(pts[pts.length - 2].db - pts[pts.length - 1].db) < DB_EPS) pts.pop();
  if (pts.length === 1 && Math.abs(pts[0].db) < DB_EPS) return [];
  return pts;
}

/**
 * 切出 [from, to] 這段曲線，以 from 為新的 0；兩端補內插點（from 取右側值、to 取左側值），取樣值不變。
 * 空曲線切出來還是空的。
 */
export function sliceEnvelope(env: readonly GainPointV2[], from: number, to: number): GainPointV2[] {
  if (env.length === 0) return [];
  const out: GainPointV2[] = [{ at: 0, db: envelopeDbAt(env, from, "right") }];
  for (const p of env) if (p.at > from && p.at < to) out.push({ at: p.at - from, db: p.db });
  out.push({ at: to - from, db: envelopeDbAt(env, to, "left") });
  return simplifyEnvelope(out);
}

/** 整條曲線往後移 d 個樣本（片段開頭往前延長時，原本的內容在片段內的位置變晚）。 */
export function shiftEnvelope(env: readonly GainPointV2[], d: number): GainPointV2[] {
  return d === 0 ? [...env] : env.map((p) => ({ at: p.at + d, db: p.db }));
}

/**
 * 把兩段相鄰的曲線接起來（左段長 leftLen）。空曲線代表 0 dB，所以另一段非空時要補成兩端各一個 0 dB 點，
 * 不然 hold 會把非空那段的值延伸到空的那段。結果再 simplify：切點當初補的內插點若跟原曲線共線就消失。
 */
export function joinEnvelopes(left: readonly GainPointV2[], leftLen: number, right: readonly GainPointV2[], rightLen: number): GainPointV2[] {
  if (left.length === 0 && right.length === 0) return [];
  const l = left.length ? [...left] : [{ at: 0, db: 0 }];
  if (l[l.length - 1].at < leftLen) l.push({ at: leftLen, db: l[l.length - 1].db });
  const r = right.length ? [...right] : [{ at: rightLen, db: 0 }];
  if (r[0].at > 0) r.unshift({ at: 0, db: r[0].db });
  return simplifyEnvelope([...l, ...r.map((p) => ({ at: p.at + leftLen, db: p.db }))]);
}

/**
 * 依片段長度收斂：淡入＋淡出超長等比縮小（floor，同 sanitize）；自動化點超出 length 的部分切掉並在 length 補內插點。
 * 沒變就回傳同一個物件（呼叫端靠參照判斷「這個片段沒動」）。
 */
export function fitGain<T extends ClipGainV2>(g: T, length: number): T {
  let fadeIn = Math.max(0, g.fadeIn);
  let fadeOut = Math.max(0, g.fadeOut);
  const total = fadeIn + fadeOut;
  if (total > length) {
    fadeIn = Math.floor((fadeIn * length) / total);
    fadeOut = Math.floor((fadeOut * length) / total);
  }
  const env = g.envelope;
  const needsTrim = env.length > 0 && (env[env.length - 1].at > length || env[0].at < 0);
  const envelope = needsTrim ? sliceEnvelope(env, 0, length) : env;
  if (fadeIn === g.fadeIn && fadeOut === g.fadeOut && envelope === env) return g;
  return { ...g, fadeIn, fadeOut, envelope };
}

/**
 * 一段增益參數切成 [0, leftLen) 與 [leftLen, leftLen + rightLen) 兩段：淡入留前段、淡出留後段（夾在各自長度內），
 * 曲線各自切出來（切點兩側補內插點）。增益、曲線種類兩段相同。
 */
export function splitGain<T extends ClipGainV2>(g: T, leftLen: number, rightLen: number): [T, T] {
  const left = { ...g, fadeIn: Math.min(g.fadeIn, leftLen), fadeOut: 0, envelope: sliceEnvelope(g.envelope, 0, leftLen) };
  const right = { ...g, fadeIn: 0, fadeOut: Math.min(g.fadeOut, rightLen), envelope: sliceEnvelope(g.envelope, leftLen, leftLen + rightLen) };
  return [left, right];
}

/** splitGain 的反向：兩段能不能無損接回一段（增益、曲線種類相同，而且切點上沒有淡化）。 */
export function gainsJoinable(a: ClipGainV2, b: ClipGainV2): boolean {
  return a.gainDb === b.gainDb && a.fadeCurve === b.fadeCurve && a.fadeOut === 0 && b.fadeIn === 0;
}

/** 兩段接回一段：前段的淡入、後段的淡出、曲線接起來。 */
export function joinGain<T extends ClipGainV2>(a: T, leftLen: number, b: ClipGainV2, rightLen: number): T {
  return { ...a, fadeOut: b.fadeOut, envelope: joinEnvelopes(a.envelope, leftLen, b.envelope, rightLen) };
}
