import { useEffect, useState } from "react";
import { Crop, FolderOpen, Image } from "lucide-react";
import { api, errMessage } from "../api";
import { useT } from "../i18n";
import {
  applyReframe,
  defaultApplyOut,
  planReframe,
  REFRAME_FRAMINGS,
  REFRAME_OUT_SIZES,
  reframeSidecars,
  reframeSummary,
  type ReframeAspect,
  type ReframePlanResult,
} from "../pipeline/reframe";
import { engineReady } from "../store/engine";
import { selectActiveMedia, useProject } from "../store/project";
import { pickOpenFile, pickSaveFile, toast, uiConfirm } from "../ui";
import { Button, Field, Input, Modal, Segmented, Select } from "../ui/index";

/** 這裡只做「裁成別的比例」，所以不列 `source`。 */
const ASPECTS: ReframeAspect[] = ["9:16", "4:5", "1:1"];

/**
 * 轉成直幅／方形影片：對**任何一支影片檔**做自動重構圖，不需要專案。
 *
 * 為什麼要跟輸出對話框裡那一組分開：
 *
 * 1. 常見的需求是「手上已經有一支成片想轉直幅」—— 別的工具剪的、或這裡先輸出好的。
 *    那條路上沒有專案、沒有序列，輸出對話框的那一組用不上。
 * 2. **序列輸出的重構圖也只能走這裡**：序列幀與素材 proxy 幀是兩套幀號，
 *    所以先正常輸出序列成一支影片，再對那一支規劃與套用。對輸出好的那支來說只有一套幀號，
 *    問題自然消失。輸出對話框在序列模式下會擋掉重構圖並指向這裡。
 *
 * 流程與輸出對話框一致：先規劃（幾十秒、附預覽聯絡表）再轉換（一次編碼）。
 */
export default function ReframeVideoDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const media = useProject(selectActiveMedia);
  const mediaId = media?.id ?? "";

  const [video, setVideo] = useState(media?.path ?? "");
  const [aspect, setAspect] = useState<ReframeAspect>("9:16");
  const [text, setText] = useState("");
  const [sizeIdx, setSizeIdx] = useState(0);
  const [framingIdx, setFramingIdx] = useState(0);
  const [outPath, setOutPath] = useState(() => (media?.path ? defaultApplyOut(media.path, "9:16") : ""));
  const [plan, setPlan] = useState<ReframePlanResult | null>(null);
  const [busy, setBusy] = useState<"plan" | "run" | null>(null);

  // 換了來源或比例，之前規劃的路徑就不再對應這次的輸出
  useEffect(() => {
    setPlan(null);
    if (video) setOutPath(defaultApplyOut(video, aspect));
  }, [video, aspect]);
  // 構圖是規劃時就決定的（bias / zoom 進裁切路徑），換了就要重新規劃
  useEffect(() => setPlan(null), [framingIdx, text]);

  const pickVideo = async () => {
    const p = await pickOpenFile([{ name: t("影片"), extensions: ["mp4", "mkv", "webm", "mov", "m4v", "avi"] }]);
    if (p) setVideo(p);
  };

  const doPlan = async () => {
    if (!video) return;
    setBusy("plan");
    try {
      const { path, preview } = reframeSidecars(outPath, aspect);
      // range 不給：這條路一律規劃整支（reframe.apply 要求路徑幀數等於影片幀數）
      const tune = REFRAME_FRAMINGS[framingIdx]?.tune ?? {};
      setPlan(await planReframe(video, path, { aspect, text, range: null, trim: false, nFrames: 0 }, { ...tune, preview }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doRun = async () => {
    if (!plan || !video) return;
    const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
    const [exists] = await api.pathsExist([outPath]).catch(() => [false]);
    if (exists && !(await uiConfirm(t("{name} 已經存在，要覆蓋嗎？", { name: base(outPath) }), { danger: true, confirmText: t("覆蓋") }))) return;
    setBusy("run");
    try {
      const r = await applyReframe(mediaId, video, plan.path, outPath, REFRAME_OUT_SIZES[sizeIdx]?.size ?? null);
      toast.success(t("已輸出 {name}（{w}×{h}，{n} 幀）", { name: base(r.out), w: r.size[0], h: r.size[1], n: r.frames }));
      onClose();
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const ready = engineReady() && !!video && !!outPath;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("轉成直幅／方形影片")}
      icon={Crop}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button onClick={() => void doPlan()} loading={busy === "plan"} disabled={!ready || busy !== null} data-testid="reframe-video-plan">
            {plan ? t("重新規劃") : t("規劃鏡頭")}
          </Button>
          <Button variant="primary" icon={Crop} onClick={() => void doRun()} loading={busy === "run"} disabled={!ready || busy !== null || !plan} data-testid="reframe-video-run">
            {t("轉換並輸出")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="rounded border border-fg/10 bg-fg/4 px-3 py-2 text-[12px] text-fg/70">
          {t("對任何一支影片都可以用，不需要專案。剪過的序列要轉直幅也走這裡：先正常輸出成一支影片，再拿那一支進來。")}
        </div>

        <Field label={t("來源影片")}>
          <div className="flex gap-2">
            <Input value={video} onChange={(e) => setVideo(e.target.value)} className="flex-1 mono" spellCheck={false} placeholder={t("選一支影片")} />
            <Button variant="ghost" icon={FolderOpen} onClick={() => void pickVideo()}>
              {t("瀏覽…")}
            </Button>
          </div>
        </Field>

        <Field label={t("畫面比例")}>
          <Segmented options={ASPECTS.map((a) => ({ value: a, label: a }))} value={aspect} onChange={setAspect} ariaLabel={t("畫面比例")} className="w-full" />
        </Field>

        <Field label={t("鏡頭跟著")} hint={t("留空＝靜態置中裁切（不跑偵測，幾秒就好）。")}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("例如 person, face")} spellCheck={false} data-testid="reframe-video-text" />
        </Field>

        <Field label={t("構圖")} hint={t("人像通常要把臉放在偏上的位置（頭頂留白）；推近會裁得更小，主體更大但邊緣的東西會掉出去。")}>
          <Select value={String(framingIdx)} onChange={(e) => setFramingIdx(Number(e.target.value))} data-testid="reframe-video-framing">
            {REFRAME_FRAMINGS.map((f, i) => (
              <option key={f.label} value={i}>
                {t(f.label)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t("輸出尺寸")} hint={REFRAME_OUT_SIZES[sizeIdx]?.size ? t("會重新取樣一次。") : t("直接輸出裁切下來的尺寸，整條路沒有任何重取樣。")}>
          <Select value={String(sizeIdx)} onChange={(e) => setSizeIdx(Number(e.target.value))} data-testid="reframe-video-size">
            {REFRAME_OUT_SIZES.map((s, i) => (
              <option key={s.label} value={i}>
                {t(s.label)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t("輸出檔案")}>
          <div className="flex gap-2">
            <Input value={outPath} onChange={(e) => setOutPath(e.target.value)} className="flex-1 mono" spellCheck={false} />
            <Button variant="ghost" icon={FolderOpen} onClick={() => void pickSaveFile(outPath, [{ name: t("影片"), extensions: ["mp4", "mkv", "webm", "mov"] }]).then((p) => p && setOutPath(p))}>
              {t("另存為…")}
            </Button>
          </div>
        </Field>

        {plan && (
          <div className="space-y-2 rounded border border-fg/10 bg-fg/4 px-3 py-2" data-testid="reframe-video-plan-result">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="flex-1 text-success">{reframeSummary(plan, t)}</span>
              {plan.preview && (
                <Button variant="ghost" size="sm" icon={Image} onClick={() => void api.openPath(plan.preview!)}>
                  {t("開啟原圖")}
                </Button>
              )}
            </div>
            {/* 等距取幾格裁好的畫面。直接畫在這裡，不必離開對話框就看得出鏡頭有沒有跟對人 */}
            {plan.previewData && <img src={`data:image/jpeg;base64,${plan.previewData}`} alt={t("預覽")} className="w-full rounded" data-testid="reframe-video-preview-img" />}
          </div>
        )}
        {!engineReady() && <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("引擎尚未就緒：重構圖由引擎執行，要先安裝並啟動引擎。")}</div>}
      </div>
    </Modal>
  );
}
