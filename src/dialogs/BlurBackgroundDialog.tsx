import { useEffect, useMemo, useState } from "react";
import { Aperture, FolderOpen, ScanSearch } from "lucide-react";
import { api, errMessage } from "../api";
import { useT } from "../i18n";
import { blurBackground, blurSummary, colorArg, defaultBlurOut, STRENGTH_MAX, STRENGTH_MIN, STRENGTH_STEP, type BlurBackgroundResult } from "../pipeline/blurBackground";
import { cacheDirOf } from "../pipeline/project";
import { findAndTrack, MAX_REMOVE_OBJECTS } from "../pipeline/removeObject";
import { maskFileFor } from "../pipeline/track";
import { useEdits } from "../store/edits";
import { engineReady } from "../store/engine";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { timecode } from "../time";
import { pickSaveFile, toast, uiConfirm } from "../ui";
import { Button, Field, Input, Modal, Segmented } from "../ui/index";

/**
 * 背景虛化 / 換色（對標 CapCut、Riverside、Premiere 的人像模式）。
 *
 * **前半跟「移除物件」是同一個對話框的形狀**（來源＝專案的追蹤 / 用文字找），因為前半真的是
 * 同一件事：都要先有主體的逐幀遮罩。差別只在最後一步換掉遮罩的裡面還是外面。
 *
 * 沒有「先算背景板」那一步：這條路不需要背景板，也就沒有「鏡頭不能動」「背景要露出過」
 * 那兩個守門員 —— 對任何素材都成立，所以直接輸出就好。
 */
const DEFAULT_STRENGTH = 1.5; // 引擎的預設（實測見 plugins/cards/docs/measurements.md）；滑桿要有初值才顯示得出來

export default function BlurBackgroundDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const media = useProject(selectActiveMedia);
  const mediaId = media?.id ?? "";
  const range = useTimeline((s) => s.range);
  const tracks = useEdits((s) => (mediaId ? s.tracks[mediaId] ?? [] : []));

  const outDir = useSettings((s) => s.s.output_dir || null);
  const [masks, setMasks] = useState<Record<string, string> | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [outPath, setOutPath] = useState(() => defaultBlurOut(media?.path ?? "out.mp4", outDir));
  const [onlyRange, setOnlyRange] = useState(!!range);
  const [mode, setMode] = useState<"blur" | "color">("blur");
  const [strength, setStrength] = useState(DEFAULT_STRENGTH);
  const [hex, setHex] = useState("#0a1f14");
  const [busy, setBusy] = useState<"find" | "run" | null>(null);
  const [done, setDone] = useState<BlurBackgroundResult | null>(null);

  const [source, setSource] = useState<"tracks" | "text">("tracks");
  const [findText, setFindText] = useState("person");
  const [textMasks, setTextMasks] = useState<string[]>([]);
  const [found, setFound] = useState<{ hits: number; used: number; anchor: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!mediaId) return setMasks({});
      const dir = await cacheDirOf(mediaId);
      const found: Record<string, string> = {};
      for (const tr of tracks) {
        const f = await maskFileFor(dir, tr.id);
        if (f) found[tr.id] = f;
      }
      if (!alive) return;
      setMasks(found);
      setPicked(new Set(Object.keys(found).slice(0, 1)));
    })();
    return () => {
      alive = false;
    };
  }, [mediaId, tracks]);

  const withMasks = useMemo(() => tracks.filter((tr) => masks?.[tr.id]), [tracks, masks]);
  const fps = media?.proxy?.fps ?? { num: 30, den: 1 };
  const maskPaths = source === "text" ? textMasks : [...picked].map((id) => masks?.[id] ?? "").filter(Boolean);
  const color = mode === "color" ? colorArg(hex) : null;
  const badColor = mode === "color" && !color;

  const doFind = async () => {
    if (!media || !findText.trim()) return;
    setBusy("find");
    setFound(null);
    setTextMasks([]);
    setDone(null);
    try {
      const r = await findAndTrack(
        mediaId, media.path, findText.trim(), onlyRange ? range : null,
        media.proxy?.frames ?? 0, outPath, useSettings.getState().s.engine.sam_variant || "small",
      );
      setTextMasks(r.maskPaths);
      setFound({ hits: r.hits.length, used: r.maskPaths.length, anchor: r.anchor });
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doRun = async () => {
    if (!media || !maskPaths.length || badColor) return;
    const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
    const [exists] = await api.pathsExist([outPath]).catch(() => [false]);
    if (exists && !(await uiConfirm(t("{name} 已經存在，要覆蓋嗎？", { name: base(outPath) }), { danger: true, confirmText: t("覆蓋") }))) return;
    setBusy("run");
    try {
      const r = await blurBackground(mediaId, media.path, { maskPaths, range: onlyRange ? range : null, outPath, strength: mode === "blur" ? strength : null, color });
      setDone(r);
      if (r.missingFrames) toast.info(blurSummary(r, t));
      else toast.success(blurSummary(r, t));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const ready = engineReady() && maskPaths.length > 0 && !!media && !badColor;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("背景虛化")}
      icon={Aperture}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Button variant="primary" icon={Aperture} loading={busy === "run"} disabled={!ready || busy !== null} onClick={() => void doRun()} data-testid="portrait-run">
            {t("輸出")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="text-[12px] leading-relaxed text-fg/60">
          {t("主體留著、背景糊掉（或換成純色）。主體邊緣不會有一圈自己的殘影 —— 模糊時主體的像素完全不參與平均。")}
        </div>

        <Field label={t("來源")} hint={t("專案裡框好的追蹤遮罩比較準；用文字找則是現場跑一次偵測與追蹤，不必先建追蹤。")}>
          <Segmented
            options={[
              { value: "tracks", label: t("專案的追蹤") },
              { value: "text", label: t("用文字找") },
            ]}
            value={source}
            onChange={(v) => setSource(v as "tracks" | "text")}
            ariaLabel={t("來源")}
            className="w-full"
          />
        </Field>

        {source === "text" && (
          <Field label={t("主體是什麼")} hint={t("最多同時追 {n} 個（逐幀傳播的時間與數量成正比）。英文通常比較準。", { n: MAX_REMOVE_OBJECTS })}>
            <div className="flex gap-2">
              <Input value={findText} onChange={(e) => setFindText(e.target.value)} placeholder={t("例如 person、hand")} className="flex-1" spellCheck={false} data-testid="portrait-text" />
              <Button icon={ScanSearch} loading={busy === "find"} disabled={!engineReady() || !media?.proxy || !findText.trim() || busy !== null} onClick={() => void doFind()} data-testid="portrait-find">
                {textMasks.length ? t("重新找") : t("找主體並追蹤")}
              </Button>
            </div>
            {found && (
              <div className="mt-1.5 text-[12px] text-success" data-testid="portrait-found">
                {t("在第 {k} 幀找到 {n} 個，追蹤了 {m} 個", { k: found.anchor, n: found.hits, m: found.used })}
              </div>
            )}
          </Field>
        )}

        {source === "tracks" && (
          <Field label={t("哪些是主體")} hint={masks && !withMasks.length ? t("這支素材還沒有任何物件遮罩：先在「遮罩」分頁框出主體並做一次傳播。") : t("列出已經有遮罩的追蹤；可以一次選多個。")}>
            {masks === null ? (
              <div className="text-fg/50">{t("正在找遮罩…")}</div>
            ) : (
              <div className="max-h-40 space-y-0.5 overflow-auto">
                {withMasks.map((tr) => (
                  <label key={tr.id} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-fg/6">
                    <input type="checkbox" checked={picked.has(tr.id)} onChange={() => toggle(tr.id)} />
                    <span className="flex-1 truncate">{tr.label || tr.id}</span>
                  </label>
                ))}
              </div>
            )}
          </Field>
        )}

        <Field label={t("背景要怎樣")}>
          <Segmented
            options={[
              { value: "blur", label: t("虛化") },
              { value: "color", label: t("換成純色") },
            ]}
            value={mode}
            onChange={(v) => setMode(v as "blur" | "color")}
            ariaLabel={t("背景要怎樣")}
            className="w-full"
          />
          {mode === "blur" ? (
            <div className="mt-2 flex items-center gap-3">
              <input
                type="range"
                min={STRENGTH_MIN}
                max={STRENGTH_MAX}
                step={STRENGTH_STEP}
                value={strength}
                onChange={(e) => setStrength(Number(e.target.value))}
                className="flex-1 accent-accent"
                aria-label={t("虛化強度")}
                data-testid="portrait-strength"
              />
              <span className="mono w-16 shrink-0 text-right text-[12px] tabular-nums text-fg/70">{strength.toFixed(1)}%</span>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <input type="color" value={hex} onChange={(e) => setHex(e.target.value)} className="h-7 w-12 rounded border border-fg/15 bg-transparent" aria-label={t("背景顏色")} data-testid="portrait-color" />
              <Input value={hex} onChange={(e) => setHex(e.target.value)} className="mono w-28" spellCheck={false} />
              {badColor && <span className="text-[12px] text-danger">{t("顏色要寫成 #RRGGBB")}</span>}
            </div>
          )}
          <div className="mt-1.5 text-[11px] text-fg/55">
            {mode === "blur"
              ? t("強度是畫面寬度的百分比，所以 720p 與 4K 看起來一樣強。實測 1.5% 時材質沒了、構圖還在；再高只是變慢。")
              : t("常見用途是去識別化或做去背的粗胚。邊緣一樣有羽化，不會是硬邊。")}
          </div>
        </Field>

        <Field label={t("選項")}>
          {range && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={onlyRange} onChange={(e) => setOnlyRange(e.target.checked)} data-testid="portrait-range" />
              <span>{t("只處理入點到出點（{a} – {b}）", { a: timecode(range.in, fps), b: timecode(range.out, fps) })}</span>
            </label>
          )}
        </Field>

        <Field label={t("輸出到")}>
          <div className="flex gap-2">
            <Input value={outPath} onChange={(e) => setOutPath(e.target.value)} className="mono flex-1" spellCheck={false} data-testid="portrait-out" />
            <Button
              icon={FolderOpen}
              onClick={() => void pickSaveFile(outPath, [{ name: t("影片"), extensions: ["mp4", "mkv", "webm", "mov"] }]).then((p) => p && setOutPath(p))}
              aria-label={t("選擇輸出位置")}
            />
          </div>
        </Field>

        {done && (
          <div className="rounded border border-fg/10 bg-fg/4 px-3 py-2 text-[12px]" data-testid="portrait-done">
            <span className={done.missingFrames ? "text-warning" : "text-success"}>{blurSummary(done, t)}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
