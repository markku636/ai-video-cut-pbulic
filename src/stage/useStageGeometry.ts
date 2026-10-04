import { useEffect, useState, type RefObject } from "react";
import type { ProxyMeta } from "../api";
import type { Pt } from "../video/quad";
import { applyAffine, type Affine } from "./affine";

/**
 * 舞台幾何：容器 → object-fit: contain 的內容矩形 → 三個座標系之間的換算。
 *
 * - **來源像素**（source px）：專案檔裡所有 quad / prompt 的座標系（計畫 §5.6）。
 * - **proxy 像素**：<video> 的本徵尺寸 = 來源 × proxy.scale；drawImage(video, sx, sy…) 的來源矩形用它。
 * - **螢幕**（CSS px，相對舞台容器左上）：pointer 事件與 canvas 繪圖用它；canvas 位圖再乘 DPR。
 *
 * 純函式 `buildGeometry` 抽出來單元測試（vitest 是 node 環境，hook 本身不測）。
 */

export interface ContentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StageGeometry {
  rect: ContentRect;
  containerW: number;
  containerH: number;
  dpr: number;
  /** 來源尺寸（proxy 尺寸 ÷ scale）。 */
  srcW: number;
  srcH: number;
  proxyW: number;
  proxyH: number;
  proxyScale: number;
  /** 一個來源像素在螢幕上幾 px。 */
  pxPerSrc: number;
  /** 疊在螢幕空間上的仿射（穩定視圖）；null = 沒有。drawImage 類的整張繪圖要自己 ctx.transform 它。 */
  affine: Affine | null;
  toScreen: (p: Pt) => Pt;
  toVideo: (p: Pt) => Pt;
  /** 來源 px → proxy px（magnifier / stabilized 從 <video> 取樣用）。 */
  toProxy: (p: Pt) => Pt;
  /** 螢幕 → proxy px。 */
  screenToProxy: (p: Pt) => Pt;
  /** 疊一個螢幕空間仿射（穩定視圖）：所有圖層照常呼叫 toScreen 就會一起被釘住。 */
  withAffine: (m: Affine) => StageGeometry;
}

/** object-fit: contain 的內容矩形；容器或內容尺寸 ≤ 0 時給 0 矩形（呼叫端會跳過繪圖）。 */
export function containRect(cw: number, ch: number, aw: number, ah: number): ContentRect {
  if (cw <= 0 || ch <= 0 || aw <= 0 || ah <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const s = Math.min(cw / aw, ch / ah);
  const w = aw * s;
  const h = ah * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

export function buildGeometry(container: { w: number; h: number }, proxy: { width: number; height: number; scale: number }, dpr: number): StageGeometry {
  const scale = proxy.scale > 0 ? proxy.scale : 1;
  const srcW = proxy.width / scale;
  const srcH = proxy.height / scale;
  const rect = containRect(container.w, container.h, srcW, srcH);
  const pxPerSrc = srcW > 0 ? rect.w / srcW : 0;
  return makeGeometry({ rect, containerW: container.w, containerH: container.h, dpr, srcW, srcH, proxyW: proxy.width, proxyH: proxy.height, proxyScale: scale, pxPerSrc }, null);
}

type GeometryBase = Omit<StageGeometry, "affine" | "toScreen" | "toVideo" | "toProxy" | "screenToProxy" | "withAffine">;

function makeGeometry(base: GeometryBase, affine: Affine | null): StageGeometry {
  const { rect, pxPerSrc, proxyScale } = base;
  const raw = (p: Pt): Pt => [rect.x + p[0] * pxPerSrc, rect.y + p[1] * pxPerSrc];
  const toScreen = affine ? (p: Pt) => applyAffine(affine, raw(p)) : raw;
  // toVideo 刻意**不**反解仿射：穩定視圖裡使用者點的是釘住後的畫面，我們只用它顯示，不編輯
  const toVideo = (p: Pt): Pt => (pxPerSrc > 0 ? [(p[0] - rect.x) / pxPerSrc, (p[1] - rect.y) / pxPerSrc] : [0, 0]);
  const toProxy = (p: Pt): Pt => [p[0] * proxyScale, p[1] * proxyScale];
  return {
    ...base,
    affine,
    toScreen,
    toVideo,
    toProxy,
    screenToProxy: (p) => toProxy(toVideo(p)),
    withAffine: (m) => makeGeometry(base, m),
  };
}

/** 整張圖（video / mask bitmap / 預覽 PNG）要跟著幾何的仿射一起動：包在這裡面畫。 */
export function withGeoTransform(ctx: CanvasRenderingContext2D, geo: StageGeometry, fn: () => void): void {
  if (!geo.affine) {
    fn();
    return;
  }
  ctx.save();
  const [a, b, c, d, e, f] = geo.affine;
  ctx.transform(a, b, c, d, e, f);
  try {
    fn();
  } finally {
    ctx.restore();
  }
}

/** 觀察容器尺寸與 DPR，proxy 一換就重算。容器沒量到尺寸（display:none）前回 null。 */
export function useStageGeometry(ref: RefObject<HTMLElement>, proxy: ProxyMeta | null): StageGeometry | null {
  const [size, setSize] = useState<{ w: number; h: number; dpr: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      setSize((s) => (s && s.w === w && s.h === h && s.dpr === dpr ? s : { w, h, dpr }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // 拖到另一顆螢幕 DPR 會變，但 ResizeObserver 不會叫；window resize 會
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);

  const width = proxy?.width ?? 0;
  const height = proxy?.height ?? 0;
  const scale = proxy?.scale ?? 1;
  const [geo, setGeo] = useState<StageGeometry | null>(null);
  useEffect(() => {
    if (!size || !width || !height || size.w <= 0 || size.h <= 0) {
      setGeo(null);
      return;
    }
    setGeo(buildGeometry({ w: size.w, h: size.h }, { width, height, scale }, size.dpr));
  }, [size, width, height, scale]);
  return geo;
}
