import { useEffect, type ComponentType } from "react";
import { useEdits } from "../store/edits";
import { selectActiveMedia, useProject } from "../store/project";
import { plugins } from "../plugins/registry";
import { useDialogs, type CoreDialogId, type DialogId } from "../store/dialogs";
import lazyOverlay from "../ui/lazyOverlay";

/**
 * 依 dialogs store 的堆疊掛載對話框。每個對話框各自 code-split（開了才抓 chunk）。
 *
 * `needs: "media"` 的對話框在 active media 消失時自動關掉；`needs: "track"` 的在那條 track 被刪掉時關掉 ——
 * 以前是 JSX 裡 `{open && active && …}`，現在集中在這裡。
 */
type Needs = "none" | "media" | "track";

type HostProps = { mediaId: string | null; onClose: () => void } & Record<string, unknown>;
type AnyComp = ComponentType<HostProps>;

/** 各對話框的 props 形狀不同（有的 mediaId 是 string、有的沒有）；由 REG 的 needs 保證掛載時型別成立。 */
function dlg<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): AnyComp {
  return lazyOverlay(load) as unknown as AnyComp;
}

const REG: Record<CoreDialogId, { comp: AnyComp; needs: Needs }> = {
  settings: { comp: dlg(() => import("../dialogs/SettingsDialog")), needs: "none" },
  about: { comp: dlg(() => import("../dialogs/AboutDialog")), needs: "none" },
  shortcuts: { comp: dlg(() => import("../dialogs/ShortcutsHelp")), needs: "none" },
  palette: { comp: dlg(() => import("./CommandPalette")), needs: "none" },
  engineSetup: { comp: dlg(() => import("../dialogs/EngineSetupDialog")), needs: "none" },
  // App 自動更新（狀態列「新版本」、說明 › 檢查更新…）：跟專案無關
  update: { comp: dlg(() => import("../dialogs/UpdateDialog")), needs: "none" },
  export: { comp: dlg(() => import("../dialogs/ExportDialog")), needs: "media" },
  exportTrackData: { comp: dlg(() => import("../dialogs/ExportTrackDataDialog")), needs: "media" },
  newTrack: { comp: dlg(() => import("../dialogs/NewTrackDialog")), needs: "media" },
  trackOptions: { comp: dlg(() => import("../dialogs/TrackOptionsDialog")), needs: "track" },
  insertOptions: { comp: dlg(() => import("../dialogs/InsertOptionsDialog")), needs: "track" },
  // needs "none"：可以看非作用中的媒體（props.mediaId）；那支媒體被移除時由對話框自己關
  mediaInfo: { comp: dlg(() => import("../dialogs/MediaInfoDialog")), needs: "none" },
  // M2.17：序列是專案層的東西，不綁作用中媒體
  sequenceSettings: { comp: dlg(() => import("../dialogs/SequenceSettingsDialog")), needs: "none" },
  // 需要作用中媒體的波形才算得出來
  removeSilence: { comp: dlg(() => import("../dialogs/RemoveSilenceDialog")), needs: "media" },
  removeFillers: { comp: dlg(() => import("../dialogs/RemoveFillersDialog")), needs: "media" },
  blurBackground: { comp: dlg(() => import("../dialogs/BlurBackgroundDialog")), needs: "media" },
  // 遮罩與背景板都綁在作用中媒體上
  removeObject: { comp: dlg(() => import("../dialogs/RemoveObjectDialog")), needs: "media" },
  // 吃任何一支影片檔，不需要專案也不需要作用中媒體
  reframeVideo: { comp: dlg(() => import("../dialogs/ReframeVideoDialog")), needs: "none" },
  // 讀作用中媒體的字幕
  chapters: { comp: dlg(() => import("../dialogs/ChaptersDialog")), needs: "media" },
  highlights: { comp: dlg(() => import("../dialogs/HighlightsDialog")), needs: "media" },
  // 合成的檔放進作用中媒體的快取、放上它的序列
  tts: { comp: dlg(() => import("../dialogs/TtsDialog")), needs: "media" },
  // 結果放進作用中媒體的快取、建成它的物件 track
  findObject: { comp: dlg(() => import("../dialogs/FindObjectDialog")), needs: "media" },
};

/** 外掛的對話框：第一次用到才包 lazy（同一個 id 包一次，不然每次渲染都是新元件、重掛）。 */
const pluginReg = new Map<string, { comp: AnyComp; needs: Needs }>();

function entryOf(id: DialogId): { comp: AnyComp; needs: Needs } | null {
  if (Object.prototype.hasOwnProperty.call(REG, id)) return REG[id as CoreDialogId];
  const hit = pluginReg.get(id);
  if (hit) return hit;
  for (const p of plugins()) {
    const d = p.dialogs?.[id];
    if (!d) continue;
    const e = { comp: dlg(d.load), needs: d.needs };
    pluginReg.set(id, e);
    return e;
  }
  return null;
}

export default function DialogHost() {
  const stack = useDialogs((s) => s.stack);
  const close = useDialogs((s) => s.close);
  const active = useProject(selectActiveMedia);
  const activeId = active?.id ?? null;
  const tracks = useEdits((s) => (activeId ? s.tracks[activeId] : undefined));

  useEffect(() => {
    for (const e of useDialogs.getState().stack) {
      const reg = entryOf(e.id);
      if (!reg) {
        close(e.id);
        continue;
      }
      const needs = reg.needs;
      if (needs === "none") continue;
      if (!activeId) {
        close(e.id);
        continue;
      }
      if (needs === "track") {
        const tid = typeof e.props.trackId === "string" ? e.props.trackId : null;
        if (!tid || !(tracks ?? []).some((t) => t.id === tid)) close(e.id);
      }
    }
  }, [activeId, tracks, close]);

  return (
    <>
      {stack.map((e) => {
        const reg = entryOf(e.id);
        if (!reg) return null;
        const { comp: C, needs } = reg;
        if (needs !== "none" && !activeId) return null;
        return <C key={e.key} mediaId={activeId} {...e.props} onClose={() => close(e.id)} />;
      })}
    </>
  );
}
