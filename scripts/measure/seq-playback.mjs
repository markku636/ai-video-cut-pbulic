// 序列預覽播放量尺（docs/editor-m2-design.md §13 M2.11 / M2.16）。App 模式：對著跑起來的 App 問。
//
// 回答兩個只有 WebView2 答得出來的問題：
// 1. 接點（M2.11）：播放一條「連續切點 + 同媒體跳接 + 空白 + 停用片段」的序列，
//    畫面有沒有出現過片段 [srcIn, srcOut) 以外的幀（門檻 0）、接點頓挫多久（門檻：每個 ≤ 150 ms）、空白走的時間準不準（誤差 ≤ 50 ms）。
// 2. 漂移（M2.16）：整支範例影片（約 60 s）當一個片段、A1 放一段同長度的 WAV，
//    每呈現一幀比一次「畫面上的序列位置」與「Web Audio 排程推算的位置」，最大 |漂移| < 40 ms、而且一次都沒重排。
//
// 用法（先照 README.md 開 App：AIVC_DEV_OPEN=範例影片、WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222）：
//   node scripts/measure/seq-playback.mjs [--only boundaries|drift] [--port 9222] [--wav <path>]
// 沒給 --wav 時用內建 ffmpeg（AIVC_FFMPEG_DIR 或 PATH）產生 65 s 的 48 kHz 單聲道測試音（440 Hz、每秒一個脈衝）到暫存目錄。
//
// 量完會把實驗旗標、時間軸空間、序列與音訊清單還原成量之前的樣子（WebView 的 localStorage 跟正式 App 共用同一個設定檔）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, sleep, waitReady } from "./cdp.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const only = opt("only", "all");
const port = Number(opt("port", "9222"));

const STALL_MAX_MS = 150;
const BLACK_ERR_MAX_MS = 50;
const DRIFT_MAX_MS = 40;

function pct(xs, p) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function makeTestWav() {
  const given = opt("wav", null);
  if (given) return given;
  const dir = join(tmpdir(), "aivc-measure");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "seq-drift-65s.wav");
  if (existsSync(out)) return out;
  const ffDir = process.env.AIVC_FFMPEG_DIR;
  const ff = ffDir ? join(ffDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg") : "ffmpeg";
  // 440 Hz 底音 + 每個整秒 10 ms 的 1 kHz 脈衝：耳朵聽得出有沒有跟畫面對上，量尺本身只看時鐘
  const r = spawnSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=65", "-f", "lavfi", "-i", "sine=f=1000:r=48000:d=65", "-filter_complex", "[1:a]volume='if(lt(mod(t,1),0.01),1,0)':eval=frame[p];[0:a]volume=0.1[b];[b][p]amix=inputs=2:normalize=0", "-ac", "1", "-c:a", "pcm_s16le", out], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`產生測試音失敗（${ff}）。設 AIVC_FFMPEG_DIR 或用 --wav 指定一個 ≥ 60 s 的 48 kHz WAV`);
  return out;
}

const fmtDb = (x) => (Number.isFinite(x) ? `${x.toFixed(1)} dBFS` : "−∞");

/** 在頁面裡用獨立的 AudioContext 播一段測試音：有 / 沒有 crossOrigin 各量一次 MediaElementSource 的輸出 RMS（dBFS）。 */
async function corsSpike(c, wavPath) {
  const r = await c.ev(`(async () => {
    const url = window.__TAURI_INTERNALS__.convertFileSrc(${JSON.stringify(wavPath)}, "asset");
    const out = {};
    for (const co of ["anonymous", null]) {
      const ctx = new AudioContext();
      await ctx.resume();
      const el = new Audio();
      if (co) el.crossOrigin = co;
      el.preload = "auto";
      el.src = url;
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaElementSource(el).connect(an);
      await el.play().catch(() => {});
      await new Promise((res) => setTimeout(res, 700));
      const buf = new Float32Array(2048);
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      // -Infinity 經 CDP returnByValue 會變 null：用 -999 表示
      out[co ? "cors" : "noCors"] = rms > 0 ? 20 * Math.log10(rms) : -999;
      el.pause();
      await ctx.close();
    }
    return out;
  })()`);
  return { cors: r.cors <= -999 ? Number.NEGATIVE_INFINITY : r.cors, noCors: r.noCors <= -999 ? Number.NEGATIVE_INFINITY : r.noCors };
}

async function main() {
  const c = await connect(port);
  const mediaId = await waitReady(c, { proxy: true });
  const hasSeq = await c.ev(`typeof window.__aivcSeq === "object" && !!window.__aivcSeq.player && !!window.__aivcSeq.audio`);
  if (!hasSeq) throw new Error("window.__aivcSeq 不在：App 不是 DEV build，或 VideoStage 還沒掛上（序列播放器 / 預覽在那裡安裝）");

  const saved = await c.ev(`JSON.stringify({ exp: __aivc.settings.getState().experimental, space: __aivc.timeline.getState().space, seq: __aivc.edits.getState().sequence, am: __aivc.edits.getState().audioMedia })`);
  const proxy = await c.ev(`(() => { const m = __aivc.project.getState().media.find((x) => x.id === ${JSON.stringify(mediaId)}); return m && m.proxy ? { frames: m.proxy.frames, fps: m.proxy.fps, w: m.probe?.video?.width ?? 0, h: m.probe?.video?.height ?? 0 } : null; })()`);
  if (!proxy) throw new Error("第一支媒體沒有 proxy");
  const fps = proxy.fps;
  const fpsV = fps.num / fps.den;
  console.log(`媒體 ${mediaId}：${proxy.frames} 幀 @ ${fps.num}/${fps.den}`);

  let failed = false;
  const results = [];
  try {
    await c.ev(`(() => { __aivc.settings.getState().setExperimental({ sequence: true }); __aivc.timeline.getState().setSpace("sequence"); return true; })()`);
    await sleep(500);

    const base = { id: "seq-measure", name: "measure", fps, width: proxy.w, height: proxy.h, sampleRate: 48000, original: { muted: false, gainDb: 0 }, audio: { edgeDeclickMs: 3, limiter: false } };
    const clipAudio = { enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] };
    const clip = (id, srcIn, srcOut, enabled = true) => ({ kind: "clip", id, mediaId, srcIn, srcOut, enabled, audio: clipAudio });

    if (only === "all" || only === "boundaries") {
      const F = proxy.frames;
      const at = (sec) => Math.min(F - 1, Math.round(sec * fpsV));
      // 連續切點（不 seek）→ 同媒體跳接 → 空白 → 跳回前面 → 停用片段 → 跳到後段
      const video = [clip("c1", 0, at(3)), clip("c2", at(3), at(5)), clip("c3", at(20), at(23)), { kind: "gap", id: "g1", length: Math.round(fpsV) }, clip("c4", at(5), at(8)), clip("c5", at(30), at(32), false), clip("c6", at(40), at(43))];
      const T = video.reduce((s, it) => s + (it.kind === "gap" ? it.length : it.srcOut - it.srcIn), 0);
      const seq = { ...base, video, audioLanes: [] };
      await c.ev(`(() => { __aivc.edits.getState().loadSequence(${JSON.stringify(seq)}, []); return true; })()`);
      await sleep(400);
      await c.ev(`(() => { __aivc.playback.getState().seekSeq(0); return true; })()`);
      await sleep(800);
      await c.ev(`(() => { __aivcSeq.player.reset(); __aivcSeq.audio.reset(); return true; })()`);
      await c.ev(`__aivc.runCommand("playback.toggle", "bridge").then(() => true)`);
      const wallMax = (T / fpsV) * 1000 + 8000;
      const t0 = Date.now();
      let st = null;
      while (Date.now() - t0 < wallMax) {
        await sleep(250);
        st = await c.ev(`({ playing: __aivc.playback.getState().playing, seqFrame: __aivc.playback.getState().seqFrame, phase: __aivcSeq.player.phase() })`);
        if (!st.playing && st.seqFrame >= T - 1) break;
      }
      const stats = await c.ev(`JSON.parse(JSON.stringify(__aivcSeq.player.stats()))`);
      const stallMax = stats.stallsMs.length ? Math.max(...stats.stallsMs) : 0;
      const blackErr = stats.blackMs.map((b) => Math.abs(b.actual - b.expected));
      const blackErrMax = blackErr.length ? Math.max(...blackErr) : 0;
      const finished = st && !st.playing && st.seqFrame >= T - 1;
      const pass = finished && stats.outside === 0 && stallMax <= STALL_MAX_MS && blackErrMax <= BLACK_ERR_MAX_MS;
      results.push({
        name: "接點（M2.11）",
        pass,
        lines: [
          `序列 ${T} 幀（${(T / fpsV).toFixed(2)} s）、播完：${finished ? "是" : `否（停在 ${st?.seqFrame}，phase ${st?.phase}）`}`,
          `呈現 ${stats.presented} 幀；片段外的幀 ${stats.outside}（門檻 0）${stats.outside ? `  ⚠ 例：${JSON.stringify(stats.outsideSamples.slice(0, 5))} → 看 src/stage/sequencePlayer.ts boundaryLeadSec` : ""}`,
          `接點 ${stats.boundaries} 個；頓挫 ms：${stats.stallsMs.map((x) => x.toFixed(0)).join(", ") || "—"}（最大 ${stallMax.toFixed(0)}，門檻 ≤ ${STALL_MAX_MS}）`,
          `空白 / 停用走時誤差 ms：${blackErr.map((x) => x.toFixed(0)).join(", ") || "—"}（門檻 ≤ ${BLACK_ERR_MAX_MS}）`,
        ],
      });
      failed ||= !pass;
    }

    if (only === "all" || only === "drift") {
      const wav = makeTestWav();
      const T = proxy.frames;
      const S = Math.floor((T * 48000 * fps.den) / fps.num);
      const am = { id: "a-measure-drift", path: wav, name: "seq-drift-65s.wav", fingerprint: "measure-drift", probe: null, role: "music", audio: { codec: "pcm_s16le", sampleRate: 48000, channels: 1, channelLayout: "mono", startUs: 0, videoStartUs: null, nSamples: 65 * 48000, gaps: [] } };
      const lane = { id: "lane-measure", name: "A1 量尺", role: "music", muted: false, locked: false, syncLock: false, gainDb: -12, clips: [{ id: "aclip-measure", source: { type: "audio", audioId: am.id }, start: 0, length: S, srcIn: 0, enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] }] };
      const seq = { ...base, video: [clip("c1", 0, T)], audioLanes: [lane] };
      await c.ev(`(() => { __aivc.edits.getState().loadSequence(${JSON.stringify(seq)}, [${JSON.stringify(am)}]); return true; })()`);
      await sleep(400);
      await c.ev(`(() => { __aivc.playback.getState().seekSeq(0); return true; })()`);
      await sleep(800);
      // 先開播一次再停：讓 AudioContext 在使用者手勢內 resume、WAV 先解碼好（第一次播的解碼時間不算漂移）
      await c.ev(`__aivc.runCommand("playback.toggle", "bridge").then(() => true)`);
      await sleep(1500);
      await c.ev(`__aivc.runCommand("playback.toggle", "bridge").then(() => true)`);
      await c.ev(`(() => { __aivc.playback.getState().seekSeq(0); return true; })()`);
      await sleep(800);
      await c.ev(`(() => { __aivcSeq.player.reset(); __aivcSeq.audio.reset(); return true; })()`);
      await c.ev(`__aivc.runCommand("playback.toggle", "bridge").then(() => true)`);
      const wallMax = (T / fpsV) * 1000 + 8000;
      const t0 = Date.now();
      let st = null;
      // A0 原音的輸出電平（graph 路線時）：取最大值 —— 素材有安靜段，單點取樣可能剛好是靜音
      let a0PeakDb = Number.NEGATIVE_INFINITY;
      while (Date.now() - t0 < wallMax) {
        await sleep(500);
        st = await c.ev(`({ playing: __aivc.playback.getState().playing, seqFrame: __aivc.playback.getState().seqFrame, lv: __aivcSeq.audio.a0LevelDb() })`);
        if (typeof st.lv === "number") a0PeakDb = Math.max(a0PeakDb, st.lv);
        if (!st.playing && st.seqFrame >= T - 2) break;
      }
      const a = await c.ev(`(() => { const s = __aivcSeq.audio.stats(); return { ...JSON.parse(JSON.stringify(s)), ctx: __aivcSeq.audio.contextState(), a0: __aivcSeq.audio.a0Mode() }; })()`);
      const abs = a.drifts.map((d) => Math.abs(d));
      // CORS spike（§8.2 / M2.11）：同一個 asset protocol、同一種媒體元素，有 / 沒有 crossOrigin 各接一次 MediaElementSource 量電平。
      // 為什麼不直接看 A0 的電平：範例影片的音軌本身是數位靜音（−91 dB），A0 量到 −∞ 分不出是「沒聲音」還是「CORS 讓它變靜音」
      const spike = await corsSpike(c, wav);
      const pass = a.ctx === "running" && a.failed.length === 0 && a.samples > (T / fpsV) * 20 && a.maxAbsDriftMs < DRIFT_MAX_MS && a.resyncs === 0 && spike.cors > -90;
      results.push({
        name: "漂移（M2.16）",
        pass,
        lines: [
          `播放 ${(T / fpsV).toFixed(1)} s；AudioContext ${a.ctx}；A0 預覽路線 ${a.a0}（原音輸出峰值 ${Number.isFinite(a0PeakDb) ? a0PeakDb.toFixed(1) + " dBFS" : "−∞（素材音軌若本來就靜音屬正常）"}）；解碼失敗 ${a.failed.length ? a.failed.join(", ") : "無"}`,
          `CORS spike：asset protocol + MediaElementSource，crossOrigin=anonymous ${fmtDb(spike.cors)}、不設 ${fmtDb(spike.noCors)}（門檻：前者 > −90 dBFS；後者預期 −∞）${spike.cors > -90 ? "" : "  ⚠ 看 src-tauri 的 asset protocol 回應標頭"}`,
          `比對 ${a.samples} 次；排程開始 ${a.starts} 次（其中開播暖機後重錨 ${a.reanchors ?? 0} 次）、漂移重排 ${a.resyncs} 次（門檻 0）`,
          `|漂移| ms：p50 ${pct(abs, 50).toFixed(1)}、p95 ${pct(abs, 95).toFixed(1)}、最大 ${a.maxAbsDriftMs.toFixed(1)}（門檻 < ${DRIFT_MAX_MS}）；帶號平均 ${(a.drifts.reduce((s, d) => s + d, 0) / Math.max(1, a.drifts.length)).toFixed(1)}（正 = 聲音落後畫面）`,
        ],
      });
      failed ||= !pass;
    }
  } finally {
    // 還原：量尺不能讓使用者下次打開 App 時序列旗標是開的、序列被換成量尺的
    await c
      .ev(`(() => { const s = ${saved}; __aivc.runCommand("playback.stop", "bridge"); __aivc.edits.getState().loadSequence(s.seq, s.am); __aivc.timeline.getState().setSpace(s.space); __aivc.settings.getState().setExperimental(s.exp); return true; })()`)
      .catch((e) => console.error("還原失敗：", e.message));
    c.close();
  }

  for (const r of results) {
    console.log(`\n${r.pass ? "PASS" : "FAIL ⚠"}  ${r.name}`);
    for (const l of r.lines) console.log(`  ${l}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
