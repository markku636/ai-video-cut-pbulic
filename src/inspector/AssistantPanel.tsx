import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { takeAssistantDraft, useAssistantDraft } from "../assistant/draft";
import { AlertTriangle, Bot, Check, Play, Send, Trash2, X } from "lucide-react";
import { api, errMessage } from "../api";
import { agentBackendOf } from "../assistant/backend";
import { TOOLS } from "../assistant/catalogue";
import { suggestedPrompts } from "../assistant/labels";
import { pickProvider, providerArgs } from "../assistant/provider";
import { buildPlan, parseModelPlan, planSummary, runnable, type Plan } from "../assistant/protocol";
import { resultNote, runStep, type RunContext, type StepResult } from "../assistant/run";
import { systemPrompt, type AssistantState } from "../assistant/systemPrompt";
import { command } from "../commands/registry";
import { useT } from "../i18n";
import { openDialog } from "../store/dialogs";
import { cacheDirOf } from "../pipeline/project";
import { durationFrames } from "../sequence/map";
import { useSettings } from "../store/settings";
import { usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { Button, EmptyState, IconButton, Input } from "../ui/index";
import { useActiveMedia, useActiveMediaId } from "../stage/active";
import { useEdits } from "./_contracts";
import AssistantCliChat from "./AssistantCliChat";

/**
 * AI 助手：用一句話驅動剪輯與影像處理。
 *
 * ## 人機協作的界線在哪
 *
 * 模型**只產生計畫**，這個面板把每一步列出來，使用者按「執行」才會動；會改東西的步驟標紅。
 * 這不是不信任模型 —— 是這些動作會改專案與寫檔案，而「看得懂正在發生什麼」本身就是功能的一部分。
 * 權限也不另開後門：`command` 類的工具照樣問指令自己的 `enabled()`，不能做的就是不能做，
 * 而且顯示的是同一句人話原因。
 *
 * ## 為什麼對話要走引擎
 *
 * App 的 CSP 不讓前端連外（`tauri.conf.json` 的 `connect-src`），所以 HTTP 一律經由
 * 引擎的 `assistant.chat`，跟字幕校對同一個端點設定。
 */
interface Turn {
  /** `note` = App 回報給模型的執行結果（不是使用者講的，UI 上也長得不一樣）。 */
  role: "user" | "assistant" | "note";
  text: string;
  plan?: Plan;
  results?: StepResult[];
}

export default function AssistantPanel() {
  const t = useT();
  const mediaId = useActiveMediaId();
  const media = useActiveMedia();
  const range = useTimeline((s) => s.range);
  const captions = useEdits((s) => (mediaId ? s.captions[mediaId] ?? null : null));
  const shots = useEdits((s) => (mediaId ? s.shots[mediaId] ?? [] : []));
  const sequence = useEdits((s) => s.sequence);
  const playhead = usePlayback((s) => s.frame);
  const llm = useSettings((s) => pickProvider(s.s));
  const backend = useSettings((s) => agentBackendOf(s.s.agent_backend));
  const outDir = useSettings((s) => s.s.output_dir || null);
  const sam = useSettings((s) => s.s.engine.sam_variant || "small");

  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  // 別處帶進來的一句話（開始畫面 / 物件分頁的「讓 AI 選」）：搬進輸入框，不直接送出
  const draft = useAssistantDraft((s) => s.draft);
  useEffect(() => {
    if (draft === null) return;
    const d = takeAssistantDraft();
    if (d) setText(d);
  }, [draft]);

  const fps = media?.proxy?.fps ?? { num: 30, den: 1 };
  const frames = media?.proxy?.frames ?? 0;
  const fpsNum = fps.num / (fps.den || 1);

  const state: AssistantState = useMemo(
    () => ({
      name: media?.name ?? "",
      durationSeconds: frames / (fpsNum || 1),
      fps: fpsNum,
      width: media?.proxy?.width ?? 0,
      height: media?.proxy?.height ?? 0,
      range: range ? { start: range.in / (fpsNum || 1), end: range.out / (fpsNum || 1) } : null,
      playheadSeconds: playhead / (fpsNum || 1),
      markers: sequence?.markers?.length ?? 0,
      hasCaptions: !!captions?.cues?.length,
      hasSequence: !!sequence && durationFrames(sequence) > 0,
      shots: shots.length,
      outDir: outDir ?? (media?.path ? media.path.slice(0, Math.max(0, media.path.lastIndexOf(media.path.includes("\\") ? "\\" : "/"))) : ""),
    }),
    [media, frames, fpsNum, range, playhead, captions, sequence, shots, outDir],
  );
  const prompts = useMemo(
    () => suggestedPrompts({ hasCaptions: state.hasCaptions, hasRange: !!state.range, shots: state.shots, durationSeconds: state.durationSeconds }),
    [state.hasCaptions, state.range, state.shots, state.durationSeconds],
  );

  const enabledOf = useCallback((id: string) => {
    const c = command(id);
    return c ? c.enabled() : null;
  }, []);

  const send = async () => {
    const q = text.trim();
    if (!q || busy || !media || !llm) return;
    setText("");
    const history = [...turns, { role: "user" as const, text: q }];
    setTurns(history);
    setBusy(true);
    try {
      const r = await api.engineCall<{ text: string }>(
        "assistant.chat",
        {
          ...providerArgs(llm!),
          system: systemPrompt(state),
          // note 也要帶：那是上一步的結果，模型要靠它才規劃得出下一步（引擎只收 user/assistant/system）
          message: history.slice(-8).map((x) => `${x.role === "note" ? "user" : x.role}:${x.text}`),
        },
        3 * 60_000,
      );
      const parsed = parseModelPlan(r.text);
      const plan = parsed ? buildPlan(parsed, enabledOf) : null;
      setTurns((prev) => [...prev, { role: "assistant", text: plan?.say || r.text.trim(), plan: plan ?? undefined }]);
    } catch (e) {
      setTurns((prev) => [...prev, { role: "assistant", text: errMessage(e) }]);
    } finally {
      setBusy(false);
    }
  };

  /** 執行第 i 輪的計畫。照順序 await —— 步驟常常互相依賴（先設範圍再剪）。 */
  const execute = async (i: number) => {
    const plan = turns[i]?.plan;
    if (!plan || !media || !mediaId || running != null) return;
    setRunning(i);
    const ctx: RunContext = { mediaId, video: media.path, fps, frames, cacheDir: await cacheDirOf(mediaId), sam, outDir, captions, shots };
    const out: StepResult[] = [];
    for (const step of plan.steps) {
      if (!runnable(step)) {
        out.push({ ok: false, message: step.problem! });
        continue;
      }
      try {
        out.push(await runStep(step, ctx, t));
      } catch (e) {
        out.push({ ok: false, message: errMessage(e) });
        break; // 一步真的失敗就停：後面那些通常靠它的結果
      }
      setTurns((prev) => prev.map((x, k) => (k === i ? { ...x, results: [...out] } : x)));
    }
    // 把結果回報給模型：多步流程（找目標 → 追蹤 → 虛化）靠這個才接得下去，
    // 否則框的座標只存在於結果裡，模型看不到
    const note = resultNote(plan.steps, out);
    setTurns((prev) => [...prev.map((x, k) => (k === i ? { ...x, results: out } : x)), ...(note ? [{ role: "note" as const, text: note }] : [])]);
    setRunning(null);
  };

  if (!mediaId) return <EmptyState icon={Bot} title={t("先開啟一支影片")} hint={t("助手會照這支影片目前的狀態規劃要做什麼。")} compact />;
  // 本機 CLI（claude / codex）：模型經 App 的 MCP server 直接呼叫同一組工具，對話長在另一個元件裡
  if (backend !== "http") return <AssistantCliChat backend={backend} prompts={prompts} />;
  if (!llm) {
    return (
      <EmptyState
        icon={Bot}
        title={t("還沒設定 AI 端點")}
        hint={t("助手需要一個本機模型服務（LM Studio、Ollama…）。對話與計畫都在本機，影片不會上傳。")}
        compact
        action={<Button onClick={() => openDialog("settings", { focus: "engine" })}>{t("去設定")}</Button>}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      {turns.length > 0 && (
        <div className="flex items-center justify-end border-b border-fg/8 px-2 py-1">
          {/* 送出時只帶最近幾則，對話長了之後舊的會被擠掉；清空是唯一能確定「重新開始」的方法 */}
          <IconButton
            icon={Trash2}
            label={t("清空對話")}
            iconSize={13}
            box="w-6 h-6"
            disabled={busy || running != null}
            onClick={() => setTurns([])}
            data-testid="assistant-clear"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!turns.length && <Intro onPick={setText} prompts={prompts} />}
        {turns.map((turn, i) => (
          <TurnView key={i} turn={turn} index={i} running={running === i} onRun={() => void execute(i)} canRun={running == null} />
        ))}
        {busy && <div className="py-2 text-fg/50">{t("想一下…")}</div>}
        <div ref={endRef} />
      </div>
      <div className="border-t border-fg/8 p-2">
        {/* 情境提示跟著狀態走（選了範圍 → 剪掉這段；沒字幕 → 先產生字幕）；有對話之後也留著，點一下就填進輸入框 */}
        {turns.length > 0 && !busy && running == null && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {prompts.slice(0, 3).map((x) => (
              <Chip key={x} label={t(x)} onClick={() => setText(t(x))} />
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // 只擋自己處理的鍵：Ctrl+K、F1 打字時照樣要能用（同字幕面板的規矩）
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                void send();
              }
            }}
            placeholder={t("例如：把背景虛化")}
            className="flex-1"
            spellCheck={false}
            data-testid="assistant-input"
          />
          <Button icon={Send} disabled={!text.trim() || busy} onClick={() => void send()} aria-label={t("送出（Enter）")} data-testid="assistant-send" />
        </div>
      </div>
    </div>
  );
}

function Chip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-full border border-fg/12 px-2 py-0.5 text-[11px] text-fg/60 hover:border-accent/50 hover:text-fg" data-testid="assistant-example">
      {label}
    </button>
  );
}

function Intro({ onPick, prompts }: { onPick: (s: string) => void; prompts: readonly string[] }) {
  const t = useT();
  return (
    <div className="space-y-2 py-2">
      <div className="text-fg/70">{t("用一句話講你想做什麼，助手會列出要做的步驟 —— 你按了才會動。")}</div>
      <div className="flex flex-wrap gap-1">
        {prompts.map((x) => (
          <Chip key={x} label={t(x)} onClick={() => onPick(t(x))} />
        ))}
      </div>
      <div className="text-[11px] text-fg/45">{t("它能做的事：")}</div>
      <ul className="space-y-0.5 text-[11px] text-fg/55">
        {TOOLS.map((x) => (
          <li key={x.name} className="flex gap-1.5">
            <span className="text-fg/30">·</span>
            <span>
              {t(x.title)}
              {x.danger && <span className="ml-1 text-warning/70">{t("（會改東西）")}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TurnView({ turn, index, running, canRun, onRun }: { turn: Turn; index: number; running: boolean; canRun: boolean; onRun: () => void }) {
  const t = useT();
  if (turn.role === "note") {
    return (
      <div className="mb-2 rounded border border-fg/8 bg-fg/[0.03] px-2 py-1.5 text-[11px] text-fg/45" data-testid={`assistant-note-${index}`}>
        <div className="mb-0.5 text-fg/35">{t("已回報給助手：")}</div>
        <pre className="whitespace-pre-wrap break-words font-sans">{turn.text}</pre>
      </div>
    );
  }
  if (turn.role === "user") {
    return (
      <div className="mb-2 flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent/15 px-2.5 py-1.5 text-fg/90">{turn.text}</div>
      </div>
    );
  }
  const plan = turn.plan;
  const ok = plan?.steps.filter(runnable).length ?? 0;
  return (
    <div className="mb-3" data-testid={`assistant-turn-${index}`}>
      <div className="mb-1.5 break-words text-fg/85">{turn.text}</div>
      {plan && plan.steps.length > 0 && (
        <div className="rounded border border-fg/10">
          {plan.steps.map((s, i) => {
            const r = turn.results?.[i];
            const bad = !runnable(s);
            return (
              <div key={i} className={`flex items-start gap-1.5 border-b border-fg/6 px-2 py-1 last:border-b-0 ${bad ? "opacity-60" : ""}`}>
                <span className="mt-px w-4 shrink-0 text-center text-[10px] text-fg/35">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className={s.tool.danger ? "text-warning" : ""}>{t(s.tool.title)}</span>
                    {s.tool.danger && <AlertTriangle size={11} className="shrink-0 text-warning/70" />}
                  </div>
                  {!!Object.keys(s.args).length && (
                    <div className="mono truncate text-[10px] text-fg/40">
                      {Object.entries(s.args)
                        .map(([k, v]) => `${k}=${v}`)
                        .join("  ")}
                    </div>
                  )}
                  {bad && <div className="text-[11px] text-danger/80">{t(s.problem!)}</div>}
                  {/* 「現在還不能按」：前面的步驟通常就會把狀態擺好，所以是提醒不是錯誤 */}
                  {!bad && s.warning && !r && <div className="text-[11px] text-fg/40">{t("現在還不行：{why}（前面的步驟可能會處理）", { why: t(s.warning) })}</div>}
                  {!bad && s.unused && !r && <div className="text-[11px] text-fg/40">{t("用不到的參數：{names}", { names: s.unused })}</div>}
                  {r && <div className={`text-[11px] ${r.ok ? "text-success" : "text-danger/80"}`}>{r.message}</div>}
                </div>
                {r && <span className="mt-px shrink-0">{r.ok ? <Check size={12} className="text-success" /> : <X size={12} className="text-danger" />}</span>}
              </div>
            );
          })}
          <div className="flex items-center gap-2 border-t border-fg/10 px-2 py-1.5">
            <span className="text-[11px] text-fg/50">{planSummary(plan, t)}</span>
            {!turn.results && ok > 0 && (
              <Button icon={Play} loading={running} disabled={!canRun} onClick={onRun} className="ml-auto" data-testid={`assistant-run-${index}`}>
                {t("執行")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
