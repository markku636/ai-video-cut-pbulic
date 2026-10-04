// 沒有外掛時，外掛擁有的鍵原樣保留（牌外掛重構 M1 的 Gate A，核心那一半）。
//
// fixtures/project/foreign-keys/ 是**有牌外掛**的 App 存出來的檔（凍結複本，媒體路徑換成假路徑）：
// 頂層 cardSlots / deck / contentNote、track 的 slotId / identity、options.templateCard、insertDefaults 的 flip…、
// regionPolicy keepBarcode、profile cards。開源版（沒有 plugins/）打開再存檔，這些一個都不能少、值一個都不能變 ——
// 不然使用者用開源版存一次檔，牌的設定就全沒了。鍵的位置可以不同（外掛不在時頂層鍵接在最後；有外掛時逐位元相同由外掛的黃金檔驗）。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ fileOnDisk: null as unknown, saved: [] as Record<string, unknown>[] }));

vi.mock("../api", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  api: {
    projectLoad: async () => JSON.parse(JSON.stringify(io.fileOnDisk)),
    projectSave: async (_path: string, doc: unknown) => {
      io.saved.push(JSON.parse(JSON.stringify(doc)) as Record<string, unknown>);
    },
    mediaCacheStatus: async () => {
      throw new Error("no tauri");
    },
  },
}));

const INPUTS = import.meta.glob("../../fixtures/project/foreign-keys/*.aivc.json", { eager: true, import: "default" }) as Record<string, Record<string, unknown>>;
// 黃金檔產生時的時間：存檔的 updatedAt 跟它一樣，整份才能直接比
const NOW = new Date("2026-10-03T00:00:00.000Z");

const { useProject } = await import("./project");
const { plugins } = await import("../plugins/registry");

async function roundTrip(raw: unknown): Promise<Record<string, unknown>> {
  io.fileOnDisk = raw;
  io.saved.length = 0;
  useProject.getState().newProject();
  await useProject.getState().loadFrom("D:\\foreign\\project.aivc.json");
  await useProject.getState().saveTo();
  expect(io.saved).toHaveLength(1);
  const doc = io.saved[0];
  (doc.app as Record<string, unknown>).version = "<version>";
  return doc;
}

beforeAll(() => {
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("沒有外掛：開檔 → 存檔，外掛的鍵原樣保留", () => {
  const names = Object.keys(INPUTS).sort();

  it("真的沒有登記任何外掛；fixture 齊全", () => {
    expect(plugins()).toEqual([]);
    expect(names.map((n) => n.split("/").pop())).toEqual(["cards-v1-minimal.aivc.json", "cards-v2-sequence.aivc.json"]);
  });

  for (const key of names) {
    const name = key.split("/").pop()!;
    it(`${name}：內容完全相同（deep-equal）`, async () => {
      const raw = INPUTS[key];
      const out = await roundTrip(raw);
      expect(out).toEqual(raw);
      // 再存一次也一樣（不會一次一次往後長東西）
      expect(await roundTrip(out)).toEqual(raw);
    });
  }

  it("牌的鍵一個一個看：頂層 / track / options / insertDefaults / 列舉值", async () => {
    const raw = INPUTS[names.find((n) => n.endsWith("cards-v1-minimal.aivc.json"))!];
    const out = await roundTrip(raw);
    expect(out.profile).toBe("cards");
    expect(out.cardSlots).toEqual(raw.cardSlots);
    expect(out.deck).toEqual(raw.deck);
    const tracks = (out.tracks as Record<string, Record<string, unknown>[]>).m1 ?? Object.values(out.tracks as Record<string, Record<string, unknown>[]>)[0];
    const rawTracks = (raw.tracks as Record<string, Record<string, unknown>[]>).m1 ?? Object.values(raw.tracks as Record<string, Record<string, unknown>[]>)[0];
    expect(tracks.map((t) => t.slotId)).toEqual(rawTracks.map((t) => t.slotId));
    expect(tracks.map((t) => t.regionPolicy)).toEqual(rawTracks.map((t) => t.regionPolicy));
    expect(tracks.map((t) => (t.options as Record<string, unknown>).templateCard)).toEqual(rawTracks.map((t) => (t.options as Record<string, unknown>).templateCard));
  });

  it("insert 裡外掛的鍵與列舉值（sheenLock card、print、flip）也留著", async () => {
    const raw = JSON.parse(JSON.stringify(INPUTS[names.find((n) => n.endsWith("cards-v1-minimal.aivc.json"))!])) as Record<string, unknown>;
    const tracks = Object.values(raw.tracks as Record<string, Record<string, unknown>[]>)[0];
    const relight = (raw.insertDefaults as Record<string, unknown>).relight as Record<string, unknown>;
    tracks[0].insert = { ...(raw.insertDefaults as Record<string, unknown>), relight: { ...relight, sheenLock: "card" }, print: { gamma: 1.2 }, flip: { faceDownStart: true, backColor: "red" } };
    const out = await roundTrip(raw);
    const insert = Object.values(out.tracks as Record<string, Record<string, unknown>[]>)[0][0].insert as Record<string, unknown>;
    expect((insert.relight as Record<string, unknown>).sheenLock).toBe("card");
    expect(insert.print).toEqual({ gamma: 1.2 });
    expect(insert.flip).toEqual({ faceDownStart: true, backColor: "red" });
    expect(out).toEqual(raw);
  });
});
