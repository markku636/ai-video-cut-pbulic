import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Plus, TextSearch, X } from "lucide-react";
import { errMessage, isCanceled } from "../api";
import { useT } from "../i18n";
import { adoptFindInstances, cancelObjectJobs, fileUrl, runFind, type FindIntent } from "../objects/actions";
import { PRIVACY_PLATES, privacyText } from "../objects/privacy";
import {
  addSuggestion,
  defaultScope,
  defaultTicked,
  fallbackNote,
  FIND_SUGGESTIONS,
  findAnchor,
  findBlocker,
  instanceFrames,
  instanceLabels,
  scopeFrames,
  scopeUnavailable,
  type FindResult,
  type FindScope,
  type ScopeContext,
} from "../objects/find";
import { jobProgressText } from "../pipeline/engineJob";
import { useEdits } from "../store/edits";
import { engineReady, useEngine } from "../store/engine";
import { useJobs } from "../store/jobs";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { toast } from "../ui";
import { Button, Field, Input, Modal, Segmented, Spinner } from "../ui/index";

/**
 * 找物件（通用「追蹤任何東西」）：打字 → 引擎 seg.find（SAM 3，沒有權重時 OWLv2 + SAM 2.1）→ 看結果勾選 →
 * objects.adopt 搬進專案、建物件 track。
 *
 * 結果先給人看（縮圖、命中的片語、分數、出現在哪幾幀、整張疊色圖）再收：偵測器會多抓（遠處的臉、海報上的人），
 * 讓人勾掉不要的，比收進來再一個一個刪好。後端退回 OWLv2 時給一句不擋路的說明（找不到東西時才知道為什麼）。
 */
export default function FindObjectDialog({ onClose, text: initialText, autoRun, intent = "track" }: { onClose: () => void; text?: string; autoRun?: boolean; intent?: FindIntent }) {
  const t = useT();
  const media = useProject(selectActiveMedia);
  const mediaId = media?.id ?? "";
  const shots = useEdits((s) => (mediaId ? s.shots[mediaId] ?? [] : []));
  const range = useTimeline((s) => s.range);
  const engineOk = useEngine((s) => s.state === "ready");
  const frames = media?.proxy?.frames ?? 0;

  const [text, setText] = useState(initialText ?? "");
  const [scope, setScope] = useState<FindScope>(() => defaultScope({ range }));
  const [busy, setBusy] = useState<"find" | "adopt" | null>(null);
  const [result, setResult] = useState<FindResult | null>(null);
  /** 結果是用哪一句找的（物件名用它；輸入框之後又改了不影響）。 */
  const [resultText, setResultText] = useState("");
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 播放線只在「按下找」那一刻讀（錨定幀）；不訂閱 —— 播放時每幀重畫對話框沒有意義
  const ctx = (): ScopeContext => ({ frame: usePlayback.getState().frame, frames, shots, range });
  const span = scopeFrames(scope, ctx());
  const blocker = findBlocker({ text, engineReady: engineOk || engineReady(), scope, ctx: ctx(), busy: busy !== null });
  const job = useJobs((s) => s.jobs.find((j) => j.kind === "objects" && j.mediaId === mediaId && (j.status === "queued" || j.status === "running")) ?? null);

  const doFind = async () => {
    if (!media || blocker) return;
    const k = scopeFrames(scope, ctx());
    if (!k) return;
    setBusy("find");
    setError(null);
    setResult(null);
    try {
      const r = await runFind(mediaId, { video: media.path, text, frames: k, anchor: findAnchor(k, usePlayback.getState().frame) });
      setResult(r);
      setResultText(text);
      setTicked(defaultTicked(r));
    } catch (e) {
      if (!isCanceled(e)) setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // 開始畫面 / 隱私打碼：開了就直接找（引擎與 proxy 都好了才跑；不然就停在這裡讓人看到原因）
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoRun || autoRan.current || blocker) return;
    autoRan.current = true;
    void doFind();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在條件第一次滿足時跑一次
  }, [autoRun, blocker]);

  useEffect(() => {
    if (!autoRun) inputRef.current?.focus();
  }, [autoRun]);

  const doAdopt = async () => {
    if (!result || !ticked.size) return;
    setBusy("adopt");
    try {
      const out = await adoptFindInstances(mediaId, result, ticked, resultText, intent);
      if (out.failed) toast.error(t("{n} 個物件沒有收進專案：{err}", { n: out.failed, err: out.firstError ?? "" }));
      if (out.ids.length) {
        toast.success(intent === "privacy" ? t("已為 {n} 個物件打上馬賽克（物件分頁可以改成模糊或關掉）", { n: out.ids.length }) : t("已加入 {n} 個物件", { n: out.ids.length }));
        onClose();
      }
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: number) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const labels = useMemo(() => (result ? instanceLabels(result, resultText) : new Map<number, string>()), [result, resultText]);
  const note = result ? fallbackNote(result.backend) : null;
  const scopeOptions = (["shot", "clip", "range"] as const).map((v) => ({
    value: v,
    label: t(v === "shot" ? "這個鏡頭" : v === "clip" ? "整支影片" : "入點到出點"),
    disabled: !!scopeUnavailable(v, ctx()),
    title: scopeUnavailable(v, ctx()) ? t(scopeUnavailable(v, ctx())!) : undefined,
  }));

  return (
    <Modal
      open
      onClose={() => {
        if (busy === "find") cancelObjectJobs(mediaId);
        onClose();
      }}
      title={t("找物件")}
      icon={TextSearch}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          {result && result.instances.length > 0 && (
            <Button variant="primary" icon={Check} onClick={() => void doAdopt()} loading={busy === "adopt"} disabled={!ticked.size || busy !== null} data-testid="find-object-adopt">
              {intent === "privacy" ? t("打碼 {n} 個物件", { n: ticked.size }) : t("加入 {n} 個物件", { n: ticked.size })}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-sm" data-testid="find-object-dialog">
        <Field label={t("要找什麼")} hint={t("逗號分開可以一次找好幾種。英文通常比較準；下面幾個常用的會自動換成英文。")}>
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !blocker) void doFind();
              }}
              placeholder={t("例如 人臉、車牌、logo、red car")}
              className="flex-1"
              spellCheck={false}
              data-testid="find-object-text"
            />
            <Button variant="primary" icon={TextSearch} loading={busy === "find"} disabled={!!blocker} title={blocker ? t(blocker) : undefined} onClick={() => void doFind()} data-testid="find-object-run">
              {result ? t("重新找") : t("找")}
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("常用")}>
            {FIND_SUGGESTIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setText((cur) => addSuggestion(cur, s.label))}
                className="inline-flex items-center gap-1 rounded-full border border-fg/15 px-2.5 py-0.5 text-[12px] text-fg/75 hover:border-accent/50 hover:text-accent"
                data-chip={s.label}
              >
                <Plus size={11} />
                {t(s.label)}
              </button>
            ))}
          </div>
        </Field>

        {intent === "privacy" && (
          <div className="space-y-1.5 rounded-md border border-accent/25 bg-accent/5 px-3 py-2 text-[12px] text-fg/75" data-testid="find-object-privacy">
            <div>{t("隱私打碼：勾選的物件收進來時會自動加上馬賽克（臉用橢圓、車牌用方框）。不用打的先勾掉。")}</div>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={privacyText(text, true) === text} onChange={(e) => setText((cur) => privacyText(cur, e.target.checked))} data-testid="find-object-plates" />
              {t("也找{what}", { what: t(PRIVACY_PLATES) })}
            </label>
          </div>
        )}

        <Field label={t("範圍")} hint={span ? t("第 {a}–{b} 幀（共 {n} 幀）。範圍越短越快；跨鏡頭時後備路線容易追丟。", { a: span[0], b: span[1] - 1, n: span[1] - span[0] }) : undefined}>
          <Segmented options={scopeOptions} value={scope} onChange={(v) => setScope(v)} ariaLabel={t("範圍")} full />
        </Field>

        {busy === "find" && (
          <div className="flex items-center gap-2 rounded border border-fg/10 bg-fg/4 px-3 py-2 text-[12px] text-fg/75" data-testid="find-object-progress">
            <Spinner size={14} />
            <span className="flex-1">{job ? jobProgressText(job, t) : t("排隊中")}</span>
            <Button variant="ghost" size="sm" icon={X} onClick={() => cancelObjectJobs(mediaId)}>
              {t("取消")}
            </Button>
          </div>
        )}

        {error && <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

        {note && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning" data-testid="find-object-fallback">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{t(note.key, note.params)}</span>
          </div>
        )}

        {result && result.instances.length === 0 && (
          <div className="rounded border border-fg/10 bg-fg/4 px-3 py-2 text-[12px] text-fg/70">{t("沒找到「{text}」：換個說法（英文通常比較準）、換一段範圍，或用「選取物件」工具直接在畫面上點。", { text: resultText })}</div>
        )}

        {result && result.instances.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-[1fr_minmax(0,220px)]">
            <div className="max-h-72 space-y-1 overflow-auto pr-1" data-testid="find-object-instances">
              {result.instances.map((inst) => (
                <label key={inst.id} className={`flex items-center gap-2 rounded px-1.5 py-1 hover:bg-fg/6 ${ticked.has(inst.id) ? "" : "opacity-60"}`} data-instance={inst.id}>
                  <input type="checkbox" checked={ticked.has(inst.id)} onChange={() => toggle(inst.id)} />
                  {inst.thumb ? <img src={fileUrl(inst.thumb) ?? undefined} alt="" className="h-10 w-14 shrink-0 rounded object-cover bg-well" /> : <span className="h-10 w-14 shrink-0 rounded bg-well" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-fg/90">{labels.get(inst.id) ?? inst.phrase}</span>
                    <span className="block text-[11px] text-fg/50 mono">
                      {t("幀 {range} · 出現 {n} 幀 · 分數 {s}", { range: instanceFrames(inst), n: inst.framesPresent, s: inst.score.toFixed(2) })}
                    </span>
                  </span>
                  <span className="mono text-[11px] text-fg/40">#{inst.id}</span>
                </label>
              ))}
            </div>
            {result.overlay && (
              <figure className="space-y-1">
                <img src={fileUrl(result.overlay.path) ?? undefined} alt={t("疊色預覽")} className="w-full rounded border border-fg/10" data-testid="find-object-overlay" />
                <figcaption className="text-[11px] text-fg/50">{t("第 {k} 幀；編號對到左邊的清單", { k: result.overlay.frame })}</figcaption>
              </figure>
            )}
          </div>
        )}

        {result && (result.dropped > 0 || result.notes.length > 0) && (
          <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-fg/50">
            {result.dropped > 0 && <li>{t("另外有 {n} 個候選被去重、太短或超過上限而略過", { n: result.dropped })}</li>}
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        {!engineOk && !engineReady() && <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("引擎尚未就緒：找物件由引擎執行，要先安裝並啟動引擎。")}</div>}
      </div>
    </Modal>
  );
}
