import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Lightbulb, Sparkles } from "lucide-react";
import { useT } from "../i18n";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import { peaksOf, peaksSourceOfMedia } from "../pipeline/peaks";
import { cacheDirOf } from "../pipeline/project";
import { maskFileFor } from "../pipeline/track";
import { runCommand, useCommands } from "../commands/registry";
import { DEFAULT_SILENCE, silentRangesOfSequence } from "../sequence/silence";
import { useEdits } from "../store/edits";
import { useEngine } from "../store/engine";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useSolves } from "../store/solves";
import { ADVICE_TEXT, adviceFor, lowConfidenceFrames, type AdviceInput, type AdviceItem, type TrackFacts } from "./advice";
import { plugins } from "../plugins/registry";
import { workProfile } from "../project/profiles";
import { Button, EmptyState } from "../ui/index";

/**
 * 「建議」分頁：依專案目前的狀態列出「有什麼問題、下一步可以做什麼」，每一條盡量帶一顆按鈕。
 *
 * 這個位置原本是「AI 助手（M6）」的佔位，點進去只會看到「之後才會有」—— 一個死路。
 * 規則本身在 `advice.ts`（純函式、有測試）；這裡只負責把 store 攤平成那支函式的輸入，
 * 以及把每一條畫出來。
 *
 * **說清楚這不是語言模型**：面板底下留一句話。把規則式的檢查講成 AI 會讓人對它有錯的期待
 * （以為可以打字下指令），而真正的自然語言助手仍然排在 M6。
 */
export default function AdvicePanel() {
  const t = useT();
  const media = useProject(selectActiveMedia);
  const mediaId = media?.id ?? "";
  const profile = useProject((s) => s.profile);
  const engineState = useEngine((s) => s.state);
  const tracks = useEdits((s) => (mediaId ? s.tracks[mediaId] ?? [] : []));
  const pluginMedia = useEdits((s) => (mediaId ? s.pluginMedia[mediaId] : undefined));
  const solves = useSolves((s) => s.byTrack);
  const storedSeq = useEdits((s) => s.sequence);
  const sequenceFlag = useSettings((s) => s.experimental.sequence);
  const allMedia = useProject((s) => s.media);
  // enabled() 會讀很多 store；訂閱指令表讓這個面板跟著工具列一起重算
  useCommands((s) => s.order);

  /** trackId → 有沒有遮罩檔。跑檔案系統，所以只在 track 清單變動時重查一次。 */
  const [masked, setMasked] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!mediaId) return;
      const dir = await cacheDirOf(mediaId);
      const out: Record<string, boolean> = {};
      for (const tr of tracks) out[tr.id] = !!(await maskFileFor(dir, tr.id));
      if (alive) setMasked(out);
    })();
    return () => {
      alive = false;
    };
  }, [mediaId, tracks]);

  const silentRanges = useMemo(() => {
    const seq = sequenceFlag ? viewSequenceOf(storedSeq, media ?? null) : null;
    if (!seq) return 0;
    const peaksFor = (id: string) => {
      const m = allMedia.find((x) => x.id === id);
      const mip = m ? peaksOf(peaksSourceOfMedia(m).fingerprint) : null;
      return mip ? mip.peaks : null;
    };
    try {
      return silentRangesOfSequence(seq, peaksFor, DEFAULT_SILENCE).ranges.length;
    } catch {
      // 波形還沒算好之類的情況：這一條建議先不出現，其餘照常
      return 0;
    }
  }, [sequenceFlag, storedSeq, media, allMedia]);

  const input: AdviceInput = useMemo(() => {
    // 解算 / 遮罩的檢查只對平面 track：物件 track 沒有解算，算進去會一直提「還沒解算」
    const planar = tracks.filter((tr) => tr.kind !== "object");
    const facts: TrackFacts[] = planar.map((tr) => ({
      id: tr.id,
      label: tr.label,
      stale: tr.stale,
      solved: !!solves[tr.id],
      lowConfidenceFrames: lowConfidenceFrames(solves[tr.id]),
      hasMask: !!masked[tr.id],
    }));
    return {
      engineReady: engineState === "ready",
      hasMedia: !!media,
      profile,
      tracks: facts,
      objects: tracks.length - planar.length,
      silentRanges,
      noTracksCommand: workProfile(profile)?.detectCommand,
      // 外掛依它自己的狀態算的條目（例如 cards：原牌要確認、格位還沒指定牌）
      extra: plugins().flatMap((p) => p.advice?.items({ mediaId, profile, media: pluginMedia, tracks: facts, trackList: planar }) ?? []),
    };
  }, [engineState, media, mediaId, profile, tracks, solves, masked, pluginMedia, silentRanges]);

  const items = useMemo(() => adviceFor(input), [input]);

  if (!items.length) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title={t("目前沒有發現問題")}
        hint={t("這一頁會依專案狀態列出擋路的問題與下一步可以做的事；做了改動之後回來看看。")}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 min-h-0 space-y-2 overflow-auto p-3" data-testid="advice-list">
        {items.map((a) => (
          <AdviceRow key={a.code} item={a} />
        ))}
      </div>
      <div className="shrink-0 border-t border-fg/10 px-3 py-2 text-[11px] text-fg/45">
        <Sparkles size={11} className="mr-1 inline align-[-1px]" />
        {t("這些是依專案狀態做的檢查，不是語言模型。用自然語言下指令的助手排在之後的里程碑（M6）。")}
      </div>
    </div>
  );
}

/** 核心的文字或外掛的（外掛的 AdviceContribution.text）。 */
function adviceText(code: string): { title: string; hint: string } {
  const core = (ADVICE_TEXT as Record<string, { title: string; hint: string } | undefined>)[code];
  if (core) return core;
  for (const p of plugins()) {
    const x = p.advice?.text[code];
    if (x) return x;
  }
  return { title: code, hint: "" };
}

function AdviceRow({ item }: { item: AdviceItem }) {
  const t = useT();
  const txt = adviceText(item.code);
  const cmd = useCommands((s) => (item.command ? s.byId[item.command] : undefined));
  const en = cmd?.enabled();
  const disabled = !!en && !en.ok;
  const why = en && !en.ok ? en.why : "";
  const problem = item.kind === "problem";

  return (
    <div className={`rounded border px-3 py-2 ${problem ? "border-warning/30 bg-warning/8" : "border-fg/10 bg-fg/4"}`} data-advice={item.code}>
      <div className="flex items-start gap-2">
        {problem ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" /> : <Lightbulb size={14} className="mt-0.5 shrink-0 text-fg/45" />}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg/90">{t(txt.title, item.params)}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-fg/60">{t(txt.hint)}</div>
          {cmd && (
            <div className="mt-1.5 flex items-center gap-2">
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void runCommand(cmd.id, "palette")} data-testid={`advice-run-${item.code}`}>
                {t(cmd.title, cmd.titleParams)}
              </Button>
              {disabled && why && <span className="text-[11px] text-fg/40">{t(why)}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
