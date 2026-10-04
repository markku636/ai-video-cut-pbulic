import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Crosshair, Eye, Layers, MousePointerClick, Sparkles, SquareMousePointer, TextSearch, Trash2, Undo2, WandSparkles, X } from "lucide-react";
import { useT } from "../i18n";
import { askAiToPick, cancelSelection, deleteObjects, jumpToObject, recolorObject, renameObject, selectObject, startRefine } from "../objects/actions";
import { scopeFrames, scopeUnavailable, type FindScope } from "../objects/find";
import { ensureObjectMeta, useObjectMeta } from "../objects/meta";
import { hasPrompts, useSelection } from "../objects/selection";
import { useObjectsUi } from "../objects/ui";
import { objectRow, objectTracks, rangesText } from "../objects/view";
import { useActiveMediaId, useActiveShots, useActiveTracks } from "../stage/active";
import { usePlayback } from "../store/playback";
import { activeFrames } from "../store/project";
import { useTimeline } from "../store/timeline";
import { Badge, EmptyState, Input, Segmented, Spinner } from "../ui/index";
import { CommandButton, CommandIconButton } from "./CommandButton";
import { objectRowMenuItems } from "../commands/menuModel";
import { withUndoToast } from "../commands/undoToast";
import { openContextMenu } from "../ui/ContextMenu";
import EffectsSection from "./EffectsSection";

/**
 * 「物件」分頁（通用「追蹤任何東西」）：這支影片裡追蹤中的物件（色塊、名字、出現在哪幾幀、幾個特效、怎麼來的），
 * 點一下選取、雙擊改名、跳到最清楚的一幀、修正、刪除；上面是「選取物件」工具進行中的那一組提示。
 *
 * 沒有物件時講清楚三種挑法：打字找、在畫面上點、讓 AI 挑。
 */
export default function ObjectsPanel() {
  const t = useT();
  const mediaId = useActiveMediaId();
  const tracks = useActiveTracks();
  const objects = useMemo(() => objectTracks(tracks), [tracks]);
  const selectedId = useTimeline((s) => s.selectedTrackId);
  const metas = useObjectMeta((s) => s.byTrack);
  const showMask = useObjectsUi((s) => s.showMask);
  const setShowMask = useObjectsUi((s) => s.setShowMask);
  const selectedObject = objects.find((o) => o.id === selectedId) ?? null;

  // 錨點（可見區段）第一次看到某個物件時讀一次
  useEffect(() => {
    if (!mediaId) return;
    for (const o of objects) if (!(o.id in useObjectMeta.getState().byTrack)) void ensureObjectMeta(mediaId, o.id);
  }, [mediaId, objects]);

  return (
    <div className="flex h-full flex-col min-h-0" data-testid="objects-panel">
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-[12px]">
        <div className="flex flex-wrap gap-1.5">
          <CommandButton id="object.find" label={t("找物件…")} icon={TextSearch} variant="primary" />
          <CommandButton id="object.tool.select" label={t("選取物件")} icon={SquareMousePointer} />
          <button type="button" className="inline-flex items-center gap-1 rounded px-2 text-[12px] text-fg/60 hover:bg-fg/5 hover:text-fg/85" onClick={() => askAiToPick()} title={t("打開助手，預填一句話")}>
            <Bot size={14} />
            {t("讓 AI 選")}
          </button>
        </div>

        <SelectionBlock />

        {!mediaId ? (
          <EmptyState icon={Layers} title={t("先開一支影片")} compact />
        ) : objects.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={t("還沒有物件")}
            hint={
              <ul className="mt-1 space-y-1 text-left">
                <li>{t("① 打字找：「人臉」「車牌」「logo」，一次找出所有符合的（Ctrl+D 或上面的「找物件」）。")}</li>
                <li>{t("② 在畫面上點：按 W 用「選取物件」，點一下加選、Alt＋點減選、拖曳拉框，再按「追蹤這個物件」。")}</li>
                <li>{t("③ 讓 AI 挑：在助手裡用一句話說要哪個。")}</li>
              </ul>
            }
            compact
          />
        ) : (
          <ul className="rounded border border-fg/10 divide-y divide-fg/5" role="listbox" aria-label={t("物件")}>
            {objects.map((o) => (
              <ObjectRowItem key={o.id} trackId={o.id} selected={o.id === selectedId} row={objectRow(o, metas[o.id])} />
            ))}
          </ul>
        )}

        {objects.length > 0 && (
          <label className="flex items-center gap-1.5 text-[11px] text-fg/55">
            <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} />
            <Eye size={12} />
            {t("暫停時在舞台上疊出選中物件這一幀的遮罩")}
          </label>
        )}

        {/* 選中物件的效果（打碼、模糊、調色、描邊、光暈、貼紙、文字） */}
        {mediaId && selectedObject && (
          <div className="border-t border-fg/8 pt-3">
            <div className="mb-1.5 truncate text-[11px] text-fg/50">{t("「{name}」的效果", { name: selectedObject.label })}</div>
            <EffectsSection mediaId={mediaId} track={selectedObject} />
          </div>
        )}
      </div>
    </div>
  );
}

function ObjectRowItem({ trackId, selected, row }: { trackId: string; selected: boolean; row: ReturnType<typeof objectRow> }) {
  const t = useT();
  const renaming = useObjectsUi((s) => s.renamingId === trackId);
  const setRenaming = useObjectsUi((s) => s.setRenaming);
  const [draft, setDraft] = useState(row.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) return;
    setDraft(row.label);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [renaming, row.label]);

  const commit = () => {
    renameObject(trackId, draft);
    setRenaming(null);
  };

  const ranges = rangesText(row.visibleRanges);
  return (
    <li
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className={`group flex items-start gap-2 px-2 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${selected ? "bg-accent/10" : "hover:bg-fg/[0.03]"}`}
      onClick={() => selectObject(trackId)}
      onDoubleClick={() => setRenaming(trackId)}
      onContextMenu={(e) => {
        selectObject(trackId);
        openContextMenu(e, () => objectRowMenuItems(row.label));
      }}
      onKeyDown={(e) => {
        // 清單裡選到的那一列按 Delete／Backspace 就刪（改名輸入框打字時不算；擋住冒泡，免得序列的波紋刪除也收到）
        if (renaming || (e.key !== "Delete" && e.key !== "Backspace")) return;
        e.preventDefault();
        e.stopPropagation();
        void removeWithUndo(trackId, t);
      }}
      data-object={trackId}
    >
      <label className="relative mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded-sm border border-fg/20" style={{ background: row.color }} title={t("換顏色")} onClick={(e) => e.stopPropagation()}>
        <input type="color" value={row.color} onChange={(e) => recolorObject(trackId, e.target.value.toUpperCase())} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={t("換顏色")} />
      </label>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setRenaming(null);
              e.stopPropagation();
            }}
            aria-label={t("物件名稱")}
          />
        ) : (
          <div className="truncate font-medium text-fg/90">{row.label}</div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg/50">
          <span>{t(row.source.key, row.source.params)}</span>
          {row.visibleFrames != null ? (
            <span className="mono" title={ranges}>
              {t("出現 {n} 幀", { n: row.visibleFrames })}
              {ranges && ` · ${ranges}`}
            </span>
          ) : row.range ? (
            <span className="mono">{t("幀 {a}–{b}", { a: row.range[0], b: row.range[1] - 1 })}</span>
          ) : null}
          {row.effects > 0 && <Badge tone="accent">{t("{n} 個特效", { n: row.effects })}</Badge>}
        </div>
      </div>
      {/* 動作一直看得到（以前要滑過或先選取才出現，使用者找不到刪除） */}
      <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        <IconAction label={t("跳到最清楚的一幀")} icon={Crosshair} onClick={() => jumpToObject(trackId)} />
        <IconAction label={t("修正（從這一幀往後）")} icon={WandSparkles} onClick={() => startRefine(trackId)} />
        <IconAction label={t("刪除物件")} icon={Trash2} danger onClick={() => void removeWithUndo(trackId, t)} />
      </div>
    </li>
  );
}

/** 刪除物件＋可復原的提示（跟「物件」選單的刪除同一句；Ctrl+Z 一樣能還原）。 */
function removeWithUndo(trackId: string, t: ReturnType<typeof useT>): Promise<void> {
  return withUndoToast(t("已刪除物件"), () => deleteObjects([trackId]));
}

function IconAction({ label, icon: Glyph, onClick, danger = false }: { label: string; icon: typeof Crosshair; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`grid h-6 w-6 place-items-center rounded text-fg/55 hover:bg-fg/10 ${danger ? "hover:text-danger" : "hover:text-fg"}`}
    >
      <Glyph size={13} />
    </button>
  );
}

/** 「選取物件」工具進行中的那一組提示：狀態、範圍、追蹤這個物件 / 從這一幀往後重算。 */
function SelectionBlock() {
  const t = useT();
  const mediaId = useActiveMediaId();
  const shots = useActiveShots();
  const range = useTimeline((s) => s.range);
  const tool = useTimeline((s) => s.tool);
  const session = useSelection((s) => s.session);
  const scope = useSelection((s) => s.scope);
  const setScope = useSelection((s) => s.setScope);
  const committing = useSelection((s) => s.committing);
  const undoLast = useSelection((s) => s.undoLast);
  const clearPrompts = useSelection((s) => s.clearPrompts);
  const tracks = useActiveTracks();
  // 播放線離開了選取的那一幀（只在暫停時講，播放中每幀都不一樣沒有意義）
  const offFrame = usePlayback((s) => !!session && !s.playing && s.frame !== session.frame);

  if (!session || session.mediaId !== mediaId) {
    if (tool !== "objSelect") return null;
    return (
      <div className="rounded border border-accent/30 bg-accent/5 px-2.5 py-2 text-[11px] text-fg/70">
        <MousePointerClick size={13} className="mr-1 inline text-accent" />
        {t("點一下 = 加選、Alt＋點 = 減選、拖曳 = 框。")}
      </div>
    );
  }
  const target = session.targetTrackId ? tracks.find((x) => x.id === session.targetTrackId) ?? null : null;
  const ctx = { frame: session.frame, frames: activeFrames(), shots, range };
  const span = scopeFrames(scope, ctx);
  const pos = session.points.filter((p) => p.label === 1).length;
  const neg = session.points.length - pos;
  const scopeOptions = (["shot", "clip", "range"] as FindScope[]).map((v) => ({
    value: v,
    label: t(v === "shot" ? "這個鏡頭" : v === "clip" ? "整支影片" : "入點到出點"),
    disabled: !!scopeUnavailable(v, ctx),
  }));

  return (
    <section className="space-y-2 rounded border border-accent/30 bg-accent/5 p-2.5" data-testid="objects-selection">
      <div className="flex items-center gap-2">
        <span className="font-medium text-fg/90">{target ? t("修正「{name}」", { name: target.label }) : t("選取新物件")}</span>
        <span className="mono text-[11px] text-fg/50">{t("第 {k} 幀", { k: session.frame })}</span>
        <button type="button" className="ml-auto text-fg/45 hover:text-fg/80" title={t("取消選取")} aria-label={t("取消選取")} onClick={() => cancelSelection()}>
          <X size={14} />
        </button>
      </div>
      <div className="text-[11px] text-fg/60">{t("點一下 = 加選、Alt＋點 = 減選、拖曳 = 框。")}</div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {pos > 0 && <Badge tone="info">+{pos}</Badge>}
        {neg > 0 && <Badge tone="danger">−{neg}</Badge>}
        {session.box && <Badge tone="neutral">{t("框")}</Badge>}
        {session.status === "running" && (
          <span className="inline-flex items-center gap-1 text-fg/55">
            <Spinner size={12} />
            {t("計算中…")}
          </span>
        )}
        {session.status === "done" && session.preview && (
          <span className="text-fg/55">
            {t("面積 {a} px", { a: session.preview.area })}
            {session.preview.score != null && ` · ${t("信心 {s}", { s: session.preview.score.toFixed(2) })}`}
          </span>
        )}
        {session.preview?.backend.fallback && <span className="text-warning">{t("SAM 2.1（後備）")}</span>}
      </div>
      {session.error && <div className="rounded border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-danger">{session.error}</div>}
      {!hasPrompts(session) && <div className="text-[11px] text-fg/45">{t("在舞台上點要選的東西。")}</div>}
      <Segmented<FindScope> options={scopeOptions} value={scope} onChange={setScope} full ariaLabel={t("範圍")} />
      {span && <div className="text-[11px] text-fg/45">{target ? t("保留第 {k} 幀之前的遮罩，只從這一幀往後重算到第 {b} 幀。", { k: session.frame, b: Math.max(span[1], target.range?.[1] ?? 0) - 1 }) : t("沿第 {a}–{b} 幀追蹤。", { a: span[0], b: span[1] - 1 })}</div>}
      <div className="flex flex-wrap gap-1.5">
        <CommandButton id="object.trackSelection" label={target ? t("從這一幀往後重算") : t("追蹤這個物件")} icon={target ? WandSparkles : Crosshair} variant="primary" />
        <button type="button" disabled={!hasPrompts(session) || committing} onClick={undoLast} className="inline-flex items-center gap-1 rounded px-2 text-[12px] text-fg/60 hover:bg-fg/5 disabled:opacity-40">
          <Undo2 size={13} />
          {t("退一步")}
        </button>
        <button type="button" disabled={!hasPrompts(session) || committing} onClick={clearPrompts} className="inline-flex items-center gap-1 rounded px-2 text-[12px] text-fg/60 hover:bg-fg/5 disabled:opacity-40">
          {t("清除")}
        </button>
        {committing && <CommandIconButton id="object.cancelSelection" label={t("取消選取")} icon={X} />}
      </div>
      {offFrame && (
        <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => usePlayback.getState().seek(session.frame)}>
          {t("播放線不在選取的那一幀：回到第 {k} 幀", { k: session.frame })}
        </button>
      )}
    </section>
  );
}

