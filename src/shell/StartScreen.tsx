import { useState } from "react";
import { Bot, FileJson, FileVideo, FolderOpen, Film, MousePointerClick, TextSearch, X } from "lucide-react";
import { openMedia } from "../commands/appActions";
import { command, runCommand, useCommandTick } from "../commands/registry";
import { useT } from "../i18n";
import { askAiToPick, startSelectTool } from "../objects/actions";
import { plugins } from "../plugins/registry";
import { baseName, kindOf, removeRecent } from "../project/recent";
import { openDialog } from "../store/dialogs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import Icon from "../ui/Icon";
import { Button } from "../ui/index";
import { startCards, startGridClass, TRACK_ANYTHING_KEY, TRACK_ANYTHING_LINKS, trackAnythingAction, type StartCard, type TrackAnythingAction } from "./startCards";

const CARD_CLASS = "text-left rounded-lg border border-fg/10 bg-elevated transition-colors p-4";

/**
 * 沒開檔時的畫面：「你想做什麼？」卡片（核心 + 外掛）+ 拖放區 + 最近開啟（計畫 §9 Start Screen）。
 * 選卡片 = 設 profile → 開檔 → 引擎就緒時接著跑卡片的指令（例如自動偵測）。
 * 「追蹤任何東西」卡片上直接打字：開檔之後打開「找物件」並用那句話找（引擎或 proxy 還沒好時對話框會等著、講原因）。
 */
export default function StartScreen() {
  const t = useT();
  useCommandTick();
  const recent = useSettings((s) => s.s.recent_projects);
  const save = useSettings((s) => s.save);
  const dragOver = useUi((s) => s.dragOver);
  const setProfile = useUi((s) => s.setProfile);
  const cards = startCards();

  /** 開檔；回傳有沒有真的開了一支新的。 */
  const open = async (card?: StartCard): Promise<boolean> => {
    if (card) {
      setProfile(card.profile);
      useProject.getState().setProfile(card.profile);
    }
    const before = useProject.getState().activeMediaId;
    await openMedia();
    const after = useProject.getState().activeMediaId;
    const opened = !!after && after !== before;
    // 真的開起來才通知外掛（例如牌外掛：依開始畫面的卡片定下這個 session 的意圖）。
    // 一定要在 openMedia 之後 —— openMedia 會先讓外掛清掉上一次的狀態，取消檔案對話框時就不會留下一個拔不掉的模式。
    if (card && opened) for (const p of plugins()) p.onStartCardOpened?.(card.key);
    return opened;
  };

  const pick = async (card?: StartCard) => {
    const opened = await open(card);
    // 引擎沒就緒時不跑（會 toast 一句「引擎尚未就緒」當噪音）；SetupBanner 會帶人去安裝
    if (card?.after && opened && command(card.after)?.enabled().ok) void runCommand(card.after, "startcard");
  };

  const trackAnything = async (card: StartCard, action: TrackAnythingAction) => {
    if (!(await open(card))) return;
    if (action.kind === "find") openDialog("findObject", { text: action.text, autoRun: true });
    else if (action.kind === "findEmpty") openDialog("findObject", {});
    else if (action.kind === "select") startSelectTool();
    else askAiToPick(action.text);
  };

  return (
    <div className={`flex-1 min-h-0 overflow-auto p-6 flex flex-col items-center justify-center gap-6 transition-colors ${dragOver ? "bg-accent/10" : ""}`} data-testid="start-screen">
      <div className="w-full max-w-3xl space-y-5">
        <div>
          <div className="text-lg font-semibold text-fg/90 mb-3">{t("你想做什麼？")}</div>
          <div className={`grid gap-3 ${startGridClass(cards.length)}`}>
            {cards.map((c) =>
              c.key === TRACK_ANYTHING_KEY ? (
                <TrackAnythingCard key={c.key} card={c} onAction={(a) => void trackAnything(c, a)} />
              ) : (
                <button
                  key={c.key}
                  type="button"
                  data-card={c.key}
                  onClick={() => void pick(c)}
                  className={`${CARD_CLASS} hover:bg-fg/5 hover:border-accent/40 focus-visible:outline-2 focus-visible:outline-accent/60`}
                >
                  <div className="flex items-center gap-2 text-fg/90 font-medium">
                    <Icon icon={c.icon} size={18} className="text-accent" />
                    {t(c.title)}
                  </div>
                  <div className="mt-1 text-[12px] text-fg/50 leading-relaxed">{t(c.line)}</div>
                </button>
              ),
            )}
          </div>
        </div>

        <div className={`rounded-lg border-2 border-dashed p-6 text-center ${dragOver ? "border-accent bg-accent/10" : "border-fg/15"}`}>
          <div className="flex items-center justify-center gap-2 text-fg/60 text-sm">
            <Icon icon={Film} size={18} />
            {t("把 mp4 / mov / webm 拖進來，或按「開啟影片」。")}
          </div>
          <div className="mt-3">
            <Button variant="primary" icon={FolderOpen} onClick={() => void pick()} data-cmd="file.open">
              {t("開啟影片…")}
            </Button>
          </div>
          <div className="mt-2 text-[11px] text-fg/40">{t("本機 GPU 運算，影片不上傳，不用於訓練")}</div>
        </div>

        {recent.length > 0 && (
          <div>
            <div className="text-[11px] text-fg/40 uppercase tracking-wide mb-2">{t("最近開啟")}</div>
            <div className="rounded-md border border-fg/10 divide-y divide-fg/5 bg-elevated">
              {recent.map((p) => (
                <div key={p} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-fg/5 group">
                  <Icon icon={kindOf(p) === "project" ? FileJson : FileVideo} size={15} className="text-fg/50 shrink-0" />
                  <button type="button" onClick={() => void openMedia(p)} title={p} className="flex-1 min-w-0 text-left truncate text-fg/85 hover:text-accent">
                    {baseName(p)}
                  </button>
                  <button
                    type="button"
                    onClick={() => void save({ recent_projects: removeRecent(recent, p) })}
                    title={t("從清單移除")}
                    className="opacity-0 group-hover:opacity-100 text-fg/40 hover:text-fg/80"
                  >
                    <Icon icon={X} size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-[11px] text-fg/35">
          Ctrl+O {t("開啟影片…")} · Ctrl+K {t("搜尋指令")} · F1 {t("快捷鍵")}
        </div>
      </div>
    </div>
  );
}

/** 「追蹤任何東西」：卡片上直接打要找的東西；Enter 或主按鈕 = 開影片並尋找，底下兩個次要連結。 */
function TrackAnythingCard({ card, onAction }: { card: StartCard; onAction: (a: TrackAnythingAction) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  return (
    <div data-card={card.key} className={`${CARD_CLASS} border-accent/30 hover:border-accent/50 flex flex-col gap-2`}>
      <div className="flex items-center gap-2 text-fg/90 font-medium">
        <Icon icon={card.icon} size={18} className="text-accent" />
        {t(card.title)}
      </div>
      <div className="text-[12px] text-fg/50 leading-relaxed">{t(card.line)}</div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          onAction(trackAnythingAction("go", text));
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t(TRACK_ANYTHING_LINKS.placeholder)}
          aria-label={t(card.title)}
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-fg/15 bg-inset px-2 py-1 text-[13px] text-fg placeholder:text-fg/35 focus:border-accent/60 focus:outline-none"
          data-testid="start-track-text"
        />
        <Button type="submit" variant="primary" size="sm" icon={TextSearch} data-testid="start-track-go">
          {text.trim() ? t(TRACK_ANYTHING_LINKS.go) : t(TRACK_ANYTHING_LINKS.goEmpty)}
        </Button>
      </form>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        <button type="button" className="inline-flex items-center gap-1 text-fg/55 hover:text-accent" onClick={() => onAction(trackAnythingAction("select", text))}>
          <MousePointerClick size={13} />
          {t(TRACK_ANYTHING_LINKS.select)}
        </button>
        <button type="button" className="inline-flex items-center gap-1 text-fg/55 hover:text-accent" onClick={() => onAction(trackAnythingAction("ai", text))}>
          <Bot size={13} />
          {t(TRACK_ANYTHING_LINKS.ai)}
        </button>
      </div>
    </div>
  );
}
