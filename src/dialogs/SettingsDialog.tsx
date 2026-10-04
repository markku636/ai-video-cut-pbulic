import { useEffect, useRef, useState } from "react";
import { Cog, Cpu, Database, Download, Sliders, Trash2 } from "lucide-react";
import { api, errMessage, type AppSettings, type CacheStatus } from "../api";
import { LANGUAGES, useLang, useT, type Lang } from "../i18n";
import { collect } from "../plugins/registry";
import { openDialog, type SettingsFocus } from "../store/dialogs";
import AgentBackendSection from "./AgentBackendSection";
import Section from "./SettingsSection";
import { useEngine } from "../store/engine";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useUi, type Density } from "../store/ui";
import { pickDirectory, pickOpenFile, toast } from "../ui";
import { Button, Field, Input, Modal, Segmented, Select } from "../ui/index";
// App 自動更新的設定段（狀態、自動檢查、立即檢查、更新來源覆寫）
import UpdateSettingsSection from "../updater/UpdateSettingsSection";

/** keychain 的帳號名（與 Rust 的白名單一致）。 */
const ANTHROPIC_KEY = "llm_anthropic_api_key";
const TTS_KEY = "tts_api_key";

/**
 * 設定對話框（計畫 §9 `settings{focus}`）。三個分頁，一次只面對一件事：
 * - **常用**：ffmpeg、語言、輸出資料夾、介面密度（外掛的區段依它宣告的位置插進來，例如 cards 的牌組風格）。
 * - **引擎**：資料根（venv 6 GB 要能搬到 D:）、Python 覆寫、SAM 變體、自動重解、安裝 / 檢查。
 * - **快取**：`<app_cache_dir>/media/<fp16>/` 每個媒體有什麼、逐個清除（Mocha Cache Management）。
 *
 * `focus` 進場（ffmpeg 缺失的 banner、狀態列）要直接落在對的分頁與欄位上。
 */
type Tab = "general" | "engine" | "cache";

const TAB_FOR_FOCUS: Record<NonNullable<SettingsFocus>, Tab> = { ffmpeg: "general", output: "general", engine: "engine", cache: "cache" };

/**
 * 核心區段的 id（外掛的區段用 `before` 指定插在哪一段之前；沒給或指到不存在的 = 那個分頁的最後）。
 * 常用：tools / output / appearance / experimental。
 */
type CoreSectionId = "tools" | "output" | "appearance" | "experimental";
const CORE_SECTION_IDS: readonly CoreSectionId[] = ["tools", "output", "appearance", "experimental"];

export default function SettingsDialog({ focus = null, onClose }: { focus?: SettingsFocus; onClose: () => void }) {
  const t = useT();
  const ffmpegInputRef = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState<SettingsFocus>(null);
  /** 金鑰只問「有沒有」，永遠不讀回明文（見 api.secretSet 的說明）。 */
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [hasTtsKey, setHasTtsKey] = useState<boolean | null>(null);
  const [ttsKeyDraft, setTtsKeyDraft] = useState("");
  const [tab, setTab] = useState<Tab>(focus ? TAB_FOR_FOCUS[focus] : "general");

  useEffect(() => {
    if (!focus) return;
    const id = window.setTimeout(() => {
      if (focus === "ffmpeg") {
        ffmpegInputRef.current?.scrollIntoView({ block: "center" });
        ffmpegInputRef.current?.focus();
      }
      setHighlight(focus);
    }, 200);
    const off = window.setTimeout(() => setHighlight(null), 1900);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(off);
    };
  }, [focus]);

  const s = useSettings((x) => x.s);
  const save = useSettings((x) => x.save);
  const ffmpeg = useSettings((x) => x.ffmpeg);
  const paths = useSettings((x) => x.paths);
  const probeAll = useSettings((x) => x.probeAll);
  const experimental = useSettings((x) => x.experimental);
  const setExperimental = useSettings((x) => x.setExperimental);
  const density = useUi((x) => x.density);
  const setDensity = useUi((x) => x.setDensity);
  const lang = useLang((x) => x.lang);
  const pyenv = useEngine((x) => x.pyenv);
  const probing = useEngine((x) => x.probing);

  const [draft, setDraft] = useState<AppSettings>(s);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setDraft(s), [s]);

  const patch = (p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p }));
  const commit = async (p: Partial<AppSettings>) => {
    patch(p);
    await save(p);
  };
  const commitEngine = (p: Partial<AppSettings["engine"]>) => commit({ engine: { ...draft.engine, ...p } });

  /** 外掛的設定區段：before 指到這一段的插在這裡；沒給 / 指到不存在的核心區段的，放在分頁最後（before 傳 undefined 那一次）。 */
  const pluginSections = (forTab: "general" | "engine" | "cache", before?: CoreSectionId) =>
    collect((p) => p.settingsSections)
      .filter((x) => x.tab === forTab && (before ? x.before === before : !x.before || !CORE_SECTION_IDS.includes(x.before as CoreSectionId) || forTab !== "general"))
      .map((x) => <x.component key={x.id} draft={draft} commit={commit} />);

  /**
   * 「測試連線」：只問端點有哪些模型，**不產生任何 token**。
   * 按一下測試不該讓本機模型跑一次推論（27B 那種等半天還佔顯存）。
   */
  const testLlm = async () => {
    const endpoint = draft.llm_openai_base_url.trim();
    if (!endpoint) return void toast.error(t("先填入端點位址"));
    setBusy("llm");
    try {
      await save({ llm_openai_base_url: endpoint, llm_openai_model: draft.llm_openai_model.trim() });
      const r = await api.engineCall<{ models: string[] }>("assistant.models", { endpoint }, 30_000);
      if (!r.models.length) toast.info(t("連得上，但一個模型都沒載入"));
      else toast.success(t("連得上：{models}", { models: r.models.slice(0, 4).join("、") }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const detectFfmpeg = async () => {
    setBusy("ffmpeg");
    try {
      await save({ ffmpeg_path: draft.ffmpeg_path?.trim() || null });
      const r = await api.ffmpegDetect(draft.ffmpeg_path?.trim() || null);
      await probeAll();
      if (r.found) toast.success(`ffmpeg ${r.version}（${r.source}）`);
      else toast.error(t("找不到 ffmpeg"));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void api.secretHas(ANTHROPIC_KEY).then(setHasKey).catch(() => setHasKey(false));
    void api.secretHas(TTS_KEY).then(setHasTtsKey).catch(() => setHasTtsKey(false));
  }, []);

  const saveKey = async () => {
    const v = keyDraft.trim();
    try {
      await api.secretSet(ANTHROPIC_KEY, v);
      setKeyDraft("");
      setHasKey(!!v);
      toast.success(v ? t("金鑰已存進系統 keychain") : t("已刪除金鑰"));
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  const saveTtsKey = async () => {
    const v = ttsKeyDraft.trim();
    try {
      await api.secretSet(TTS_KEY, v);
      setTtsKeyDraft("");
      setHasTtsKey(!!v);
      toast.success(v ? t("金鑰已存進系統 keychain") : t("已刪除金鑰"));
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  /** 「測試連線」：只列聲音，不合成任何東西。 */
  const testTts = async () => {
    const endpoint = draft.tts_base_url.trim();
    if (!endpoint) return void toast.error(t("先填入伺服器位址"));
    setBusy("tts");
    try {
      await save({ tts_base_url: endpoint });
      const r = await api.engineCall<{ speakers: { name: string }[] }>("tts.speakers", { endpoint }, 30_000);
      if (!r.speakers.length) toast.info(t("連得上，但沒有可用的聲音"));
      else toast.success(t("連得上：{n} 個聲音（{names}…）", { n: r.speakers.length, names: r.speakers.slice(0, 3).map((x) => x.name).join("、") }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const ring = (k: SettingsFocus) => (highlight === k ? "ring-2 ring-accent rounded-md" : "");

  return (
    <Modal open onClose={onClose} title={t("設定")} icon={Cog} size="lg" footer={<Button variant="primary" onClick={onClose}>{t("關閉")}</Button>}>
      <div className="space-y-4">
        <Segmented
          full
          ariaLabel={t("設定分頁")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "general", label: t("常用"), icon: Sliders },
            { value: "engine", label: t("引擎"), icon: Cpu },
            { value: "cache", label: t("快取"), icon: Database },
          ]}
        />

        {tab === "general" && (
          <div className="space-y-4">
            {pluginSections("general", "tools")}
            <Section title={t("工具")}>
              <Field label="ffmpeg" hint={ffmpeg?.found ? `${ffmpeg.version} · ${ffmpeg.source} · ${ffmpeg.ffmpeg_path}` : t("找不到 ffmpeg；請安裝或指定 ffmpeg.exe / 其所在資料夾")}>
                <div className="flex gap-2">
                  <Input
                    ref={ffmpegInputRef}
                    value={draft.ffmpeg_path ?? ""}
                    onChange={(e) => patch({ ffmpeg_path: e.target.value })}
                    placeholder={t("留空＝自動偵測（內建 / PATH / 常見安裝路徑）")}
                    className={`flex-1 transition-shadow ${highlight === "ffmpeg" ? "ring-2 ring-accent" : ""}`}
                    spellCheck={false}
                  />
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      const p = await pickOpenFile([{ name: "ffmpeg", extensions: ["exe", "*"] }]);
                      if (p) patch({ ffmpeg_path: p });
                    }}
                  >
                    …
                  </Button>
                  <Button onClick={() => void detectFfmpeg()} loading={busy === "ffmpeg"}>
                    {t("偵測")}
                  </Button>
                </div>
              </Field>
              {ffmpeg?.found && (
                <div className="text-[11px] text-fg/45">
                  {t("可用的編碼器：{list}", { list: ffmpeg.usable.length ? ffmpeg.usable.join(", ") : t("（沒有一個試編過關）") })}
                </div>
              )}
            </Section>

            {pluginSections("general", "output")}
            <Section title={t("輸出")}>
              <div className={ring("output")}>
                <Field label={t("輸出資料夾")} hint={t("留空＝與來源同資料夾")}>
                  <div className="flex gap-2">
                    <Input value={draft.output_dir ?? ""} readOnly className="flex-1" />
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        const d = await pickDirectory();
                        if (d) void commit({ output_dir: d });
                      }}
                    >
                      {t("選擇資料夾")}
                    </Button>
                    {draft.output_dir && (
                      <Button variant="ghost" onClick={() => void commit({ output_dir: null })}>
                        {t("清除")}
                      </Button>
                    )}
                  </div>
                </Field>
              </div>
              <Field label={t("預設畫質")} hint={t("真正的編碼計畫由引擎依來源容器決定；這裡只是輸入。")}>
                <Select value={draft.export_defaults.quality} onChange={(e) => void commit({ export_defaults: { ...draft.export_defaults, quality: e.target.value } })}>
                  <option value="draft">{t("草稿（快）")}</option>
                  <option value="standard">{t("標準")}</option>
                  <option value="high">{t("高（預設）")}</option>
                </Select>
              </Field>
            </Section>

            {pluginSections("general", "appearance")}
            <Section title={t("外觀")}>
              <Field label={t("語言")}>
                <Select value={lang} onChange={(e) => void useLang.getState().setLang(e.target.value as Lang)}>
                  {LANGUAGES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("介面密度")} hint={t("大螢幕用「寬鬆」讀起來比較不吃力；筆電用「緊湊」可以多看到幾列")}>
                <Select value={density} onChange={(e) => setDensity(e.target.value as Density)}>
                  <option value="compact">{t("緊湊")}</option>
                  <option value="normal">{t("標準")}</option>
                  <option value="comfortable">{t("寬鬆")}</option>
                </Select>
              </Field>
            </Section>

            <UpdateSettingsSection />

            {/* 序列剪輯在 M2.17 之前藏在這個旗標後面：中途出貨的半成品只有自己打開的人看得到（設計 §13） */}
            {pluginSections("general", "experimental")}
            <Section title={t("實驗功能")}>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={experimental.sequence} onChange={(e) => setExperimental({ sequence: e.target.checked })} />
                <span>
                  {t("序列剪輯（預覽）")}
                  <span className="block text-[11px] text-fg/45">{t("在時間軸上分割、刪除、修剪片段並加入音訊；還在開發中，只存在這台電腦。")}</span>
                </span>
              </label>
            </Section>
            {pluginSections("general")}
          </div>
        )}

        {tab === "engine" && (
          <div className={`space-y-4 ${ring("engine")}`}>
            <Section title={t("狀態")}>
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className={pyenv?.state === "ready" ? "text-success" : pyenv?.state === "installing" ? "text-info" : "text-warning"}>
                  {pyenv ? t("引擎環境：{state}", { state: pyenv.state }) : t("檢查中…")}
                </span>
                <span className="text-fg/45 truncate">{pyenv?.message}</span>
                <Button size="sm" variant="ghost" className="ml-auto" loading={probing} onClick={() => void useEngine.getState().probePyEnv()}>
                  {t("重新檢查")}
                </Button>
                <Button size="sm" variant="primary" icon={Download} onClick={() => openDialog("engineSetup", {})}>
                  {t("安裝 / 檢查引擎…")}
                </Button>
              </div>
              {pyenv?.python && <div className="text-[11px] text-fg/45 mono truncate">{pyenv.python}</div>}
            </Section>

            <Section title={t("位置")}>
              <Field label={t("引擎資料根（pyenv / models / logs）")} hint={paths ? t("目前：{p}（venv 約 6 GB；C: 不夠就搬到 D:）", { p: paths.data_root }) : t("留空＝App 本機資料目錄")}>
                <div className="flex gap-2">
                  <Input value={draft.engine.data_root ?? ""} readOnly className="flex-1" />
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      const d = await pickDirectory();
                      if (d) void commitEngine({ data_root: d });
                    }}
                  >
                    {t("選擇資料夾")}
                  </Button>
                  {draft.engine.data_root && (
                    <Button variant="ghost" onClick={() => void commitEngine({ data_root: null })}>
                      {t("清除")}
                    </Button>
                  )}
                </div>
              </Field>
              <Field label={t("Python 覆寫（進階）")} hint={t("等同 AIVC_PYTHON：指定另一個 venv 的 python.exe。絕不會退回 PATH 上的 Python。")}>
                <div className="flex gap-2">
                  <Input value={draft.python_override ?? ""} onChange={(e) => patch({ python_override: e.target.value })} onBlur={() => void commit({ python_override: draft.python_override?.trim() || null })} placeholder={t("留空＝受管 venv")} className="flex-1" spellCheck={false} />
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      const p = await pickOpenFile([{ name: "python", extensions: ["exe"] }]);
                      if (p) void commit({ python_override: p });
                    }}
                  >
                    …
                  </Button>
                </div>
              </Field>
            </Section>

            <Section title={t("追蹤與分割")}>
              <Field label={t("SAM 2.1 變體")} hint={t("small 夠用且快；large 更準但顯存要 6 GB 以上。")}>
                <Select value={draft.engine.sam_variant} onChange={(e) => void commitEngine({ sam_variant: e.target.value })}>
                  <option value="small">small</option>
                  <option value="large">large</option>
                </Select>
              </Field>
              <label className="flex items-center gap-2 h-7 text-sm">
                <input type="checkbox" checked={draft.engine.auto_resolve} onChange={(e) => void commitEngine({ auto_resolve: e.target.checked })} />
                {t("拖角 / 加提示後自動重解相鄰區間")}
              </label>
              <label className="flex items-center gap-2 h-7 text-sm">
                <input type="checkbox" checked={draft.engine.allow_sam3} onChange={(e) => void commitEngine({ allow_sam3: e.target.checked })} />
                {t("允許選配 SAM 3（gated 權重，需自行申請下載）")}
              </label>
            </Section>

            <AgentBackendSection draft={draft} patch={patch} commit={commit} />

            <Section title={t("AI 助手")}>
              <div className="text-[12px] leading-relaxed text-fg/55">
                {t("助手把你的一句話變成一份計畫，你按了才會執行。它需要一個本機模型服務（LM Studio、Ollama、llama.cpp…）；對話與計畫都留在本機，影片不會上傳。")}
              </div>
              <Field label={t("端點位址")} hint={t("OpenAI 相容的 /v1 位址。LM Studio 預設就是這個，但要先在它的 Developer 分頁按 Start Server。")}>
                <div className="flex gap-2">
                  <Input
                    value={draft.llm_openai_base_url}
                    onChange={(e) => patch({ llm_openai_base_url: e.target.value })}
                    onBlur={() => void commit({ llm_openai_base_url: draft.llm_openai_base_url.trim() })}
                    className="mono flex-1"
                    spellCheck={false}
                    placeholder="http://localhost:1234/v1"
                    data-testid="settings-llm-endpoint"
                  />
                  <Button variant="ghost" loading={busy === "llm"} onClick={() => void testLlm()} data-testid="settings-llm-test">
                    {t("測試連線")}
                  </Button>
                </div>
              </Field>
              <Field
                label={t("Anthropic 金鑰（選用）")}
                hint={hasKey ? t("已經存了一把（存在系統 keychain，不在設定檔裡）。要換就貼新的；清空後按儲存＝刪掉。") : t("想用 Claude 而不是本機模型才需要。存在系統 keychain，不會寫進設定檔，也不會回到畫面上。")}
              >
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    className="mono flex-1"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={hasKey ? t("（已設定）") : "sk-ant-…"}
                    data-testid="settings-llm-key"
                  />
                  <Button variant="ghost" disabled={!keyDraft.trim() && !hasKey} onClick={() => void saveKey()} data-testid="settings-llm-key-save">
                    {t("儲存")}
                  </Button>
                </div>
              </Field>
              <Field
                label={t("Claude 模型")}
                hint={t("填了就改用 Claude（需要上面的金鑰）；留空＝用本機端點。Anthropic 沒有「列出模型」可以自動挑，所以這個欄位同時就是開關。")}
              >
                <Input
                  value={draft.llm_anthropic_model}
                  onChange={(e) => patch({ llm_anthropic_model: e.target.value })}
                  onBlur={() => void commit({ llm_anthropic_model: draft.llm_anthropic_model.trim() })}
                  className="mono"
                  spellCheck={false}
                  placeholder={t("留空＝用本機端點")}
                  data-testid="settings-llm-claude-model"
                />
              </Field>
              <Field label={t("模型")} hint={t("留空＝用端點列出來的第一個。")}>
                <Input
                  value={draft.llm_openai_model}
                  onChange={(e) => patch({ llm_openai_model: e.target.value })}
                  onBlur={() => void commit({ llm_openai_model: draft.llm_openai_model.trim() })}
                  className="mono"
                  spellCheck={false}
                  placeholder={t("（自動）")}
                  data-testid="settings-llm-model"
                />
              </Field>
            </Section>

            <Section title={t("AI 配音（Seal-TTS）")}>
              <div className="text-[12px] leading-relaxed text-fg/55">{t("把一段字交給自架的 Seal-TTS 伺服器唸成旁白，放到音軌上（AI 選單 →「AI 配音」）。留空＝功能關著。")}</div>
              <Field label={t("伺服器位址")} hint={t("例如 http://localhost:7866（不含 /v1）。")}>
                <div className="flex gap-2">
                  <Input
                    value={draft.tts_base_url}
                    onChange={(e) => patch({ tts_base_url: e.target.value })}
                    onBlur={() => void commit({ tts_base_url: draft.tts_base_url.trim() })}
                    className="mono flex-1"
                    spellCheck={false}
                    placeholder="http://localhost:7866"
                    data-testid="settings-tts-endpoint"
                  />
                  <Button variant="ghost" loading={busy === "tts"} onClick={() => void testTts()} data-testid="settings-tts-test">
                    {t("測試連線")}
                  </Button>
                </div>
              </Field>
              <Field
                label={t("API 金鑰")}
                hint={hasTtsKey ? t("已經存了一把（存在系統 keychain，不在設定檔裡）。要換就貼新的；清空後按儲存＝刪掉。") : t("伺服器發的金鑰。存在系統 keychain，不會寫進設定檔，也不會回到畫面上。")}
              >
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={ttsKeyDraft}
                    onChange={(e) => setTtsKeyDraft(e.target.value)}
                    className="mono flex-1"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={hasTtsKey ? t("（已設定）") : ""}
                    data-testid="settings-tts-key"
                  />
                  <Button variant="ghost" disabled={!ttsKeyDraft.trim() && !hasTtsKey} onClick={() => void saveTtsKey()} data-testid="settings-tts-key-save">
                    {t("儲存")}
                  </Button>
                </div>
              </Field>
            </Section>
            {pluginSections("engine")}
          </div>
        )}

        {tab === "cache" && (
          <div className={ring("cache")}>
            <CacheTab />
            {pluginSections("cache")}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 快取管理：每個媒體的 `<cache>/media/<fp16>/` 有什麼、逐個清。 */
function CacheTab() {
  const t = useT();
  const media = useProject((s) => s.media);
  const paths = useSettings((s) => s.paths);
  const [status, setStatus] = useState<Record<string, CacheStatus | null>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const out: Record<string, CacheStatus | null> = {};
    for (const m of media) out[m.id] = await api.mediaCacheStatus(m.id).catch(() => null);
    setStatus(out);
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.map((m) => m.id).join(",")]);

  const clear = async (id: string | null) => {
    setBusy(id ?? "*");
    try {
      await api.mediaCacheClear(id);
      if (id) useProject.getState().updateMedia(id, { proxy: null, proxyState: "none" });
      else for (const m of media) useProject.getState().updateMedia(m.id, { proxy: null, proxyState: "none" });
      toast.success(t("已清除快取"));
      await refresh();
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title={t("媒體快取")}>
      <div className="text-[11px] text-fg/45">{t("proxy、索引、縮圖、遮罩與解算都在這裡，可隨時清；清掉之後開檔會重建（追蹤結果要重解）。")}</div>
      {paths && <div className="text-[11px] text-fg/45 mono truncate">{paths.cache_dir}</div>}
      {media.length === 0 ? (
        <div className="text-xs text-fg/35">{t("專案裡還沒有媒體")}</div>
      ) : (
        <div className="divide-y divide-fg/5 rounded border border-fg/10">
          {media.map((m) => {
            const st = status[m.id];
            return (
              <div key={m.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                <span className="truncate flex-1 text-fg/80" title={st?.dir ?? m.path}>
                  {m.name}
                </span>
                <span className="text-fg/40 mono shrink-0">
                  {st ? `${st.proxy ? "proxy " : ""}${st.index ? "index " : ""}${st.thumbs ? "thumbs" : ""}`.trim() || t("（空）") : "—"}
                </span>
                <Button size="sm" variant="ghost" icon={Trash2} loading={busy === m.id} onClick={() => void clear(m.id)}>
                  {t("清除")}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="danger" icon={Trash2} loading={busy === "*"} onClick={() => void clear(null)}>
          {t("清除全部媒體快取")}
        </Button>
      </div>
    </Section>
  );
}
