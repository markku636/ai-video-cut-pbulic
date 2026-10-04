// 序列時間軸的整張繪製（node 裡用記錄呼叫的假 ctx）：片段畫在對的 x、縮圖依片段的 k 取、波形跟著增益縮放、
// 已分離的原音畫提示、調色盤兜底。純幾何在 seqGeometry.test.ts，這裡驗「畫的時候真的用了那份幾何」。
import { describe, expect, it } from "vitest";
import { buildMip, PEAKS_PPS, type PeaksV1 } from "../audio/peaks";
import { placeVideo } from "../sequence/map";
import { aclip, FPS30, gap, lane, seqOf, vclip } from "../sequence/testkit";
import { DARK_SEQUENCE } from "../themes";
import { IDENTITY_H } from "../video/quad";
import { drawSequenceTimeline, drawUsedInSequence, formatGainDb, sequencePalette, type SeqDrawState } from "./drawSequence";
import { layoutSequenceRows } from "./layoutSequence";

interface Call {
  op: string;
  args: unknown[];
  fill: string;
  stroke: string;
}

/** 記錄每個呼叫與當下的 fillStyle / strokeStyle；measureText 每字 6 px。 */
function recorder() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textBaseline: "alphabetic" };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === "measureText") return (s: string) => ({ width: s.length * 6 });
      return (...args: unknown[]) => {
        calls.push({ op: prop, args, fill: String(target.fillStyle), stroke: String(target.strokeStyle) });
      };
    },
    set(target, prop: string, v) {
      target[prop] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function hexTriple(hex: string): string {
  const h = hex.replace("#", "");
  return `${Number.parseInt(h.slice(0, 2), 16)} ${Number.parseInt(h.slice(2, 4), 16)} ${Number.parseInt(h.slice(4, 6), 16)}`;
}

/** 讀不到任何 CSS 變數的調色盤：序列色退回深色預設、M1 色退回前景白。 */
const pal = sequencePalette(() => "");
const color = (token: keyof typeof DARK_SEQUENCE, alpha: number) => `rgb(${hexTriple(DARK_SEQUENCE[token])} / ${alpha})`;

/** 每個 5 ms 桶都是 ±0.5 振幅、RMS −12 dB 的假峰值（10 分鐘）。 */
function flatMip() {
  const n = 10 * 60 * PEAKS_PPS;
  const peaks: PeaksV1 = {
    version: 1,
    pps: PEAKS_PPS,
    sampleRate: 48000,
    nBuckets: n,
    totalSamples: n * 240,
    streamStartUs: 0,
    mins: new Int8Array(n).fill(-64),
    maxs: new Int8Array(n).fill(64),
    rmsU8: new Uint8Array(n).fill(Math.round((48 / 60) * 255)),
    zx: new Uint8Array(n).fill(255),
  };
  return buildMip(peaks);
}

function state(over: Partial<SeqDrawState> = {}): SeqDrawState {
  // [0,300) = m1 k 930..1229（原音 −6 dB）；[300,310) 空白；[310,610) = m1 k 60..359（停用、原音已分離到 A1）
  const seq = seqOf(
    [
      vclip("c2", "m1", 930, 1230, { audio: { enabled: true, gainDb: -6, fadeIn: 0, fadeOut: 48000, fadeCurve: "equalPower", envelope: [] } }),
      gap("g", 10),
      vclip("c1", "m1", 60, 360, { enabled: false, audio: { enabled: false, detachedTo: "d1", gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] } }),
    ],
    [lane("A1", "other", [aclip("d1", "a-vo", 310 * 1600, 300 * 1600, { detachedFrom: "c1", source: { type: "media", mediaId: "m1" } })]), lane("A2", "music", [aclip("m", "a-music", 0, 480000, { gainDb: -12, envelope: [{ at: 0, db: 0 }, { at: 240000, db: -10 }] })])],
    FPS30,
  );
  const mip = flatMip();
  const tile = { width: 32 * 78, height: 44 } as unknown as CanvasImageSource;
  const tracks = [{ id: "t1", mediaId: "m1" }];
  return {
    width: 1000,
    scrollFrame: 0,
    pxPerFrame: 1,
    seq,
    placed: placeVideo(seq),
    frames: 610,
    currentFrame: 120,
    range: { in: 50, out: 150 },
    pendingIn: null,
    pendingOut: null,
    loop: null,
    hoverFrame: 200,
    media: (id) => (id === "m1" ? { name: "sample_clip1.webm", frames: 1797, tileAt: () => tile, peaks: mip, videoStartUs: 0 } : undefined),
    audioSource: (ref) => (ref.type === "media" ? { name: "sample_clip1.webm", peaks: mip, startUs: 0, sampleRate: 48000 } : { name: "bgm.mp3", peaks: mip, startUs: 25057, sampleRate: 44100 }),
    badgeOf: (clip) => (clip.id === "c2" ? 3 : 0),
    tracks: [
      {
        id: "t1",
        mediaId: "m1",
        label: "Player1",
        selected: true,
        stale: false,
        keyframes: [{ frame: 1000, source: "user", locked: true }],
        referenceFrame: 100,
        solve: [{ k: 1000, h: IDENTITY_H, conf: 0.9, state: 1 }],
        shotRange: [900, 1300],
      },
    ],
    selectedKeyframe: { trackId: "t1", frame: 1000 },
    thumbW: 78,
    labels: { gap: "空白", disabled: "已停用", offline: "媒體離線", muted: "原音靜音", dropHint: "拖到這裡", badge: (n) => `替換 ${n}`, detached: (l) => `已分離 → ${l}`, gainDb: formatGainDb },
    layout: layoutSequenceRows(seq, tracks),
    ...over,
  };
}

describe("frametimeline/drawSequence", () => {
  it("調色盤：讀不到 CSS 變數時序列色退回深色預設、M1 色退回前景白；每個名字只讀一次", () => {
    let reads = 0;
    const p = sequencePalette(() => {
      reads++;
      return "";
    });
    expect(p("clipVideo", 0.5)).toBe(`rgb(${hexTriple(DARK_SEQUENCE.clipVideo)} / 0.5)`);
    expect(p("clipVideo")).toBe(`rgb(${hexTriple(DARK_SEQUENCE.clipVideo)} / 1)`);
    expect(p("fg")).toBe("rgb(248 248 242 / 1)");
    expect(reads).toBe(2);
    expect(sequencePalette((v) => (v === "--c-waveform" ? " 1 2 3 " : ""))("waveform", 0.4)).toBe("rgb(1 2 3 / 0.4)");
  });

  it("標記：畫在尺規下緣的 xOfFrame(t)，捲出畫面的不畫；沒有標記時一筆都不畫", () => {
    const base = state({ scrollFrame: 0, pxPerFrame: 1.5 });
    const L = base.layout;
    const h = Math.min(9, Math.max(4, L.rulerH - 2));
    const y = L.rulerY + L.rulerH - h;
    // 尺規那一列本來就有很多 moveTo，所以比對「有標記」與「沒標記」兩次繪製的差異
    const startsAt = (calls: { op: string; args: unknown[] }[], x: number) => calls.some((c) => c.op === "moveTo" && c.args[0] === x && c.args[1] === y);
    const paths = (calls: { op: string }[]) => calls.filter((c) => c.op === "closePath").length;

    const marked = recorder();
    drawSequenceTimeline(marked.ctx, { ...base, seq: { ...base.seq, markers: [{ id: "mk-1", t: 100, name: "" }, { id: "mk-2", t: 99999, name: "畫面外" }] } }, pal);
    const bare = recorder();
    drawSequenceTimeline(bare.ctx, base, pal);

    expect(startsAt(marked.calls, Math.round(100 * 1.5) - 4)).toBe(true);
    expect(startsAt(bare.calls, Math.round(100 * 1.5) - 4)).toBe(false);
    // 只多畫一個形狀：捲出畫面的那個標記沒畫
    expect(paths(marked.calls) - paths(bare.calls)).toBe(1);

    // 有名字就把字畫在旗子右邊；沒名字不畫字
    const named = recorder();
    drawSequenceTimeline(named.ctx, { ...base, seq: { ...base.seq, markers: [{ id: "mk-1", t: 100, name: "這裡要配樂" }] } }, pal);
    expect(named.calls.filter((c) => c.op === "fillText" && c.args[0] === "這裡要配樂").map((c) => c.args[1])).toEqual([Math.round(100 * 1.5) + 5 + 4]);
    expect(marked.calls.some((c) => c.op === "fillText" && String(c.args[0]).includes("畫面外"))).toBe(false);
  });

  it("V1 片段畫在 xOfFrame(t0)..xOfFrame(t1)，空白畫虛框，停用片段畫斜線，徽章「替換 3」", () => {
    const { ctx, calls } = recorder();
    drawSequenceTimeline(ctx, state({ scrollFrame: 0, pxPerFrame: 1.5 }), pal);
    const L = state().layout;
    const bodies = calls.filter((c) => c.op === "fillRect" && c.args[1] === L.v1Y + 1 && (c.fill === color("clipVideo", 0.22) || c.fill === color("clipVideo", 0.08)));
    expect(bodies.map((c) => [c.args[0], c.args[2]])).toEqual([
      [0, 450],
      [465, 450],
    ]);
    const gapBox = calls.find((c) => c.op === "strokeRect" && c.stroke === color("gap", 0.7));
    expect(gapBox?.args[0]).toBe(450.5);
    expect(calls.some((c) => c.op === "stroke" && c.stroke === color("clipDisabled", 0.55))).toBe(true);
    const texts = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    expect(texts).toContain("替換 3");
    expect(texts).toContain("已停用 · sample_clip1.webm");
    expect(texts).toContain("已分離 → A1");
    expect(texts).toContain("−12.0 dB");
  });

  it("縮圖依片段的 k 取 tile：c2 入點 k=930 在 tile 928 的第 2 格", () => {
    const { ctx, calls } = recorder();
    drawSequenceTimeline(ctx, state(), pal);
    const imgs = calls.filter((c) => c.op === "drawImage");
    // tile 寬 32×78 → 一格 sw = 78；k 930 = tile 928 的第 2 格 → sx 156，畫在 x=0
    expect(imgs[0].args.slice(1, 6)).toEqual([156, 0, 78, 44, 0]);
    // 停用片段照樣畫縮圖（看得出停用的是哪一段），從它的入點 k=60 開始、畫在 x=310
    expect(imgs.some((c) => c.args[1] === (60 - 32) * 78 && c.args[5] === 310)).toBe(true);
  });

  it("A0 波形跟著片段增益縮小；原音匯流排靜音時整段變淡；已分離的片段沒有波形", () => {
    const L = state().layout;
    const waveRects = (s: SeqDrawState) => {
      const { ctx, calls } = recorder();
      drawSequenceTimeline(ctx, s, pal);
      return calls.filter((c) => c.op === "fillRect" && c.args[1] as number >= L.a0Y && (c.args[1] as number) < L.a0Y + L.a0H && c.fill.startsWith(`rgb(${hexTriple(DARK_SEQUENCE.waveform)}`));
    };
    const live = waveRects(state());
    expect(live.length).toBeGreaterThan(200);
    // 全部在 c2（x < 300）：c1 已分離，A0 上不畫
    expect(live.every((c) => (c.args[0] as number) < 300)).toBe(true);
    // ±0.5 振幅 × −6 dB ≈ ±0.25 → 外層高 ≈ 半高 × 0.5
    const amp = (L.a0H - 4) / 2 - 1;
    const mid = live[10];
    expect(mid.args[3] as number).toBeCloseTo(2 * amp * (64 / 127) * 10 ** (-6 / 20), 1);
    expect(mid.fill).toBe(color("waveform", 0.75));
    const muted = waveRects(state({ seq: { ...state().seq, original: { muted: true, gainDb: 0 } } }));
    expect(muted[0].fill).toBe(color("waveform", 0.75 * 0.35));
  });

  it("追蹤分段：信心帶與菱形平移到片段位置（k 1000 在 c2 的 t=70）", () => {
    const { ctx, calls } = recorder();
    drawSequenceTimeline(ctx, state(), pal);
    const row = state().layout.rows[0];
    expect(calls.some((c) => c.op === "fillRect" && c.args[0] === 70 && c.args[1] === row.solvedY + 1)).toBe(true);
    // 菱形：moveTo(x, cy − r)，選中 r = DIAMOND + 2 = 7
    expect(calls.some((c) => c.op === "moveTo" && c.args[0] === 70 && c.args[1] === Math.round(row.userY + row.userH / 2) - 7)).toBe(true);
    // 參考影格 k 100 落在 c1（k 60..359）→ t = 310 + (100 − 60) = 350；停用片段上的追蹤照樣畫（重新啟用時它還在）
    expect(calls.some((c) => c.op === "arc" && c.args[0] === 350.5)).toBe(true);
  });

  it("音軌片段與音量線：A2 音樂從 x=0 畫起、音量線折線經過自動化點", () => {
    const { ctx, calls } = recorder();
    drawSequenceTimeline(ctx, state(), pal);
    const L = state().layout;
    const lane2 = L.lanes[1];
    const gainMoves = calls.filter((c) => (c.op === "moveTo" || c.op === "lineTo") && (c.args[1] as number) > lane2.y && (c.args[1] as number) < lane2.y + lane2.h);
    // 自動化點 at 240000 樣本 = 150 幀 → x = 150
    expect(gainMoves.some((c) => c.args[0] === 150)).toBe(true);
    expect(calls.some((c) => c.op === "arc" && c.args[0] === 0 && (c.args[1] as number) > lane2.y)).toBe(true);
  });

  it("素材空間的「已用於序列」橘線：尺規底緣 3 px、只畫可視部分", () => {
    const { ctx, calls } = recorder();
    drawUsedInSequence(ctx, [[0, 130], [300, 400]], { scrollFrame: 100, pxPerFrame: 2 }, 500, 22, pal);
    expect(calls.map((c) => c.args)).toEqual([
      [0, 19, 60, 3],
      [400, 19, 100, 3],
    ]);
    expect(calls[0].fill).toBe(color("usedInSequence", 0.9));
  });

  it("增益字串用真的減號、0 dB 沒有正負號", () => {
    expect(formatGainDb(-12)).toBe("−12.0 dB");
    expect(formatGainDb(3)).toBe("+3.0 dB");
    expect(formatGainDb(0)).toBe("0.0 dB");
  });
});
