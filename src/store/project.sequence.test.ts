// M2.4 讀檔與存檔接線（§13 M2.4「自動存檔往返」、§4.3 最低版本寫檔）：真的 project / edits store，只把 Tauri IPC 換成記憶體。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectFile, EXPORT_DEFAULTS, INSERT_DEFAULTS, type ProjectFileJson } from "../project/format";
import * as ops from "../sequence/ops";
import { A_MUSIC, M1, M2 } from "../sequence/testkit";
import { rectQuad } from "../video/quad";

/** 假的磁碟：存檔跟真的一樣走 JSON（Rust serde 會把 undefined 的鍵丟掉，這裡用 stringify 模擬）。 */
const disk = new Map<string, string>();
vi.mock("../api", () => ({
  api: {
    projectLoad: async (path: string) => {
      const text = disk.get(path);
      if (text == null) throw new Error(`no such file: ${path}`);
      return JSON.parse(text) as unknown;
    },
    projectSave: async (path: string, doc: unknown) => void disk.set(path, JSON.stringify(doc, null, 2)),
    // 非 Tauri 環境：refreshProxy 走 catch，維持專案檔裡的 proxy
    mediaCacheStatus: async () => {
      throw new Error("not tauri");
    },
    cacheRead: async () => {
      throw new Error("not tauri");
    },
  },
  decodeJson: (b: unknown) => b,
}));

const { useProject } = await import("./project");
const { useEdits, SEQ_EDIT_LABEL: L } = await import("./edits");

const APP = { name: "AI Video Cut", version: "0.0.6" };
const T0 = new Date("2026-09-17T01:00:00.000Z");
const PATH = "D:\\proj\\a.aivc.json";

/** 還沒剪輯的 v1 專案（m1 有一條追蹤）。media 不帶 audio 鍵：v1 檔本來就沒有。 */
function v1Doc(): ProjectFileJson {
  const { audio: _a1, ...m1 } = M1;
  const { audio: _a2, ...m2 } = M2;
  return buildProjectFile(
    {
      media: [m1, m2],
      activeMediaId: "m1",
      profile: "generic",
      shots: { m1: [{ id: "s1", startFrame: 0, endFrame: 1797, kind: "wide", source: "auto" }], m2: [] },
      tracks: { m1: [], m2: [] },
      insertDefaults: INSERT_DEFAULTS,
      exportDefaults: EXPORT_DEFAULTS,
    },
    APP,
    null,
    T0,
  );
}

const saved = (path = PATH) => JSON.parse(disk.get(path)!) as Record<string, unknown>;
const withoutUpdatedAt = (doc: Record<string, unknown>) => {
  const { updatedAt: _u, app: _app, ...rest } = doc;
  return rest;
};

beforeEach(() => {
  disk.clear();
  useProject.getState().newProject();
});

describe("store/project：序列的讀檔與存檔", () => {
  it("v1 專案讀進來什麼都沒剪 → 自動存檔仍寫 schemaVersion 1、沒有 sequence / audioMedia 鍵，除 updatedAt 外內容相同（I5）", async () => {
    disk.set(PATH, JSON.stringify(v1Doc(), null, 2));
    await useProject.getState().loadFrom(PATH);
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().audioMedia).toEqual([]);
    useProject.getState().markDirty();
    await useProject.getState().saveTo();
    const out = saved();
    expect(out.schemaVersion).toBe(1);
    expect("sequence" in out).toBe(false);
    expect("audioMedia" in out).toBe(false);
    expect(withoutUpdatedAt(out)).toEqual(withoutUpdatedAt(JSON.parse(JSON.stringify(v1Doc())) as Record<string, unknown>));
  });

  it("自動存檔往返：剪輯 → 存（v2）→ 開新專案 → 讀回來序列與音訊媒體逐值相同；歷史不帶進檔案", async () => {
    disk.set(PATH, JSON.stringify(v1Doc(), null, 2));
    await useProject.getState().loadFrom(PATH);
    // 讀檔的 media 沒有 audio：補上（M2.5 開檔時會寫），分離與音樂都要用
    useProject.getState().updateMedia("m1", { audio: M1.audio });
    useProject.getState().updateMedia("m2", { audio: M2.audio });
    const e = useEdits.getState();
    e.editSequence(L.split, (s, ctx) => ops.splitAt(s, 300, ctx));
    e.editSequence(L.addMedia, (s) => ops.appendMedia(s, M2));
    e.editSequence(L.addAudio, (s, ctx) => ops.addAudioClip(s, null, { type: "audio", audioId: "a-music" }, 48000, ctx), { audioMedia: [A_MUSIC] });
    e.editSequence(L.gain, (s) => ops.setGain(s, ["aclip-1"], -12));
    e.addTrack("m1", { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 1797 });
    expect(useProject.getState().dirty).toBe(true);
    const seq = useEdits.getState().sequence;
    const audioMedia = useEdits.getState().audioMedia;

    // App.tsx 的自動存檔：dirty && path → saveTo(path)
    await useProject.getState().saveTo(useProject.getState().path!);
    expect(useProject.getState().dirty).toBe(false);
    const out = saved();
    expect(out.schemaVersion).toBe(2);
    expect(out.sequence).toEqual(JSON.parse(JSON.stringify(seq)));
    expect(out.audioMedia).toEqual(JSON.parse(JSON.stringify(audioMedia)));
    expect((out.media as { audio?: unknown }[]).map((m) => m.audio)).toEqual([M1.audio, M2.audio]);
    expect(JSON.stringify(out)).not.toContain("*project");

    useProject.getState().newProject();
    expect(useEdits.getState().sequence).toBeNull();
    const parsed = await useProject.getState().loadFrom(PATH);
    expect(parsed.report.total).toBe(0);
    expect(useEdits.getState().sequence).toEqual(seq);
    expect(useEdits.getState().audioMedia).toEqual(audioMedia);
    expect(useEdits.getState().tracks.m1).toHaveLength(1);
    expect(useEdits.getState().past).toHaveLength(0);
    expect(useProject.getState().media.map((m) => m.audio)).toEqual([M1.audio, M2.audio]);

    // 讀回來再存一次：逐位元相同（除 updatedAt）
    const first = disk.get(PATH)!;
    useProject.getState().markDirty();
    await useProject.getState().saveTo();
    expect(withoutUpdatedAt(saved())).toEqual(withoutUpdatedAt(JSON.parse(first) as Record<string, unknown>));
  });

  it("剪了又全部復原 → 存回 schemaVersion 1（降版安全跟著 undo 走）", async () => {
    disk.set(PATH, JSON.stringify(v1Doc(), null, 2));
    await useProject.getState().loadFrom(PATH);
    const e = useEdits.getState();
    e.editSequence(L.split, (s, ctx) => ops.splitAt(s, 300, ctx));
    await useProject.getState().saveTo();
    expect(saved().schemaVersion).toBe(2);
    e.undo();
    expect(useProject.getState().dirty).toBe(true);
    await useProject.getState().saveTo();
    expect(saved().schemaVersion).toBe(1);
    expect("sequence" in saved()).toBe(false);
  });

  it("writeSnapshot（給引擎 op 的暫存專案檔）也帶序列，但不動 path / dirty", async () => {
    disk.set(PATH, JSON.stringify(v1Doc(), null, 2));
    await useProject.getState().loadFrom(PATH);
    useEdits.getState().editSequence(L.split, (s, ctx) => ops.splitAt(s, 300, ctx));
    await useProject.getState().writeSnapshot("C:\\tmp\\snap.aivc.json");
    expect(saved("C:\\tmp\\snap.aivc.json").sequence).toEqual(JSON.parse(JSON.stringify(useEdits.getState().sequence)));
    expect(useProject.getState().path).toBe(PATH);
    expect(useProject.getState().dirty).toBe(true);
  });

  it("removeMedia：序列片段一起刪、回報歷史被清；沒剪輯時只抽掉那支媒體的歷史", async () => {
    disk.set(PATH, JSON.stringify(v1Doc(), null, 2));
    await useProject.getState().loadFrom(PATH);
    const e = useEdits.getState();
    e.addTrack("m1", { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 1797 });
    e.addTrack("m2", { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 600 });
    expect(useProject.getState().removeMedia("m2")).toEqual({ historyCleared: false });
    expect(useEdits.getState().past.map((p) => p.mediaId)).toEqual(["m1"]);
    expect(useProject.getState().media.map((m) => m.id)).toEqual(["m1"]);

    // 媒體加回來、放進序列，再移除 → 序列片段跟著刪、整份歷史清掉
    useProject.setState((s) => ({ media: [...s.media, { ...M2, proxyState: "ready" as const }] }));
    e.editSequence(L.addMedia, (s) => ops.appendMedia(s, M2));
    expect(useProject.getState().removeMedia("m2")).toEqual({ historyCleared: true });
    expect(useEdits.getState().past).toEqual([]);
    expect(useEdits.getState().sequence?.video.every((it) => it.kind === "clip" && it.mediaId === "m1")).toBe(true);
    expect(useProject.getState().dirty).toBe(true);
  });
});
