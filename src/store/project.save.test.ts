import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectFile, EXPORT_DEFAULTS, INSERT_DEFAULTS, type TrackV1 } from "../project/format";
import { rectQuad } from "../video/quad";

/**
 * 專案存檔的完整性（B-02）：`api.projectSave` 換成手動放行的假 IPC，
 * 「寫進磁碟」發生在放行那一刻（Rust 端 rename 完成），這樣才看得到重疊 / 亂序完成的後果。
 */
const h = vi.hoisted(() => {
  type Pending = { path: string; json: string; resolve: () => void; reject: (e: Error) => void };
  const pending: Pending[] = [];
  const disk = new Map<string, string>();
  const stats = { inFlight: 0, maxInFlight: 0 };
  const projectSave = vi.fn(
    (path: string, doc: unknown) =>
      new Promise<void>((resolve, reject) => {
        stats.inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        // Tauri 在 invoke 當下就把參數序列化；之後 store 再怎麼變都不影響這一筆
        const json = JSON.stringify(doc);
        pending.push({
          path,
          json,
          resolve: () => {
            disk.set(path, json);
            stats.inFlight--;
            resolve();
          },
          reject: (e) => {
            stats.inFlight--;
            reject(e);
          },
        });
      }),
  );
  const projectLoad = vi.fn(async (_path: string): Promise<unknown> => null);
  const mediaCacheStatus = vi.fn(async (_id: string) => ({ dir: "C:\\Users\\user\\AppData\\Local\\cache\\media\\0123456789abcdef", proxy: false }));
  return { pending, disk, stats, projectSave, projectLoad, mediaCacheStatus };
});

vi.mock("../api", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  api: { projectSave: h.projectSave, projectLoad: h.projectLoad, mediaCacheStatus: h.mediaCacheStatus, cacheRead: vi.fn(async () => { throw new Error("no cache"); }) },
}));

const { useProject } = await import("./project");
const { useEdits } = await import("./edits");
const { projectFileFor } = await import("../pipeline/project");

const M = "0123456789abcdef";
const DIR = "C:/Users/demo/Desktop/範例-換色";
const PROJ = `${DIR}/專案 一.aivc.json`;
const media = { id: M, path: `${DIR}/clip one.webm`, name: "clip one.webm", fingerprint: "ab".repeat(32), probe: null, proxy: null, proxyState: "none" as const };

/** 讓排在 microtask / setTimeout(0) 後面的東西跑完。 */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** 放行最早的一筆寫入。 */
async function releaseOldest() {
  const p = h.pending.shift();
  if (!p) throw new Error("沒有進行中的存檔");
  p.resolve();
  await settle();
}

function keyframesOnDisk(path = PROJ): number[] {
  const raw = h.disk.get(path);
  if (!raw) return [];
  const doc = (JSON.parse(raw) as { tracks: Record<string, TrackV1[]> }).tracks[M] ?? [];
  return doc.flatMap((t) => t.keyframes.map((k) => k.frame));
}

beforeEach(() => {
  useEdits.getState().reset();
  useProject.setState({ path: PROJ, dirty: false, createdAt: null, media: [{ ...media }], activeMediaId: M, profile: "cards", insertDefaults: INSERT_DEFAULTS, exportDefaults: EXPORT_DEFAULTS, lastReport: null });
  h.disk.clear();
  h.stats.inFlight = 0;
  h.stats.maxInFlight = 0;
  h.projectSave.mockClear();
});

afterEach(async () => {
  // 沒放行的寫入全部放掉，不然存檔佇列卡住，下一個測試就永遠等不到
  for (let i = 0; i < 20 && h.pending.length; i++) await releaseOldest();
});

describe("專案存檔：rev 計數", () => {
  it("markDirty 每次都 +1（已經 dirty 也一樣），會設 dirty 的 setter 也 +1", () => {
    const r0 = useProject.getState().rev;
    expect(typeof r0).toBe("number");
    useProject.getState().markDirty();
    useProject.getState().markDirty();
    expect(useProject.getState().rev).toBe(r0 + 2);
    useProject.getState().setProfile("generic");
    useProject.getState().setInsertDefaults({ ...INSERT_DEFAULTS });
    useProject.getState().setExportDefaults({ ...EXPORT_DEFAULTS });
    expect(useProject.getState().rev).toBe(r0 + 5);
    useProject.getState().setProfile("generic"); // 沒變 → 不算編輯
    expect(useProject.getState().rev).toBe(r0 + 5);
    expect(useProject.getState().dirty).toBe(true);
  });
});

describe("專案存檔：存檔途中的編輯", () => {
  it("存檔途中釘的關鍵幀：那次存完仍是未儲存，排在後面的存檔把它寫進去", async () => {
    const tid = useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const first = useProject.getState().saveTo();
    await settle();
    expect(h.pending).toHaveLength(1);
    // 自動儲存寫到一半，使用者又釘了一格，接著按 Ctrl+S
    useEdits.getState().setUserKeyframe(M, tid, 40, rectQuad(103, 100, 60, 90));
    const second = useProject.getState().saveTo();
    await settle();
    expect(h.pending, "同一時間只能有一筆寫入").toHaveLength(1);

    await releaseOldest();
    await first;
    expect(keyframesOnDisk()).toEqual([10]);
    expect(useProject.getState().dirty, "第一筆沒帶到 40 幀，不能標成已儲存").toBe(true);

    expect(h.pending).toHaveLength(1);
    await releaseOldest();
    await expect(second).resolves.toBe(PROJ);
    expect(keyframesOnDisk()).toEqual([10, 40]);
    expect(useProject.getState().dirty).toBe(false);
    expect(h.stats.maxInFlight).toBe(1);
  });

  it("三個 saveTo 疊在一起：不重疊、每一筆都寫出自己被呼叫時那一版、最後磁碟上是最新的", async () => {
    // 每一筆在**排隊當下**就定版（不再是輪到它時才取狀態）：切換專案時那筆不會變成「新專案的內容寫進舊路徑」，
    // 代價是中間那筆不再被最後一筆代勞，三次呼叫就是三次寫入。小 JSON 的寫入很便宜，安靜丟掉編輯不便宜。
    const tid = useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const calls = [useProject.getState().saveTo()];
    await settle();
    useEdits.getState().setUserKeyframe(M, tid, 20, rectQuad(101, 100, 60, 90));
    calls.push(useProject.getState().saveTo());
    useEdits.getState().setUserKeyframe(M, tid, 30, rectQuad(102, 100, 60, 90));
    calls.push(useProject.getState().saveTo(PROJ));
    await settle();
    expect(h.pending).toHaveLength(1);
    await releaseOldest();
    expect(keyframesOnDisk(), "第一筆帶的是它被呼叫時那一版").toEqual([10]);
    await releaseOldest();
    expect(keyframesOnDisk(), "第二筆帶 20、不會被第三筆代勞").toEqual([10, 20]);
    await releaseOldest();
    expect(await Promise.all(calls)).toEqual([PROJ, PROJ, PROJ]);
    expect(h.projectSave).toHaveBeenCalledTimes(3);
    expect(h.stats.maxInFlight).toBe(1);
    expect(keyframesOnDisk()).toEqual([10, 20, 30]);
    expect(useProject.getState().dirty).toBe(false);
  });

  it("中間沒有任何編輯的第二次 Ctrl+S 不重寫（同一版已經在磁碟上）", async () => {
    useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const a = useProject.getState().saveTo();
    const b = useProject.getState().saveTo();
    await settle();
    for (let i = 0; i < 4 && h.pending.length; i++) await releaseOldest();
    expect(await Promise.all([a, b])).toEqual([PROJ, PROJ]);
    expect(h.projectSave, "同一版不寫兩次").toHaveBeenCalledTimes(1);
    expect(keyframesOnDisk()).toEqual([10]);
  });

  it("干淨的專案直接 Ctrl+S 照樣寫檔（檔案被外部刪掉時要能寫回來）", async () => {
    const p = useProject.getState().saveTo();
    await settle();
    expect(h.pending).toHaveLength(1);
    await releaseOldest();
    await expect(p).resolves.toBe(PROJ);
    expect(h.disk.has(PROJ)).toBe(true);
  });

  it("另存新檔不跟排在前面的舊路徑存檔合併", async () => {
    useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const other = `${DIR}/另存 二.aivc.json`;
    const a = useProject.getState().saveTo();
    const b = useProject.getState().saveTo(other);
    await settle();
    await releaseOldest();
    await releaseOldest();
    await Promise.all([a, b]);
    expect(keyframesOnDisk(PROJ)).toEqual([10]);
    expect(keyframesOnDisk(other)).toEqual([10]);
    expect(useProject.getState().path).toBe(other);
    expect(useProject.getState().dirty).toBe(false);
  });

  it("寫入失敗：dirty 留著、錯誤往上丟，佇列不會卡死", async () => {
    useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const a = useProject.getState().saveTo();
    const b = useProject.getState().saveTo();
    await settle();
    h.pending.shift()!.reject(new Error("儲存錯誤：更新專案檔失敗：存取被拒。 (os error 5)"));
    await expect(a).rejects.toThrow(/os error 5/);
    expect(useProject.getState().dirty).toBe(true);
    await settle();
    expect(h.pending, "排在後面的那次照樣重試").toHaveLength(1);
    await releaseOldest();
    await expect(b).resolves.toBe(PROJ);
    expect(useProject.getState().dirty).toBe(false);
    expect(keyframesOnDisk()).toEqual([10]);
  });
});

describe("專案存檔：給引擎讀的檔", () => {
  it("自動儲存寫到一半時 projectFileFor：拿到的檔含最新編輯（即使 IPC 亂序完成）", async () => {
    const tid = useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const autosave = useProject.getState().saveTo(PROJ);
    await settle();
    useEdits.getState().setUserKeyframe(M, tid, 40, rectQuad(103, 100, 60, 90));
    let onDiskWhenHandedOut: number[] | null = null;
    const file = projectFileFor(M).then((p) => {
      onDiskWhenHandedOut = keyframesOnDisk(p);
      return p;
    });
    await settle();
    // 兩筆 Rust 寫入重疊時誰先完成沒有保證：有兩筆就讓新的先落地（最壞情況）
    for (let i = 0; i < 10 && h.pending.length; i++) {
      h.pending.pop()!.resolve();
      await settle();
    }
    await expect(file).resolves.toBe(PROJ);
    await autosave;
    expect(onDiskWhenHandedOut).toEqual([10, 40]);
    expect(keyframesOnDisk(), "引擎讀完之後也不能被舊的那筆蓋回去").toEqual([10, 40]);
    expect(h.stats.maxInFlight).toBe(1);
  });

  it("writeSnapshot 跟存檔排同一條隊：帶的是呼叫當下那一版（引擎跑的就是使用者按下去時看到的東西）", async () => {
    const tid = useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const scratch = "C:\\Users\\user\\AppData\\Local\\cache\\media\\0123456789abcdef\\project.aivc.json";
    const save = useProject.getState().saveTo();
    await settle();
    const snap = useProject.getState().writeSnapshot(scratch);
    await settle();
    expect(h.pending).toHaveLength(1);
    useEdits.getState().setUserKeyframe(M, tid, 40, rectQuad(103, 100, 60, 90)); // 快照排隊之後才改的
    await releaseOldest();
    await releaseOldest();
    await Promise.all([save, snap]);
    expect(keyframesOnDisk(scratch)).toEqual([10]);
    expect(h.stats.maxInFlight).toBe(1);
    expect(useProject.getState().path, "快照不改使用者的專案路徑").toBe(PROJ);
    expect(useProject.getState().dirty).toBe(true);
  });
});

describe("專案存檔：改到會存檔的欄位都要 +rev", () => {
  // rev 去重的前提是「buildDoc() 的輸出變了 → rev 一定變」。下面這些 mutator 以前一個都沒 +rev，
  // 結果是排在後面那筆存檔被當成「這一版寫過了」而跳過：記憶體與磁碟不一致，而且 dirty 被清掉，沒有補救。
  it("markStale 落在兩筆存檔之間：第二筆照樣寫出去，磁碟上的 stale 跟得上記憶體", async () => {
    const tid = useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    useEdits.getState().markSolved(M, [tid]);
    useProject.setState({ dirty: false });

    const first = useProject.getState().saveTo();
    await settle();
    expect(h.pending).toHaveLength(1);
    // pipeline/run.ts：偵測蓋掉了使用者的 track → 標成「待重解」
    useEdits.getState().markStale(M, [tid]);
    const second = useProject.getState().saveTo();
    await settle();

    for (let i = 0; i < 4 && h.pending.length; i++) await releaseOldest();
    await Promise.all([first, second]);
    const doc = JSON.parse(h.disk.get(PROJ) ?? "{}") as { tracks: Record<string, TrackV1[]> };
    expect(doc.tracks[M]?.[0]?.stale, "磁碟上要是「待重解」，不然重開會拿偵測的解算當成使用者的").toBe(true);
    expect(useProject.getState().dirty, "沒有漏寫就不該還留著未儲存").toBe(false);
  });

  it("markSolved / markStale / markTargetsReady 都算一筆編輯", () => {
    const tid = useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    useProject.setState({ dirty: false });
    const r0 = useProject.getState().rev;
    useEdits.getState().markSolved(M, [tid]);
    expect(useProject.getState().rev).toBe(r0 + 1);
    useEdits.getState().markStale(M, [tid]);
    expect(useProject.getState().rev).toBe(r0 + 2);
    useEdits.getState().markSolved(M, [tid]);
    expect(useProject.getState().rev).toBe(r0 + 3);
    expect(useProject.getState().dirty).toBe(true);
    useEdits.getState().markSolved(M, [tid]); // 已經是 solved：沒有變化就不算
    expect(useProject.getState().rev).toBe(r0 + 3);
  });

  it("setActive +rev（不設 dirty）；updateMedia 只有改到會存檔的欄位才算", () => {
    const other = { ...media, id: "fedcba9876543210" };
    useProject.setState({ media: [{ ...media }, other], dirty: false });
    const r0 = useProject.getState().rev;
    useProject.getState().setActive(other.id);
    expect(useProject.getState().rev, "activeMediaId 會寫進專案檔").toBe(r0 + 1);
    expect(useProject.getState().dirty, "切分頁不必觸發自動儲存").toBe(false);
    useProject.getState().setActive(other.id);
    expect(useProject.getState().rev).toBe(r0 + 1);

    useProject.getState().updateMedia(M, { proxyState: "building" });
    expect(useProject.getState().rev, "proxyState 只活在記憶體裡").toBe(r0 + 1);
    const proxy = { version: 1 as const, fps: { num: 30, den: 1 }, frames: 209, width: 640, height: 360, scale: 0.5, path: "C:/cache/proxy.mp4" };
    useProject.getState().updateMedia(M, { proxy, proxyState: "ready" });
    expect(useProject.getState().rev, "proxy 會寫進專案檔").toBe(r0 + 2);
    expect(useProject.getState().dirty).toBe(true);
    useProject.setState({ dirty: false });
    useProject.getState().updateMedia(M, { proxy: { ...proxy }, proxyState: "ready" });
    expect(useProject.getState().rev, "內容一樣就不是編輯（載入後 refreshProxy 不可以讓剛開的專案變未儲存）").toBe(r0 + 2);
    expect(useProject.getState().dirty).toBe(false);
  });
});

describe("專案存檔：存檔途中切換專案", () => {
  it("開別的專案時舊專案還在寫：寫完不能把 path / dirty 改回舊的，排隊中的舊存檔丟掉", async () => {
    useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const oldSave = useProject.getState().saveTo();
    await settle();
    useEdits.getState().addTrack(M, { frame: 50, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const queued = useProject.getState().saveTo(); // 自動儲存排在後面
    const OTHER = "D:/01 qen3_tts/專案 二.aivc.json";
    const otherId = "fedcba9876543210";
    h.projectLoad.mockResolvedValueOnce(
      buildProjectFile(
        { media: [{ ...media, id: otherId, path: "D:/01 qen3_tts/other.webm", name: "other.webm" }], activeMediaId: otherId, profile: "generic", shots: {}, tracks: {}, cardSlots: {}, deck: null, insertDefaults: INSERT_DEFAULTS, exportDefaults: EXPORT_DEFAULTS, captions: {} } as never,
        { name: "AI Video Cut", version: "0.0.6" },
      ),
    );
    await useProject.getState().loadFrom(OTHER);
    await releaseOldest();
    await oldSave;
    for (let i = 0; i < 10 && h.pending.length; i++) await releaseOldest();
    await queued;
    expect(useProject.getState().path).toBe(OTHER);
    expect(useProject.getState().dirty).toBe(false);
    expect(useProject.getState().media.map((m) => m.id)).toEqual([otherId]);
    // 舊檔只收到舊專案的內容：新專案不可被寫進舊路徑
    const writesToOld = h.projectSave.mock.calls.filter(([p]) => p === PROJ).map(([, d]) => (d as { media: { id: string }[] }).media.map((m) => m.id));
    expect(writesToOld.every((ids) => ids.length === 1 && ids[0] === M)).toBe(true);
    expect(h.pending).toHaveLength(0);
  });

  it("排在後面的舊專案存檔不會被丟掉：最後 2 秒的編輯照樣寫進舊檔", async () => {
    // 舊版是在輪到它時才 buildDoc()，所以換專案之後那筆只能整個放棄（不然就是把新專案寫進舊路徑）。
    // 改成排隊當下定版之後，兩個問題都不必選。
    useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const first = useProject.getState().saveTo();
    await settle();
    const tid = useEdits.getState().tracks[M]![0]!.id;
    useEdits.getState().setUserKeyframe(M, tid, 40, rectQuad(103, 100, 60, 90)); // Open 之前最後一筆編輯
    const queued = useProject.getState().saveTo();
    await settle();

    h.projectLoad.mockResolvedValueOnce(
      buildProjectFile(
        { media: [], activeMediaId: null, profile: "generic", shots: {}, tracks: {}, cardSlots: {}, deck: null, insertDefaults: INSERT_DEFAULTS, exportDefaults: EXPORT_DEFAULTS, captions: {} } as never,
        { name: "AI Video Cut", version: "0.0.6" },
      ),
    );
    await useProject.getState().loadFrom("D:/01 qen3_tts/專案 二.aivc.json");
    for (let i = 0; i < 6 && h.pending.length; i++) await releaseOldest();
    await Promise.all([first, queued]);
    expect(keyframesOnDisk(), "舊專案最後那筆編輯不可以安靜消失").toEqual([10, 40]);
    expect(useProject.getState().path).toBe("D:/01 qen3_tts/專案 二.aivc.json");
  });

  it("writeSnapshot 排隊途中換專案：暫存檔拿到的還是舊專案（引擎不會對著另一個專案跑）", async () => {
    const scratch = "C:/cache/media/0123456789abcdef/project.aivc.json";
    useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    const blocking = useProject.getState().saveTo();
    await settle();
    const snap = useProject.getState().writeSnapshot(scratch);
    await settle();

    h.projectLoad.mockResolvedValueOnce(
      buildProjectFile(
        { media: [], activeMediaId: null, profile: "generic", shots: {}, tracks: {}, cardSlots: {}, deck: null, insertDefaults: INSERT_DEFAULTS, exportDefaults: EXPORT_DEFAULTS, captions: {} } as never,
        { name: "AI Video Cut", version: "0.0.6" },
      ),
    );
    await useProject.getState().loadFrom("D:/01 qen3_tts/專案 二.aivc.json");
    for (let i = 0; i < 6 && h.pending.length; i++) await releaseOldest();
    await Promise.all([blocking, snap]);
    const doc = JSON.parse(h.disk.get(scratch) ?? "{}") as { profile?: string; tracks?: Record<string, TrackV1[]> };
    expect(doc.profile, "不可以是新專案的 generic").toBe("cards");
    expect(keyframesOnDisk(scratch)).toEqual([10]);
  });
});
