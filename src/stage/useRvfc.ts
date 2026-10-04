import { useEffect, useRef } from "react";
import type { Rational } from "../api";
import { usePlayback } from "../store/playback";
import { frameOfMediaTime } from "../video/frames";

/**
 * 幀時鐘：`requestVideoFrameCallback` 每呈現一幀叫一次，`metadata.mediaTime` 是**那一幀**的呈現時間戳，
 * 換成幀號回寫 playback.frame，再叫 onFrame 讓疊層重畫。
 *
 * 為什麼不用 timeupdate：只有 4 Hz，播放線一秒跳四下；也不用 rAF 讀 currentTime：
 * 那是「時鐘現在幾點」不是「畫面上是哪一幀」，會比實際呈現超前半幀到一幀，畫出來的表面就漂。
 * 暫停時 rVFC 不會叫（沒有新幀），一顆 CPU 都不燒；seek 完呈現的那一幀也會叫，所以 seek 不需要另一條路。
 */
export type FrameCallback = (frame: number, meta: VideoFrameCallbackMetadata | null) => void;

export function useRvfc(video: HTMLVideoElement | null, fps: Rational | null, onFrame?: FrameCallback): void {
  const cbRef = useRef<FrameCallback | undefined>(onFrame);
  cbRef.current = onFrame;
  const num = fps?.num ?? 0;
  const den = fps?.den ?? 0;

  useEffect(() => {
    if (!video || !num || !den) return;
    const rate: Rational = { num, den };
    const setFrame = usePlayback.getState().setFrame;

    if (typeof video.requestVideoFrameCallback !== "function") {
      // 保底而非設計：沒有 rVFC 的 WebView 退回 timeupdate + seeked，播放線會粗一點，但不會停
      const h = () => {
        const f = frameOfMediaTime(video.currentTime, rate);
        setFrame(f);
        cbRef.current?.(f, null);
      };
      video.addEventListener("timeupdate", h);
      video.addEventListener("seeked", h);
      return () => {
        video.removeEventListener("timeupdate", h);
        video.removeEventListener("seeked", h);
      };
    }

    let alive = true;
    let id = 0;
    const tick = (_now: number, md: VideoFrameCallbackMetadata) => {
      if (!alive) return;
      const f = frameOfMediaTime(md.mediaTime, rate);
      setFrame(f);
      cbRef.current?.(f, md);
      id = video.requestVideoFrameCallback(tick);
    };
    id = video.requestVideoFrameCallback(tick);
    return () => {
      alive = false;
      video.cancelVideoFrameCallback(id);
    };
  }, [video, num, den]);
}
