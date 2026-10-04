// M2.15 Inspector「片段」頁與 M2.17 輸出對話框 / 序列設定的第一個畫面（伺服器端渲染，不需要 DOM）：
// 數字跟 clipFacts（綁著引擎 golden）一致、音訊一行白話、來源選擇；隱含序列時輸出對話框跟 v0.0.6 一樣沒有「來源」列。
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("no tauri"))), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { default: ClipPanel, parseNumberDraft } = await import("./ClipPanel");
const { default: ExportDialog } = await import("../dialogs/ExportDialog");
const { default: SequenceSettingsDialog, clampDeclickMs } = await import("../dialogs/SequenceSettingsDialog");
const { useProject } = await import("../store/project");
const { useEdits } = await import("../store/edits");
const { useTimeline } = await import("../store/timeline");
const { useSettings } = await import("../store/settings");
const { A_MUSIC, aclip, lane, seqOf, vclip } = await import("../sequence/testkit");

type SequenceV2 = import("../project/format").SequenceV2;

const PROXY = { version: 1 as const, fps: { num: 30, den: 1 }, frames: 1797, width: 1280, height: 720, scale: 1, path: "p.mp4" };
const MEDIA = {
  id: "m1",
  path: "D:\\v\\sample_clip1.webm",
  name: "sample_clip1.webm",
  fingerprint: "",
  probe: null,
  proxy: PROXY,
  proxyState: "ready",
  audio: { codec: "opus", sampleRate: 48000, channels: 2, channelLayout: "stereo", startUs: 6500, videoStartUs: 0, nSamples: 2875200, gaps: [] },
};

const SEQ: SequenceV2 = seqOf(
  [vclip("c1", "m1", 60, 360), vclip("c2", "m1", 930, 1380, { audio: { enabled: true, gainDb: -3, fadeIn: 0, fadeOut: 48000, fadeCurve: "equalPower", envelope: [] } })],
  [lane("lane-1", "music", [aclip("a1", A_MUSIC.id, 48000, 960000, { srcIn: 88200, gainDb: -12, envelope: [{ at: 0, db: 0 }, { at: 12000, db: -10 }] })], { name: "A1 音樂" })],
);

/** zustand 4 的伺服器端渲染讀 store 建立當下的初始狀態物件（同 MediaInfoDialog.test）。 */
function setup(opts: { sequence: SequenceV2 | null; selected?: string[]; space?: "sequence" | "source" }) {
  Object.assign(useProject.getInitialState(), { media: [MEDIA], activeMediaId: "m1" });
  Object.assign(useEdits.getInitialState(), { sequence: opts.sequence, audioMedia: [A_MUSIC] });
  Object.assign(useTimeline.getInitialState(), { selectedClipIds: opts.selected ?? [], space: opts.space ?? "sequence" });
  Object.assign(useSettings.getInitialState(), { experimental: { sequence: true } });
  useTimeline.setState({ space: opts.space ?? "sequence" });
}

beforeEach(() => setup({ sequence: SEQ }));

describe("Inspector「片段」頁", () => {
  it("沒有選取：提示去序列時間軸點片段", () => {
    expect(renderToString(createElement(ClipPanel))).toContain("沒有選取片段");
  });

  it("V1 片段：來源 / 序列時間碼、音訊相對視訊 +6.5 ms、輸出入點與長度（= 引擎的鏈）、增益編輯欄", () => {
    setup({ sequence: SEQ, selected: ["c2"] });
    const html = renderToString(createElement(ClipPanel));
    expect(html).toContain("sample_clip1.webm");
    expect(html).toContain("00:00:31:00"); // 來源入點 k 930
    expect(html).toContain("00:00:10:00"); // 序列入點 t 300
    expect(html).toContain("+6.5 ms");
    expect(html).toContain("31.000000 s");
    expect(html).toContain("720000 樣本");
    expect(html).toContain("延遲 480000 樣本");
    expect(html).toContain('aria-label="增益"');
    expect(html).toContain("−3.0 dB");
  });

  it("音訊片段：來源入點（容器時間，帶 LAME 延遲）、所屬軌、自動化點表", () => {
    setup({ sequence: SEQ, selected: ["a1"] });
    const html = renderToString(createElement(ClipPanel));
    expect(html).toContain("00:00:02.025");
    expect(html).toContain("88200 樣本");
    expect(html).toContain("A1 音樂");
    expect(html).toContain("音量自動化（2 點）");
    expect(html).toContain("編碼延遲");
  });
});

describe("輸出對話框（M2.17）", () => {
  it("有序列：來源選擇（序列 25.0 秒、2 片段、1 音樂）與音訊一行白話（重新混音 → Opus，原因）", () => {
    const html = renderToString(createElement(ExportDialog, { mediaId: "m1", range: null, onClose: () => {} }));
    expect(html).toContain('data-testid="export-source"');
    expect(html).toContain("序列 t（25.0 秒，2 片段、1 音樂）");
    expect(html).toContain("只輸出目前素材（忽略序列）");
    expect(html).toContain("音訊：重新混音 → Opus 160 kbps");
    expect(html).toContain("分割／修剪過片段");
    expect(html).toContain("整支（750 幀）");
  });

  it("未動過的序列：直接複製；隱含序列（null）：沒有來源列，跟 v0.0.6 一樣", () => {
    setup({ sequence: seqOf([vclip("clip-1", "m1", 0, 1797)]) });
    expect(renderToString(createElement(ExportDialog, { mediaId: "m1", range: null, onClose: () => {} }))).toContain("音訊：直接複製（序列未修改）");
    setup({ sequence: null });
    const html = renderToString(createElement(ExportDialog, { mediaId: "m1", range: null, onClose: () => {} }));
    expect(html).not.toContain('data-testid="export-source"');
    expect(html).not.toContain('data-testid="export-audio-line"');
  });

  it("在序列時間軸標的範圍：輸出序列時照用（序列時間碼）", () => {
    setup({ sequence: SEQ, space: "sequence" });
    const html = renderToString(createElement(ExportDialog, { mediaId: "m1", range: { in: 310, out: 400 }, onClose: () => {} }));
    expect(html).toContain("00:00:10:10 – 00:00:13:10（90 幀）");
  });
});

describe("序列設定", () => {
  it("唯讀的幀率 / 尺寸 / 取樣率、防爆音淡化與限幅器（預設關）", () => {
    const html = renderToString(createElement(SequenceSettingsDialog, { onClose: () => {} }));
    expect(html).toContain("30/1 fps");
    expect(html).toContain("1280 × 720");
    expect(html).toContain("48000 Hz");
    expect(html).toContain('data-testid="sequence-limiter"');
    expect(html).not.toMatch(/data-testid="sequence-limiter"[^>]*checked/);
    expect(clampDeclickMs(3)).toBe(3);
    expect(clampDeclickMs(-1)).toBe(0);
    expect(clampDeclickMs(999)).toBe(50);
    expect(clampDeclickMs(Number.NaN)).toBe(3);
  });
});

describe("數字欄草稿：清空 = 放棄，不是設成 0", () => {
  it("空白回 NaN —— Number(\"\") 是 0，而 0 在增益 / 淡化上都是合法值", () => {
    // 使用者選取全部再按 Enter 想取消，不該把值改成 0
    expect(Number.isFinite(parseNumberDraft(""))).toBe(false);
    expect(Number.isFinite(parseNumberDraft("   "))).toBe(false);
    expect(Number.isFinite(parseNumberDraft("abc"))).toBe(false);
  });

  it("真的打 0 就是 0；全形減號正規化成半形", () => {
    expect(parseNumberDraft("0")).toBe(0);
    expect(parseNumberDraft("-3.5")).toBe(-3.5);
    expect(parseNumberDraft("−3.5")).toBe(-3.5); // U+2212
    expect(parseNumberDraft("–6")).toBe(-6); // U+2013
  });
});
