import { useEffect, useMemo, useState } from "react";
import { Eraser, FolderOpen, Image, ScanSearch } from "lucide-react";
import { api, errMessage } from "../api";
import { useT } from "../i18n";
import { cacheDirOf } from "../pipeline/project";
import { defaultRemoveOut, findAndTrack, MAX_REMOVE_OBJECTS, planPlate, platePathFor, removeObject, removeSummary, type RemoveObjectOpts, type RemoveObjectResult } from "../pipeline/removeObject";
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
 * 移除物件：把追蹤到的東西從畫面上拿掉，用其他幀真正拍到的背景補回來。
 *
 * 流程刻意是兩步：**先算背景板**（幾秒，附一張 PNG 可以直接看）再輸出（整支重新編碼）。
 * 背景板那一張圖就能看出這段素材行不行 —— 鏡頭有沒有動、背景有沒有露出來過 ——
 * 而那兩件事正是這條路唯二會失敗的原因。讓人先看那張圖，比讓人等完整支再發現不行好。
 *
 * 只列出**已經有遮罩**的追蹤：遮罩是「物件遮罩」那條路的產物，沒有遮罩就沒有東西可以移除，
 * 與其讓人選了才報錯，不如一開始就講「先跑遮罩傳播」。
 */
export default function RemoveObjectDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const media = useProject(selectActiveMedia);
  const mediaId = media?.id ?? "";
  const tracks = useEdits((s) => (mediaId ? s.tracks[mediaId] ?? [] : []));
  const shots = useEdits((s) => (mediaId ? s.shots[mediaId] ?? [] : []));
  const range = useTimeline((s) => s.range);
  const outDir = useSettings((s) => s.s.output_dir || null);

  /** trackId → 遮罩檔；解不到的就是還沒跑過遮罩傳播。 */
  const [masks, setMasks] = useState<Record<string, string> | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [outPath, setOutPath] = useState(() => defaultRemoveOut(media?.path ?? "out.mp4", outDir));
  const [shadow, setShadow] = useState(true);
  const [onlyRange, setOnlyRange] = useState(!!range);
  const [plate, setPlate] = useState<RemoveObjectResult | null>(null);
  const [busy, setBusy] = useState<"plate" | "run" | "find" | null>(null);

  // 兩種來源：專案裡已經框好的追蹤，或現場用文字找。
  // 文字那條路把「文字 → 框 → 逐幀遮罩」跑完之後，後面的步驟與追蹤那條路完全一樣。
  const [source, setSource] = useState<"tracks" | "text">("tracks");
  const [findText, setFindText] = useState("");
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
  const shotOf = (id: string) => shots.find((s) => s.id === id) ?? null;
  const fps = media?.proxy?.fps ?? { num: 30, den: 1 };

  // 參數一動，算好的背景板就作廢（顯示的數字一定要對應目前的設定）
  useEffect(() => setPlate(null), [picked, onlyRange, shadow, source, textMasks]);

  const maskPaths = source === "text" ? textMasks : [...picked].map((id) => masks?.[id] ?? "").filter(Boolean);

  const opts = (out: string | null): RemoveObjectOpts => ({
    maskPaths,
    range: onlyRange ? range : null,
    outPath: out,
    platePath: platePathFor(outPath),
    shadow,
    dilate: null,
  });

  const doFind = async () => {
    if (!media || !findText.trim()) return;
    setBusy("find");
    setFound(null);
    setTextMasks([]);
    setPlate(null);
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

  const doPlate = async () => {
    if (!media || !maskPaths.length) return;
    setBusy("plate");
    try {
      setPlate(await planPlate(media.path, opts(null)));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doRun = async () => {
    if (!media || !maskPaths.length) return;
    const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
    const [exists] = await api.pathsExist([outPath]).catch(() => [false]);
    if (exists && !(await uiConfirm(t("{name} 已經存在，要覆蓋嗎？", { name: base(outPath) }), { danger: true, confirmText: t("覆蓋") }))) return;
    setBusy("run");
    try {
      const r = await removeObject(mediaId, media.path, opts(outPath));
      toast.success(t("移除完成：{name}（{n} 幀）", { name: base(r.out ?? outPath), n: r.frames ?? 0 }));
      onClose();
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

  const ready = engineReady() && maskPaths.length > 0 && !!media;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("移除物件")}
      icon={Eraser}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button onClick={() => void doPlate()} loading={busy === "plate"} disabled={!ready || busy !== null} data-testid="remove-object-plate">
            {t("算背景板")}
          </Button>
          <Button variant="primary" icon={Eraser} onClick={() => void doRun()} loading={busy === "run"} disabled={!ready || busy !== null || !outPath} data-testid="remove-object-run">
            {t("移除並輸出")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="rounded border border-fg/10 bg-fg/4 px-3 py-2 text-[12px] text-fg/70">
          {t("補進去的畫面是這支影片其他幀真正拍到的，不是生成的。所以：靜止機位上會移動的東西可以移除；整段都沒露出過的背景、或鏡頭在移動的素材不行（會直接擋下來並說明）。")}
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
          <Field
            label={t("要移除什麼")}
            hint={t("最多同時追 {n} 個（逐幀傳播的時間與數量成正比）。英文通常比較準。", { n: MAX_REMOVE_OBJECTS })}
          >
            <div className="flex gap-2">
              <Input
                value={findText}
                onChange={(e) => setFindText(e.target.value)}
                placeholder={t("例如 hand、person、logo")}
                className="flex-1"
                spellCheck={false}
                data-testid="remove-object-text"
              />
              <Button icon={ScanSearch} loading={busy === "find"} disabled={!engineReady() || !media?.proxy || !findText.trim() || busy !== null} onClick={() => void doFind()} data-testid="remove-object-find">
                {textMasks.length ? t("重新找") : t("找目標並追蹤")}
              </Button>
            </div>
            {found && (
              <div className="mt-1.5 text-[12px] text-success" data-testid="remove-object-found">
                {t("在第 {k} 幀找到 {n} 個，追蹤了 {m} 個", { k: found.anchor, n: found.hits, m: found.used })}
              </div>
            )}
          </Field>
        )}

        {source === "tracks" && (
        <Field label={t("要移除哪些")} hint={masks && !withMasks.length ? t("這支素材還沒有任何物件遮罩：先在「遮罩」分頁框出物件並做一次傳播。") : t("列出已經有遮罩的追蹤；可以一次移除多個。")}>
          {masks === null ? (
            <div className="text-fg/50">{t("正在找遮罩…")}</div>
          ) : (
            <div className="max-h-44 space-y-1 overflow-auto" data-testid="remove-object-tracks">
              {withMasks.map((tr) => {
                const sh = shotOf(tr.shotId);
                return (
                  <label key={tr.id} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-fg/6">
                    <input type="checkbox" checked={picked.has(tr.id)} onChange={() => toggle(tr.id)} />
                    <span className="flex-1 truncate">{tr.label || tr.id}</span>
                    {sh && <span className="mono text-[11px] text-fg/45">{`${timecode(sh.startFrame, fps)} – ${timecode(sh.endFrame, fps)}`}</span>}
                  </label>
                );
              })}
            </div>
          )}
        </Field>
        )}

        <Field label={t("選項")}>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={shadow} onChange={(e) => setShadow(e.target.checked)} data-testid="remove-object-shadow" />
              <span>{t("連影子一起移除")}</span>
            </label>
            <div className="pl-6 text-[11px] text-fg/55">{t("只換掉物件、留著它的影子，輪廓反而會被自己的影子描出來。旁邊比背景亮的東西（例如白紙）不會被動到。")}</div>
            {range && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={onlyRange} onChange={(e) => setOnlyRange(e.target.checked)} data-testid="remove-object-range" />
                <span>{t("只處理入點到出點（{a} – {b}）", { a: timecode(range.in, fps), b: timecode(range.out, fps) })}</span>
              </label>
            )}
          </div>
        </Field>

        <Field label={t("輸出檔案")}>
          <div className="flex gap-2">
            <Input value={outPath} onChange={(e) => setOutPath(e.target.value)} className="flex-1 mono" spellCheck={false} />
            <Button
              variant="ghost"
              icon={FolderOpen}
              onClick={() => void pickSaveFile(outPath, [{ name: t("影片"), extensions: ["mp4", "mkv", "webm", "mov"] }]).then((p) => p && setOutPath(p))}
            >
              {t("另存為…")}
            </Button>
          </div>
        </Field>

        {plate && (
          <div className="space-y-2 rounded border border-fg/10 bg-fg/4 px-3 py-2" data-testid="remove-object-plate-result">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="flex-1 text-fg/80">{removeSummary(plate, t)}</span>
              {plate.plate && (
                <Button variant="ghost" size="sm" icon={Image} onClick={() => void api.openPath(plate.plate!)}>
                  {t("開啟原圖")}
                </Button>
              )}
            </div>
            {/* 重建出來的背景。看這一張就知道這段素材行不行 —— 有沒有殘影、該露出的地方有沒有露出來 */}
            {plate.plateData && <img src={`data:image/jpeg;base64,${plate.plateData}`} alt={t("背景板")} className="w-full rounded" data-testid="remove-object-plate-img" />}
          </div>
        )}
        {!engineReady() && <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("引擎尚未就緒：移除物件由引擎執行，要先安裝並啟動引擎。")}</div>}
      </div>
    </Modal>
  );
}
