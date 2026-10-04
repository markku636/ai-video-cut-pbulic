import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, ChevronDown, ChevronRight, Copy, FileText, FolderOpen, Hammer, Info, RefreshCw, Search } from "lucide-react";
import { api, decodeJson, errMessage, type CacheStatus, type MediaProbe } from "../api";
import { APP_NAME } from "../brand";
import { useT } from "../i18n";
import { ensureProxy } from "../pipeline/proxy";
import type { ShotV1, TrackV1 } from "../project/format";
import { plugins } from "../plugins/registry";
import { engineReady, pyenvReady, useEngine } from "../store/engine";
import { useEdits } from "../store/edits";
import { useProject, type MediaItem } from "../store/project";
import { useSolves } from "../store/solves";
import { copyToClipboard, toast } from "../ui";
import Icon from "../ui/Icon";
import { Badge, Button, IconButton, Input, Modal, Spinner } from "../ui/index";
import { parseEngineProbe, parseProxyInfo, parseShotsInfo, summarizeIndex, type EngineProbe, type IndexSummary, type ProxyInfo, type ShotsInfo } from "../video/mediaCache";
import { deriveMediaInfo, mediaInfoJson, mediaInfoText, sourceLabel, type InfoRow, type InfoSection, type InfoSectionId, type MediaInfoInput, type MediaInfoModel } from "../video/mediaInfo";

const EMPTY_SHOTS: ShotV1[] = [];
const EMPTY_TRACKS: TrackV1[] = [];
const COLLAPSED_KEY = "aivc:mediaInfo:collapsed";

/** 讀進來的東西（開窗 / 重新讀取時重抓；不進 store：這是看的，不是編輯狀態）。 */
interface Loaded {
  probe: MediaProbe | null;
  probeFrom: "live" | "stored" | null;
  probeError: string | null;
  engineProbe: EngineProbe | null;
  index: IndexSummary | null;
  proxy: ProxyInfo | null;
  shots: ShotsInfo | null;
  cache: CacheStatus | null;
}

/** 快取裡的一個 JSON 檔：不存在 / 寫到一半 / 非 Tauri 環境一律當沒有（畫面會講「引擎分析尚未執行」）。 */
async function readCacheJson(fingerprint: string, rel: string): Promise<unknown> {
  try {
    return decodeJson(await api.cacheRead(fingerprint, rel));
  } catch {
    return null;
  }
}

const settled = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

/**
 * 重新 ffprobe（專案檔存的是開檔當下的舊版 probe，沒有後來加的專業欄位；檔案被移走時退回存的那份並標紅）
 * + 讀引擎快取四個 JSON。proxy 剛建好（proxyReady 變 true）時自動重讀：索引是那時候才有的。
 */
function useMediaInfoData(media: MediaItem | null, nonce: number): { data: Loaded | null; loading: boolean } {
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const mid = media?.id ?? null;
  const mpath = media?.path ?? null;
  const proxyReady = media?.proxyState === "ready";
  useEffect(() => {
    if (!mid || !mpath) return;
    let alive = true;
    setLoading(true);
    void Promise.allSettled([
      api.mediaProbe(mpath),
      api.mediaCacheStatus(mid),
      readCacheJson(mid, "probe.v1.json"),
      readCacheJson(mid, "index.v1.json"),
      readCacheJson(mid, "proxy.v1.json"),
      readCacheJson(mid, "shots.v1.json"),
    ]).then(([live, cache, ep, idx, px, sh]) => {
      if (!alive) return;
      const stored = useProject.getState().media.find((m) => m.id === mid)?.probe ?? null;
      const liveProbe = settled(live);
      setData({
        probe: liveProbe ?? stored,
        probeFrom: liveProbe ? "live" : stored ? "stored" : null,
        probeError: live.status === "rejected" ? errMessage(live.reason) : null,
        engineProbe: parseEngineProbe(settled(ep)),
        index: summarizeIndex(settled(idx)),
        proxy: parseProxyInfo(settled(px)),
        shots: parseShotsInfo(settled(sh)),
        cache: settled(cache),
      });
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [mid, mpath, nonce, proxyReady]);
  return { data, loading };
}

/** 讀檔結果 + 專案狀態（鏡頭 / 追蹤 / 已載入的解 / 外掛的列，例如 cards 的格位與牌組）→ 純函式層的輸入。 */
function useMediaInfoInput(media: MediaItem | null, data: Loaded | null, loading: boolean): MediaInfoInput | null {
  const shots = useEdits((s) => (media ? s.shots[media.id] : undefined)) ?? EMPTY_SHOTS;
  const tracks = useEdits((s) => (media ? s.tracks[media.id] : undefined)) ?? EMPTY_TRACKS;
  const pluginMedia = useEdits((s) => (media ? s.pluginMedia[media.id] : undefined));
  const pluginProject = useEdits((s) => s.pluginProject);
  const solves = useSolves((s) => s.byTrack);
  const base = useMemo(() => {
    if (!media) return null;
    const trackIds = new Set(tracks.map((x) => x.id));
    return {
      media: { id: media.id, name: media.name, path: media.path, fingerprint: media.fingerprint },
      probe: data?.probe ?? media.probe,
      probeFrom: data?.probeFrom ?? (media.probe ? "stored" : null),
      probeError: data?.probeError ?? null,
      engineProbe: data?.engineProbe ?? null,
      index: data?.index ?? null,
      proxy: data?.proxy ?? null,
      shots: data?.shots ?? null,
      cache: data?.cache ?? null,
      loading,
      project: {
        shots,
        tracks,
        loadedSolves: Object.keys(solves).filter((id) => trackIds.has(id)).length,
      },
    } satisfies MediaInfoInput;
  }, [media, data, loading, shots, tracks, solves]);
  useT(); // 外掛的列是組裝當下翻好的：訂閱語言，切語言時重組
  if (!base || !media) return null;
  // 外掛的列（例如 cards 的牌格位 / 牌組）每次 render 重組（跟 deriveMediaInfo 一樣，切語言才會跟著換）
  const ctx = { mediaId: media.id, media: pluginMedia, project: pluginProject };
  const extraRows = plugins().flatMap((p) => p.mediaInfo?.rows?.(ctx) ?? []);
  const extraReport = Object.assign({}, ...plugins().map((p) => p.mediaInfo?.report?.(ctx) ?? {})) as Record<string, unknown>;
  return { ...base, project: { ...base.project, extraRows, extraReport } };
}

function readCollapsed(): Set<InfoSectionId> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? (raw.filter((x) => typeof x === "string") as InfoSectionId[]) : []);
  } catch {
    return new Set();
  }
}

/** 摺起來的區塊記在 localStorage（純個人偏好；讀寫失敗就只是不記）。 */
function useCollapsedSections(): [Set<InfoSectionId>, (id: InfoSectionId) => void] {
  const [collapsed, setCollapsed] = useState<Set<InfoSectionId>>(readCollapsed);
  const toggle = (id: InfoSectionId) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* 私密視窗 / 被擋 */
      }
      return next;
    });
  return [collapsed, toggle];
}

function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}

function filterSections(model: MediaInfoModel | null, q: string): InfoSection[] {
  if (!model) return [];
  if (!q) return model.sections;
  return model.sections
    .map((s) => ({ ...s, rows: s.rows.filter((r) => `${s.title} ${r.label} ${r.value ?? ""} ${r.note ?? ""} ${r.key}`.toLowerCase().includes(q)) }))
    .filter((s) => s.rows.length > 0);
}

/**
 * 媒體資訊（計畫 M1 §3；參考 MediaInfo 的區塊、FCP Info inspector 的版面、Premiere Properties 的欄位）。
 *
 * 資料三層：Rust ffprobe（開窗重讀）→ 引擎快取（probe / index / proxy / shots.v1.json，整支解碼的真實時間戳）→ 專案狀態。
 * 數字與文字全在 video/mediaInfo.ts（純函式、有測試）；這裡只讀檔與畫。
 * 沒有值的欄位一律顯示「—」並在 tooltip 講為什麼（檔案沒有 / 容器不支援 / 還沒跑引擎），不留白、不猜。
 */
export default function MediaInfoDialog({ mediaId, onClose }: { mediaId: string | null; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === (mediaId ?? s.activeMediaId)) ?? null);
  const [nonce, setNonce] = useState(0);
  const [query, setQuery] = useState("");
  const [collapsed, toggleSection] = useCollapsedSections();
  const sectionRefs = useRef<Partial<Record<InfoSectionId, HTMLElement | null>>>({});
  const { data, loading } = useMediaInfoData(media, nonce);
  const input = useMediaInfoInput(media, data, loading);
  // 每次 render 重組（幾十列字串，微秒級）：模型裡的字串是組裝當下翻好的，memo 住的話切語言不會跟著換
  const model = input ? deriveMediaInfo(input) : null;
  const q = query.trim().toLowerCase();
  const sections = filterSections(model, q);

  // 那支媒體被移出專案 → 關掉（needs: "none"，DialogHost 不會替我們關）
  useEffect(() => {
    if (!media) onClose();
  }, [media, onClose]);

  if (!media || !input || !model) return null;

  const app = { name: APP_NAME, version: __APP_VERSION__ };
  const jump = (id: InfoSectionId) => {
    if (collapsed.has(id)) toggleSection(id);
    sectionRefs.current[id]?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const reveal = () => void api.openPath(parentDir(media.path)).catch((e) => toast.error(errMessage(e)));

  return (
    <Modal
      open
      onClose={onClose}
      title={t("媒體資訊")}
      icon={Info}
      size="xl"
      bodyClassName="flex flex-col min-h-0"
      className="h-[86vh]"
      footer={
        <Footer
          media={media}
          loading={loading}
          hasIndex={!!input.index}
          onReload={() => setNonce((n) => n + 1)}
          onCopyText={() => void copyToClipboard(mediaInfoText(model, app), t("已複製媒體資訊（文字）"))}
          onCopyJson={() => void copyToClipboard(JSON.stringify(mediaInfoJson(input, model, app), null, 2), t("已複製媒體資訊（JSON）"))}
          onClose={onClose}
        />
      }
    >
      <Header model={model} path={media.path} loading={loading} query={query} onQuery={setQuery} onJump={jump} />
      <div className="flex-1 min-h-0 overflow-auto px-5 pb-4" data-testid="media-info-body">
        {sections.length === 0 && <div className="py-10 text-center text-sm text-fg/40">{t("沒有符合「{q}」的欄位", { q: query.trim() })}</div>}
        {sections.map((s) => (
          <SectionView
            key={s.id}
            section={s}
            collapsed={!q && collapsed.has(s.id)}
            onToggle={() => toggleSection(s.id)}
            onReveal={reveal}
            sectionRef={(el) => {
              sectionRefs.current[s.id] = el;
            }}
          />
        ))}
      </div>
    </Modal>
  );
}

/** 表頭：檔名 + 規格晶片 + 警示徽章 + 區塊跳轉 + 篩選。 */
function Header({ model, path, loading, query, onQuery, onJump }: { model: MediaInfoModel; path: string; loading: boolean; query: string; onQuery: (q: string) => void; onJump: (id: InfoSectionId) => void }) {
  const t = useT();
  return (
    <div className="shrink-0 px-5 pt-4 pb-3 border-b border-fg/10 space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <div className="text-base font-medium text-fg/90 truncate" title={path} data-testid="media-info-title">
          {model.title}
        </div>
        {loading && <Spinner size={14} className="text-fg/40 shrink-0" />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {model.chips.map((c) => (
          <span key={c} className="h-[22px] px-2 rounded-xs bg-fg/[0.06] border border-fg/10 text-[12px] mono text-fg/75 inline-flex items-center">
            {c}
          </span>
        ))}
        {model.badges.map((b) => (
          <span key={b.key} title={b.title}>
            <Badge tone={b.tone} dot={b.tone === "danger" || b.tone === "warning"}>
              {b.label}
            </Badge>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <nav className="flex flex-wrap gap-0.5 min-w-0" aria-label={t("區塊")}>
          {model.sections.map((s) => (
            <button key={s.id} type="button" onClick={() => onJump(s.id)} className="h-6 px-2 rounded text-[12px] text-fg/55 hover:text-fg hover:bg-fg/10">
              {s.title}
            </button>
          ))}
        </nav>
        <div className="relative ml-auto w-56 shrink-0">
          <Icon icon={Search} size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg/35 pointer-events-none" />
          <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t("篩選欄位（例如 fps、色彩）")} className="pl-7" aria-label={t("篩選欄位")} />
        </div>
      </div>
    </div>
  );
}

function Footer({ media, loading, hasIndex, onReload, onCopyText, onCopyJson, onClose }: { media: MediaItem; loading: boolean; hasIndex: boolean; onReload: () => void; onCopyText: () => void; onCopyJson: () => void; onClose: () => void }) {
  const t = useT();
  // 訂閱引擎狀態：「建立 proxy」鈕的可用與否跟著變
  useEngine((s) => s.info?.state);
  useEngine((s) => s.pyenv?.state);
  const [building, setBuilding] = useState(false);
  const canBuild = engineReady() || pyenvReady();
  const showBuild = !loading && !hasIndex;
  const build = async () => {
    setBuilding(true);
    try {
      // proxy 在但索引不見（快取被手動清掉一半）→ 強制重建才會重寫索引
      await ensureProxy(media.id, { force: media.proxyState === "ready" });
      onReload();
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBuilding(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={onReload} title={t("重新讀取影片與引擎快取")}>
        {t("重新讀取")}
      </Button>
      {showBuild && (
        <Button
          size="sm"
          variant="ghost"
          icon={Hammer}
          loading={building || media.proxyState === "building"}
          disabled={!canBuild}
          onClick={() => void build()}
          title={canBuild ? t("建 proxy 時引擎會整支解碼一趟，產生索引（VFR、斷層、關鍵幀）") : t("引擎尚未就緒")}
        >
          {t("建立 proxy 與索引")}
        </Button>
      )}
      <span className="mr-auto" />
      <Button size="sm" icon={FileText} onClick={onCopyText} title={t("MediaInfo 風格的純文字，貼到回報單對得齊")}>
        {t("複製文字")}
      </Button>
      <Button size="sm" icon={Braces} onClick={onCopyJson} title={t("原始數值與推算結果（不含逐幀時間戳）")}>
        {t("複製 JSON")}
      </Button>
      <Button size="sm" variant="primary" onClick={onClose}>
        {t("關閉")}
      </Button>
    </>
  );
}

function SectionView({ section, collapsed, onToggle, onReveal, sectionRef }: { section: InfoSection; collapsed: boolean; onToggle: () => void; onReveal: () => void; sectionRef: (el: HTMLElement | null) => void }) {
  return (
    <section ref={sectionRef} data-section={section.id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="sticky top-0 z-[1] w-full flex items-center gap-1.5 pt-3 pb-1.5 bg-elevated text-left text-[11px] font-semibold uppercase tracking-wide text-fg/50 hover:text-fg/80"
      >
        <Icon icon={collapsed ? ChevronRight : ChevronDown} size={13} />
        {section.title}
        <span className="font-normal normal-case tracking-normal text-fg/30">· {section.rows.length}</span>
        {section.rows.some((r) => r.warn) && <span className="w-1.5 h-1.5 rounded-full bg-warning" aria-hidden />}
      </button>
      {!collapsed && (
        <dl className="grid grid-cols-[minmax(150px,210px)_1fr] border-t border-fg/5">
          {section.rows.map((r) => (
            <InfoRowView key={r.key} row={r} onReveal={r.key === "file.path" ? onReveal : undefined} />
          ))}
        </dl>
      )}
    </section>
  );
}

function InfoValue({ row }: { row: InfoRow }) {
  const t = useT();
  if (row.value == null) {
    const why = row.note ?? t("沒有這個值");
    return (
      <span className="text-[13px] text-fg/30 cursor-help underline decoration-dotted decoration-fg/20 underline-offset-4" title={why} aria-label={why}>
        —
      </span>
    );
  }
  return (
    <>
      <div className={`text-[13px] leading-5 break-words select-text ${row.mono ? "mono" : ""} ${row.warn ? "text-warning" : "text-fg/90"}`}>{row.value}</div>
      {row.note && <div className={`text-[11px] leading-4 text-fg/40 break-words ${row.key === "engine.cache" ? "mono" : ""}`}>{row.note}</div>}
    </>
  );
}

function InfoRowView({ row, onReveal }: { row: InfoRow; onReveal?: () => void }) {
  const t = useT();
  const value = row.value;
  return (
    <div className="contents group" data-row={row.key}>
      <dt className="py-1.5 pr-3 border-b border-fg/5 text-[13px] text-fg/55 leading-5 group-hover:bg-fg/[0.03]">{row.label}</dt>
      <dd className="py-1.5 border-b border-fg/5 flex items-start gap-2 min-w-0 group-hover:bg-fg/[0.03]">
        <div className="min-w-0 flex-1">
          <InfoValue row={row} />
        </div>
        {row.source && (
          <span className="shrink-0 mt-0.5 text-[10px] text-fg/25 whitespace-nowrap" title={t("資料來源")}>
            {sourceLabel(row.source)}
          </span>
        )}
        <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {onReveal && <IconButton icon={FolderOpen} label={t("在資料夾中顯示")} iconSize={13} box="w-6 h-6" onClick={onReveal} />}
          <IconButton icon={Copy} label={t("複製此值")} iconSize={13} box="w-6 h-6" disabled={value == null} onClick={() => value != null && void copyToClipboard(value, t("已複製「{label}」", { label: row.label }))} />
        </div>
      </dd>
    </div>
  );
}
