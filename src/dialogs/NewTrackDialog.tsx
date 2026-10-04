import { useMemo, useState } from "react";
import { PlusCircle, Shapes } from "lucide-react";
import { api, errMessage } from "../api";
import { useT } from "../i18n";
import { engineReady } from "../store/engine";
import { type MotionModel, type Quad } from "../project/format";
import { useEdits } from "../store/edits";
import { plugins } from "../plugins/registry";
import { GENERIC_PROFILE, workProfile } from "../project/profiles";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useUi } from "../store/ui";
import { toast } from "../ui";
import { quadFromMask } from "../pipeline/track";
import { centeredBoxQuad, rectQuad } from "../video/quad";
import { MOTION_MODEL_LABEL } from "../video/labels";
import { Button, Field, Input, Modal, Select } from "../ui/index";

const MOTION_MODELS: MotionModel[] = ["translation", "similarity", "affine", "perspective"];
const EMPTY: never[] = [];

/** `seg.text_boxes` 的回傳：框是來源像素的 (x, y, w, h)。 */
interface TextBoxHit {
  box: [number, number, number, number];
  phrase: string;
  score: number;
}

/**
 * 新增追蹤（計畫 §9 `newTrack{frame,quad?,fromMask?}`）。沒給 quad（從指令 / N 鍵進來）就在畫面中央放一個 16:9 的框
 * （來源像素、寬約畫面 40%：螢幕、海報、招牌最常見的形狀），讓人拖四角對準；有 quad（舞台拖出來的）就直接用。
 * 也可以從一個已經追蹤好的物件取四角（geom.quad_from_mask：那個物件這一幀的遮罩 → 四邊形）。
 */
export default function NewTrackDialog({ mediaId, frame, quad, fromMask = false, onClose }: { mediaId: string; frame: number; quad?: Quad; fromMask?: boolean; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const profile = useProject((s) => s.profile);
  const tracks = useEdits((s) => s.tracks[mediaId] ?? EMPTY);
  // 預設名稱看工作模式（外掛的工作模式可以給自己的說法；一般平面替換：「平面 {n}」）
  const [label, setLabel] = useState(t(workProfile(profile)?.newTrackLabel ?? GENERIC_PROFILE.newTrackLabel!, { n: tracks.length + 1 }));
  // 外掛的 track 鍵（例如 cards：連結的格位 slotId），由外掛的欄位元件填
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [motionModel, setMotionModel] = useState<MotionModel>("perspective");
  // 用文字找要追蹤的東西（OWLv2 → 框）。找到的框只是**候選**：模型會把同類物件群組起來，
  // 所以一定讓人看到分數與大小再選，不自動套用（量測文件「文字提示找框」有實例）。
  const [text, setText] = useState("");
  const [found, setFound] = useState<TextBoxHit[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  // 從物件遮罩取四角：選一個物件 → 引擎把那個物件這一幀的遮罩擬合成四邊形
  const objects = useMemo(() => tracks.filter((x) => x.kind === "object"), [tracks]);
  const [objId, setObjId] = useState<string>("");
  const [maskQuad, setMaskQuad] = useState<{ quad: Quad; conf: number; objId: string } | null>(null);
  const [maskBusy, setMaskBusy] = useState(false);
  const [maskNote, setMaskNote] = useState<string | null>(null);

  const proxyPath = media?.proxy?.path ?? null;
  const find = async () => {
    if (!proxyPath || !text.trim()) return;
    setFinding(true);
    setFound(null);
    setPicked(null);
    try {
      const r = await api.engineCall<{ boxes: TextBoxHit[] }>("seg.text_boxes", { video: proxyPath, frame, text }, 120_000);
      setFound(r.boxes ?? []);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setFinding(false);
    }
  };

  const w = media?.probe?.video?.width ?? media?.proxy?.width ?? 1920;
  const h = media?.probe?.video?.height ?? media?.proxy?.height ?? 1080;

  const fromObject = async () => {
    const id = objId || objects[0]?.id;
    if (!id) return;
    setMaskBusy(true);
    setMaskNote(null);
    setMaskQuad(null);
    try {
      const r = await quadFromMask(mediaId, id, frame);
      if (!r) setMaskNote(t("這個物件還沒有遮罩檔"));
      else if (!r.quad || r.quad.length !== 4) setMaskNote(t("物件在第 {frame} 幀不在畫面上，或取不出四角（{method}）", { frame, method: r.method }));
      else setMaskQuad({ quad: { p: r.quad.map(([x, y]) => [x, y]) as Quad["p"] }, conf: r.conf, objId: id });
    } catch (e) {
      setMaskNote(errMessage(e));
    } finally {
      setMaskBusy(false);
    }
  };

  const create = () => {
    const hit = picked != null ? found?.[picked] : null;
    // 優先序：舞台拖出來的框 > 從物件遮罩取的四角 > 文字找到並選中的框 > 畫面中央的預設框（16:9）
    const q = quad ?? maskQuad?.quad ?? (hit ? rectQuad(Math.round(hit.box[0]), Math.round(hit.box[1]), Math.round(hit.box[2]), Math.round(hit.box[3])) : centeredBoxQuad(w, h));
    const id = useEdits.getState().addTrack(mediaId, { frame, quad: q, label, frames: media?.proxy?.frames ?? null, ...(Object.keys(fields).length ? { fields } : {}), options: { motionModel } });
    useTimeline.getState().selectTrack(id);
    useTimeline.getState().setTool("corner");
    useUi.getState().setTab("track");
    toast.info(quad ? t("已建立追蹤；按 K 在其他幀補關鍵幀，再按「追到尾」") : t("已建立追蹤：拖四角對準表面，再按 K 釘住"));
    if (fromMask) toast.info(t("從遮罩取角：先用加選（A）點幾下，再按 C"));
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("新增追蹤")}
      icon={PlusCircle}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={create}>
            {t("建立")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="text-[12px] text-fg/55">{t("第一個關鍵幀（也是參考影格）在第 {frame} 幀。", { frame })}</div>
        <Field label={t("名稱")}>
          <Input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
        </Field>
        {!quad && objects.length > 0 && (
          <Field label={t("從物件遮罩取四角（選用）")} hint={t("用一個已經追蹤好的物件（例如找到的螢幕）在這一幀的遮罩，擬合出四個角。")}>
            <div className="flex gap-1.5">
              <Select value={objId || objects[0].id} onChange={(e) => {
                  setObjId(e.target.value);
                  setMaskQuad(null);
                }} aria-label={t("物件")} data-testid="newtrack-object">
                {objects.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Button variant="ghost" icon={Shapes} onClick={() => void fromObject()} loading={maskBusy} disabled={maskBusy || !engineReady()} data-testid="newtrack-from-mask">
                {t("取四角")}
              </Button>
            </div>
            {maskQuad && <div className="mt-1.5 text-[12px] text-success">{t("已取得四角（信心 {pct}%）：建立時用它", { pct: Math.round(maskQuad.conf * 100) })}</div>}
            {maskNote && <div className="mt-1.5 text-[12px] text-warning">{maskNote}</div>}
          </Field>
        )}
        {!quad && (
          <Field label={t("用文字找（選用）")} hint={t("打你要追蹤的東西，例如「screen, poster」。找到的是候選框，看過分數再選一個；沒選就用畫面中央的預設框。")}>
            <div className="flex gap-1.5">
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("screen")}
                disabled={!proxyPath}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void find();
                }}
              />
              <Button variant="ghost" onClick={() => void find()} disabled={!proxyPath || !text.trim() || finding || !engineReady()}>
                {finding ? t("找…") : t("找")}
              </Button>
            </div>
            {found && found.length === 0 && <div className="mt-1.5 text-[12px] text-fg/55">{t("這一幀沒找到符合的東西；換個講法或換一幀試試。")}</div>}
            {found && found.length > 0 && (
              <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-auto" data-testid="found-boxes">
                {found.map((b, i) => (
                  <li key={`${b.phrase}-${i}`}>
                    <button
                      type="button"
                      onClick={() => setPicked(i)}
                      className={`w-full rounded px-2 py-1 text-left text-[12px] ${picked === i ? "bg-accent text-on-accent" : "hover:bg-fg/10"}`}
                    >
                      <span className="mono">{`${Math.round(b.score * 100)}%`}</span>
                      {` ${b.phrase} · ${Math.round(b.box[2])}×${Math.round(b.box[3])}`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}
        {plugins().map((p) => {
          const Fields = p.tracks?.NewTrackFields;
          return Fields ? <Fields key={p.id} mediaId={mediaId} value={fields} onChange={setFields} /> : null;
        })}
        <Field label={t("動態模型")} hint={t("預設透視（平面會傾斜、轉動）；只會平移的招牌可以選平移，更穩。")}>
          <Select value={motionModel} onChange={(e) => setMotionModel(e.target.value as MotionModel)}>
            {MOTION_MODELS.map((m) => (
              <option key={m} value={m}>
                {t(MOTION_MODEL_LABEL[m])}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
