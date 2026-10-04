#!/usr/bin/env node
// A/V 同步脈衝素材產生器＋M2.0 spike 量尺（docs/editor-m2-design.md §7.3–§7.5、§13 M2.0）。
//
// 為什麼要合成素材：序列混音的每一個設計選擇（-copyts＋絕對 pts 裁切、不用輸入端 -ss、aresample async 補斷層、
// amix normalize=0、apad＋atrim 收斂長度）都是「量了才知道」的事。脈衝素材每個整秒一個 10 ms 的純音，
// 解調後找上升沿就能把對齊誤差量到樣本級；1 s 斷層版本專門抓「數樣本法在斷層後整段提早」這個坑。
//
// 用法：
//   node scripts/make-av-sync-fixture.mjs                   只產素材到 samples/av-sync/（samples/ 不進 git）
//   node scripts/make-av-sync-fixture.mjs --measure         再跑 §7.4 的圖（rawvideo 管線），量脈衝誤差、樣本數、RSS
//   node scripts/make-av-sync-fixture.mjs --measure --long  另外產 1 小時素材，量「片段在第 55 分鐘」的峰值記憶體與耗時
//   選項：--out DIR  --ffmpeg DIR（含 ffmpeg 與 ffprobe；預設 AIVC_FFMPEG_DIR → src-tauri/resources/ffmpeg → PATH）  --force（重產素材）
//
// 產物：
//   pulse-vp9-opus.webm      60 s，VP9＋Opus 48 kHz 立體聲，1 kHz 脈衝 @ 每個整秒（−6 dBFS），畫面在整秒閃白一幀
//   pulse-h264-aac.mp4       同上，H.264＋AAC（AAC priming 1024 樣本靠 edit list 補償）
//   pulse-gap-vp9-opus.webm  由 pulse-vp9-opus.webm 串流複製而來，丟掉 pts 4.994–5.974 s 的 Opus 封包（剛好 1 s）、其餘 pts 不動
//                            （Chrome 錄影斷層的形狀：封包沒了、時間戳照走；5 s 的脈衝在斷層裡，6 s 的留著）
//   pulse-44k.mp3            60 s，44.1 kHz 立體聲，2 kHz 脈衝＋−26 dBFS 440 Hz 底音（LAME 延遲 1105 樣本）
//   pulse-1h-vp9-opus.webm   （--long）1 小時，64×36 小畫面
//   av-sync.json             素材清單與 ffprobe 事實；--measure 時附上量測結果
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const OUT = resolve(ROOT, argOf("--out", "samples/av-sync"));
const MEASURE = args.includes("--measure");
const LONG = args.includes("--long");
const FORCE = args.includes("--force");
const SR = 48000;
const log = (m) => console.log(`[av-sync] ${m}`);
const die = (m) => {
  console.error(`[av-sync] ${m}`);
  process.exit(1);
};

// ---------------------------------------------------------------- ffmpeg 位置
function findFfmpegDir() {
  const exe = process.platform === "win32" ? ".exe" : "";
  const cands = [argOf("--ffmpeg", ""), process.env.AIVC_FFMPEG_DIR ?? "", join(ROOT, "src-tauri", "resources", "ffmpeg")];
  for (const d of cands) if (d && existsSync(join(d, `ffmpeg${exe}`)) && existsSync(join(d, `ffprobe${exe}`))) return { ffmpeg: join(d, `ffmpeg${exe}`), ffprobe: join(d, `ffprobe${exe}`) };
  for (const d of (process.env.PATH ?? "").split(delimiter)) if (d && existsSync(join(d, `ffmpeg${exe}`)) && existsSync(join(d, `ffprobe${exe}`))) return { ffmpeg: join(d, `ffmpeg${exe}`), ffprobe: join(d, `ffprobe${exe}`) };
  return die("找不到 ffmpeg／ffprobe：用 --ffmpeg DIR 或設定 AIVC_FFMPEG_DIR");
}
const FF = findFfmpegDir();

/** 跑一支子行程；stdout 收成 Buffer（解碼 f32 用），stderr 收成字串。feed(stdin) 可以串流寫入 rawvideo。 */
function run(bin, argv, { feed = null, check = true } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(bin, argv, { stdio: [feed ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
    const out = [];
    let err = "";
    p.stdout.on("data", (b) => out.push(b));
    p.stderr.on("data", (b) => (err += b.toString("utf8")));
    p.on("error", rej);
    // ffmpeg 提早結束時 stdin 會 EPIPE：吞掉，交給 close 的退出碼回報（否則 Node 直接崩潰、看不到 stderr）
    if (feed) p.stdin.on("error", () => {});
    p.on("close", (code) => {
      const r = { code, stdout: Buffer.concat(out), stderr: err };
      if (check && code !== 0) rej(new Error(`${bin} ${argv.slice(0, 12).join(" ")} … 退出碼 ${code}\n${err.split("\n").slice(-15).join("\n")}`));
      else res(r);
    });
    if (feed) feed(p.stdin).then(() => p.stdin.end(), rej);
  });
}
const ffmpeg = (argv, opts) => run(FF.ffmpeg, ["-hide_banner", "-nostdin", ...argv], opts);
const ffprobeJson = async (argv) => JSON.parse((await run(FF.ffprobe, ["-v", "error", "-of", "json", ...argv])).stdout.toString("utf8"));

async function encoders() {
  const r = await ffmpeg(["-encoders"], { check: false });
  return new Set(
    r.stdout
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 2 && p[0].length === 6)
      .map((p) => p[1]),
  );
}

// ---------------------------------------------------------------- 素材
// aevalsrc 的運算式放在單引號裡：逗號在 filtergraph 單引號內是字面值，不必逐個跳脫
const PULSE_1K = "0.5*sin(2*PI*1000*t)*lt(mod(t,1),0.01)";
// 音樂脈衝放在「整秒 + 0.5 s」：§7.4 的圖裡影片片段的脈衝都落在輸出的整秒上，兩種脈衝若同時出現，
// 10 ms 短脈衝的頻譜洩漏會讓對方的上升沿偵測偏 20～60 樣本（第一次量就踩到），錯開半秒兩邊互不干擾
const MUSIC_OFFSET_US = 500_000;
const MUSIC_2K = "0.5*sin(2*PI*2000*t)*lt(mod(t+0.5,1),0.01)+0.05*sin(2*PI*440*t)";
const flash = (w, h, dur) => `color=c=black:s=${w}x${h}:r=30:d=${dur},drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.0333)'`;

async function makeFixtures(enc) {
  mkdirSync(OUT, { recursive: true });
  const h264 = ["libx264", "libopenh264", "h264_videotoolbox", "h264_mf"].find((c) => enc.has(c));
  if (!h264) die("ffmpeg 沒有任何 H.264 編碼器");
  const vp9 = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-g", "60", "-pix_fmt", "yuv420p"];
  const pulse = (dur) => ["-f", "lavfi", "-i", `aevalsrc=exprs='${PULSE_1K}|${PULSE_1K}':s=${SR}:d=${dur}:n=960`];
  const specs = [
    { file: "pulse-vp9-opus.webm", args: ["-f", "lavfi", "-i", flash(320, 180, 60), ...pulse(60), ...vp9, "-c:a", "libopus", "-b:a", "128k", "-shortest"] },
    { file: "pulse-h264-aac.mp4", args: ["-f", "lavfi", "-i", flash(320, 180, 60), ...pulse(60), "-c:v", h264, "-b:v", "500k", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest"] },
    {
      // 斷層要在「封包層」做：在編碼前用 aselect 丟幀的話，libopus 有 312 樣本的 pre-skip 偏移，
      // 斷層前最後一個封包會拼進斷層後 13.5 ms 的樣本，6 s 的脈衝被搬到 5 s（第一次量就踩到，素材本身就錯了）。
      // noise bsf 的 drop 直接丟掉 pts ∈ [4994, 5974] ms 的封包（時基 1/1000），其餘封包原封不動。
      // 封包格線因 pre-skip 偏 6.5 ms：4.994 的封包裝的是 4.9935–5.0135 s，5 s 的脈衝在它裡面，所以要從它開始丟。
      file: "pulse-gap-vp9-opus.webm",
      gapS: [4.994, 5.994],
      args: ["-i", join(OUT, "pulse-vp9-opus.webm"), "-c", "copy", "-bsf:a", "noise=drop='between(pts,4994,5974)'"],
    },
    { file: "pulse-44k.mp3", args: ["-f", "lavfi", "-i", `aevalsrc=exprs='${MUSIC_2K}|${MUSIC_2K}':s=44100:d=60`, "-c:a", "libmp3lame", "-b:a", "192k"] },
  ];
  if (LONG) specs.push({ file: "pulse-1h-vp9-opus.webm", args: ["-f", "lavfi", "-i", flash(64, 36, 3600), ...pulse(3600), ...vp9.map((a) => (a === "300k" ? "50k" : a)), "-c:a", "libopus", "-b:a", "96k", "-shortest"] });
  const manifest = { generatedAt: new Date().toISOString(), ffmpeg: (await ffmpeg(["-version"])).stdout.toString("utf8").split("\n")[0].trim(), fixtures: [] };
  for (const s of specs) {
    const path = join(OUT, s.file);
    if (FORCE || !existsSync(path)) {
      const t0 = Date.now();
      await ffmpeg(["-loglevel", "error", "-y", ...s.args, path]);
      log(`產生 ${s.file}（${((Date.now() - t0) / 1000).toFixed(1)} s）`);
    }
    manifest.fixtures.push({ file: s.file, ...(s.gapS ? { audioGapSeconds: s.gapS } : {}), ...(await facts(path)) });
  }
  return manifest;
}

/** ffprobe 事實：兩條串流第一個解碼幀的 pts（µs，= audio_info 的 startUs／videoStartUs）與 codec。 */
async function facts(path) {
  const firstPts = async (sel) => {
    const d = await ffprobeJson(["-select_streams", sel, "-read_intervals", "%+#2", "-show_entries", "frame=pts_time", path]);
    const t = d.frames?.[0]?.pts_time;
    return t == null ? null : Math.round(Number(t) * 1e6);
  };
  const st = await ffprobeJson(["-show_entries", "stream=index,codec_type,codec_name,sample_rate,channels,start_time", path]);
  const a = st.streams.find((x) => x.codec_type === "audio");
  const v = st.streams.find((x) => x.codec_type === "video");
  return {
    audioCodec: a?.codec_name ?? null,
    sampleRate: a ? Number(a.sample_rate) : null,
    videoCodec: v?.codec_name ?? null,
    startUs: a ? await firstPts("a:0") : null,
    videoStartUs: v ? await firstPts("v:0") : null,
  };
}

// ---------------------------------------------------------------- 解碼與脈衝偵測
/** 以容器絕對時間解碼成 48 kHz 立體聲 f32（同 peaks：-copyts＋first_pts=0，第 i 個樣本就是絕對時間 i/48000）。 */
async function decodeAbs(path, { window = null } = {}) {
  // 1 小時素材只解需要的窗：atrim 依絕對 pts 裁切後 asetpts 歸零，第 0 個樣本 = window[0] 秒
  const pre = window ? `atrim=start=${window[0]}:end=${window[1]},asetpts=PTS-STARTPTS,` : "";
  const r = await ffmpeg(["-loglevel", "error", "-copyts", "-i", path, "-map", "0:a:0", "-af", `${pre}aresample=${SR}:async=1:min_hard_comp=0.020:first_pts=0`, "-ac", "2", "-f", "f32le", "pipe:1"]);
  const b = r.stdout;
  const f = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length - (b.length % 8))));
  const left = new Float32Array(f.length / 2);
  for (let i = 0; i < left.length; i++) left[i] = f[2 * i];
  return left;
}

/** 不經 aresample 的純解碼樣本數（驗 I3：解碼後剛好 S(T)，priming／pre-skip 應由容器補償）。 */
async function decodedSamples(path) {
  const r = await ffmpeg(["-loglevel", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"]);
  return r.stdout.length / 2;
}

/** f Hz 解調後 5 ms（240 樣本）滑動平均的包絡。240 樣本窗在 200 Hz 的整數倍有零點：1 kHz 與 2 kHz 互不干擾。 */
function envelope(x, freq, k = 240) {
  const n = x.length;
  const w = (2 * Math.PI * freq) / SR;
  const cr = new Float64Array(n + 1);
  const ci = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cr[i + 1] = cr[i] + x[i] * Math.cos(w * i);
    ci[i + 1] = ci[i] - x[i] * Math.sin(w * i);
  }
  const m = new Float32Array(Math.max(0, n - k + 1));
  for (let i = 0; i < m.length; i++) m[i] = 2 * Math.hypot((cr[i + k] - cr[i]) / k, (ci[i + k] - ci[i]) / k);
  return m;
}

/** 在期望位置 ±50 ms 內找脈衝上升沿（越過峰值一半的第一個點）；峰值太小回 null（被淡化或斷層吃掉）。 */
function onsetNear(m, expect, minPeak = 0.01) {
  const lo = Math.max(0, expect - 2400);
  const hi = Math.min(m.length, expect + 2400);
  let pk = 0;
  for (let i = lo; i < hi; i++) if (m[i] > pk) pk = m[i];
  if (pk < minPeak) return null;
  for (let i = lo; i < hi; i++) if (m[i] >= pk / 2) return { at: i, peakDb: 20 * Math.log10(pk) };
  return null;
}

// ---------------------------------------------------------------- §7.4 的圖（M2.6 的 audio_graph.py 之前，這裡手寫同一張）
const S = (t, num = 30, den = 1) => Math.floor((t * SR * den) / num);
const sec = (us) => `${us < 0 ? "-" : ""}${Math.floor(Math.abs(us) / 1e6)}.${String(Math.abs(us) % 1e6).padStart(6, "0")}`;
const absK = (k, vs) => vs + Math.round((k * 1e6) / 30);

function chain(input, label, { inUs, outUs, L, delay, fadeIn = 144, fadeOut = 144, curve = "tri", gainDb = 0, envelope: env = "", count = false }) {
  const pts = count ? `asetpts=N/SR/TB` : `asetpts=PTS-STARTPTS`;
  return (
    `[${input}:a]atrim=start=${sec(inUs)}:end=${sec(outUs)},${pts},aresample=${SR}:async=1:min_hard_comp=0.020:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `apad,atrim=end_sample=${L}${env ? `,asetnsamples=n=240:p=0,volume=eval=frame:volume='${env}'` : ""},` +
    // 只有防爆音（144 樣本）的一端用 tri，使用者淡化用片段的曲線（§7.4：c2 淡入 tri、淡出 qsin）
    `afade=t=in:ss=0:ns=${fadeIn}:curve=${fadeIn === 144 ? "tri" : curve},afade=t=out:ss=${L - fadeOut}:ns=${fadeOut}:curve=${fadeOut === 144 ? "tri" : curve}` +
    `${gainDb ? `,volume=volume=${gainDb}dB` : ""},adelay=delays=${delay}S:all=1[${label}]`
  );
}

/** 兩片段（k 60..360、930..1380）＋一段音樂：§7.4 的數字，但 inUs 依素材實際的 videoStartUs／startUs 算。 */
function graph74(video, music) {
  const vs = video.videoStartUs;
  const clips = [
    { label: "c1", k0: 60, k1: 360, t0: 0, fadeOut: 144, curve: "tri", gainDb: 0 },
    { label: "c2", k0: 930, k1: 1380, t0: 300, fadeOut: 48000, curve: "qsin", gainDb: -3 },
  ];
  const lines = clips.map((c, i) => chain(i + 1, c.label, { inUs: absK(c.k0, vs), outUs: absK(c.k1, vs), L: S(c.t0 + c.k1 - c.k0) - S(c.t0), delay: S(c.t0), fadeOut: c.fadeOut, curve: c.curve, gainDb: c.gainDb }));
  const mIn = music.startUs + Math.round((88200 * 1e6) / 44100);
  const env = "if(lt(t,8.75),1,if(lt(t,9),pow(10,-10*(t-8.75)/0.25/20),if(lt(t,13),pow(10,-10/20),if(lt(t,13.25),pow(10,-10*(13.25-t)/0.25/20),1))))";
  // outUs = inUs + 20 s：與 §7.4 逐字的圖相同（多出來的尾巴由 apad＋atrim=end_sample 收斂）
  lines.push(chain(3, "m1", { inUs: mIn, outUs: mIn + Math.ceil((960000 * 1e6) / SR), L: 960000, delay: 48000, fadeIn: 96000, fadeOut: 144000, curve: "qsin", gainDb: -12, envelope: env }));
  lines.push(`[c1][c2][m1]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample=${S(750)}[aout]`);
  return {
    text: lines.join(";\n") + "\n",
    T: 750,
    // 期望的脈衝位置（輸出樣本，相對輸出第一幀）：來源絕對時間 n 秒的脈衝 → S(t0) + (n·1e6 − inUs)·48000/1e6
    expect: [
      ...clips.flatMap((c) => pulsesIn(absK(c.k0, vs), absK(c.k1, vs), S(c.t0), 0).map((p) => ({ ...p, clip: c.label, freq: 1000 }))),
      ...pulsesIn(mIn, mIn + 20e6, 48000, music.startUs + MUSIC_OFFSET_US).map((p) => ({ ...p, clip: "m1", freq: 2000 })),
    ],
  };
}

/** [inUs, outUs) 裡每個整秒脈衝（來源絕對時間 base + n 秒）的期望輸出位置；離片段邊緣 < 20 ms 的不算（防爆音淡化會改變上升沿）。 */
function pulsesIn(inUs, outUs, s0, baseUs) {
  const out = [];
  for (let n = 0; n < 4000; n++) {
    const at = baseUs + n * 1e6;
    if (at < inUs + 20000 || at > outUs - 30000) continue;
    out.push({ n, srcAbsUs: at, expect: s0 + Math.round(((at - inUs) * SR) / 1e6) });
  }
  return out;
}

/** rawvideo 管線（同引擎 encoder.py）：Y 平面依幀號變亮度，UV 128。 */
function rawFeeder(w, h, T) {
  return async (stdin) => {
    const size = (w * h * 3) / 2;
    for (let t = 0; t < T; t++) {
      const buf = Buffer.alloc(size, 128);
      buf.fill(16 + ((t * 7) % 220), 0, w * h);
      if (!stdin.write(buf)) await new Promise((r) => stdin.once("drain", r));
    }
  };
}

const OUTPUTS = (enc) => {
  const h264 = ["libx264", "libopenh264", "h264_videotoolbox", "h264_mf"].find((c) => enc.has(c));
  return [
    { ext: "mkv", args: ["-c:v", "ffv1", "-c:a", "pcm_s16le", "-f", "matroska"] },
    { ext: "webm", args: ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-c:a", "libopus", "-b:a", "160k", "-f", "webm"] },
    { ext: "mp4", args: ["-c:v", h264, "-b:v", "500k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-f", "mp4"] },
  ];
};

/** 跑一張圖：rawvideo 從 stdin、音訊從檔案、濾鏡圖寫檔用 -/filter_complex；回 ffmpeg -benchmark 的 rtime／maxrss。 */
async function render(graphText, inputs, out, { w = 320, h = 180, T, outArgs }) {
  const graphFile = `${out}.audio.txt`;
  writeFileSync(graphFile, graphText, "utf8");
  const argv = [
    "-loglevel", "info", "-nostats", "-benchmark", "-y", "-copyts",
    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-video_size", `${w}x${h}`, "-framerate", "30/1", "-i", "pipe:0",
    ...inputs.flatMap((p) => ["-i", p]),
    "-/filter_complex", graphFile,
    "-map", "0:v:0", "-map", "[aout]", ...outArgs, out,
  ];
  const t0 = Date.now();
  const r = await ffmpeg(argv, { feed: rawFeeder(w, h, T) });
  const rss = /bench: maxrss=(\d+)KiB/.exec(r.stderr);
  const rt = /bench: .*rtime=([\d.]+)s/.exec(r.stderr);
  return { wallS: (Date.now() - t0) / 1000, rtimeS: rt ? Number(rt[1]) : null, maxRssMiB: rss ? Math.round(Number(rss[1]) / 1024) : null };
}

async function outputFacts(path) {
  const d = await ffprobeJson(["-count_frames", "-show_entries", "stream=codec_type,codec_name,start_time,nb_read_frames", path]);
  const v = d.streams.find((s) => s.codec_type === "video");
  const a = d.streams.find((s) => s.codec_type === "audio");
  return { videoFrames: Number(v?.nb_read_frames), videoStart: v?.start_time ?? null, audioStart: a?.start_time ?? null, ...(await facts(path)) };
}

/** 輸出脈衝誤差（樣本）＝ 偵測位置 − 輸出影片起點 − 期望位置 − 來源偵測偏差（同一個偵測器在來源上量的上升沿偏移）。 */
async function pulseErrors(outPath, expects, bias, videoStartUs) {
  const x = await decodeAbs(outPath);
  const vs = Math.round(((videoStartUs ?? 0) * SR) / 1e6);
  const envs = new Map();
  const rows = [];
  for (const e of expects) {
    if (!envs.has(e.freq)) envs.set(e.freq, envelope(x, e.freq));
    const b = bias.get(`${e.freq}:${e.n}`);
    const o = onsetNear(envs.get(e.freq), vs + e.expect + (b ?? 0));
    rows.push({ clip: e.clip, n: e.n, expect: e.expect, error: o && b != null ? o.at - vs - e.expect - b : null, peakDb: o ? Math.round(o.peakDb * 10) / 10 : null });
  }
  return rows;
}

/** 來源的偵測偏差：脈衝 n 的絕對時間 × 48000 與偵測到的上升沿之差（包絡窗與編碼器造成，對輸出是常數）。 */
async function sourceBias(path, freq, baseUs, ns, window = null) {
  const x = await decodeAbs(path, { window });
  const m = envelope(x, freq);
  const out = new Map();
  for (const n of ns) {
    const abs = Math.round(((baseUs + n * 1e6) * SR) / 1e6) - (window ? window[0] * SR : 0);
    const o = onsetNear(m, abs);
    if (o) out.set(`${freq}:${n}`, o.at - abs);
  }
  return out;
}

const summarize = (rows) => {
  const errs = rows.filter((r) => r.error != null).map((r) => r.error);
  const mean = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
  return { pulses: rows.length, found: errs.length, maxAbsError: errs.length ? Math.max(...errs.map(Math.abs)) : null, meanError: mean == null ? null : Math.round(mean * 100) / 100 };
};

// M2.0 驗收門檻（§13）：脈衝誤差 ≤ 2 樣本；解碼樣本數 = S(T)；1 小時案例峰值記憶體 < 500 MB；斷層素材 pts 法正確。
// AAC 例外：編碼器把最後一個不足 1024 的幀補滿，mp4 的 edit list 只補償開頭 priming、不裁尾巴，
// 所以 mp4 解碼後是 S(T) 進位到 1024 的倍數（多出來的在結尾，不影響對齊）；門檻放寬成「多 0～1023 個」。
const MAX_PULSE_ERROR = 2;
const MAX_RSS_MIB = 500;
const gates = [];
const gate = (name, ok, detail) => {
  gates.push({ name, ok, detail });
  if (!ok) process.exitCode = 1;
};
const samplesOk = (ext, got, want) => (ext === "mp4" ? got >= want && got - want < 1024 : got === want);

async function measure(manifest, enc) {
  const fx = Object.fromEntries(manifest.fixtures.map((f) => [f.file, f]));
  const music = fx["pulse-44k.mp3"];
  const musicPath = join(OUT, music.file);
  const results = { sequence: { T: 750, expectedSamples: S(750) }, runs: [] };

  for (const srcName of ["pulse-vp9-opus.webm", "pulse-h264-aac.mp4"]) {
    const src = fx[srcName];
    const srcPath = join(OUT, srcName);
    const g = graph74(src, music);
    const bias = new Map([
      ...(await sourceBias(srcPath, 1000, 0, [...new Set(g.expect.filter((e) => e.freq === 1000).map((e) => e.n))])),
      ...(await sourceBias(musicPath, 2000, music.startUs + MUSIC_OFFSET_US, [...new Set(g.expect.filter((e) => e.freq === 2000).map((e) => e.n))])),
    ]);
    for (const o of OUTPUTS(enc)) {
      const out = join(OUT, `out-${srcName.replace(/\.\w+$/, "")}.${o.ext}`);
      const perf = await render(g.text, [srcPath, srcPath, musicPath], out, { T: g.T, outArgs: o.args });
      const of = await outputFacts(out);
      const rows = await pulseErrors(out, g.expect, bias, of.videoStartUs);
      const r = {
        source: srcName, output: o.ext, ...perf, videoFrames: of.videoFrames, decodedSamples: await decodedSamples(out),
        videoStart: of.videoStart, audioStart: of.audioStart, outAudioStartUs: of.startUs, outVideoStartUs: of.videoStartUs,
        biasRange: [Math.min(...bias.values()), Math.max(...bias.values())], ...summarize(rows), rows,
      };
      results.runs.push(r);
      const tag = `${srcName} → ${o.ext}`;
      gate(`${tag} 影片幀數 = T`, r.videoFrames === g.T, `${r.videoFrames}`);
      gate(`${tag} 解碼樣本數 = S(T)`, samplesOk(o.ext, r.decodedSamples, S(g.T)), `${r.decodedSamples}（S(T) = ${S(g.T)}）`);
      if (o.ext === "mkv") {
        // 無損輸出（PCM）：量到的就是管線本身的對齊誤差，每個脈衝都要 ≤ 2 樣本
        gate(`${tag} 脈衝誤差 ≤ ${MAX_PULSE_ERROR} 樣本`, r.found === r.pulses && r.maxAbsError <= MAX_PULSE_ERROR, `${r.found}/${r.pulses}，最大 ${r.maxAbsError}、平均 ${r.meanError}`);
      } else {
        // 有損輸出多了一次編解碼：Opus／AAC 的前回聲讓半高點逐個脈衝跳 ±幾個樣本（不是偏移），門檻看平均（系統性偏移），最大值只記錄
        gate(`${tag} 脈衝平均偏移 ≤ ${MAX_PULSE_ERROR} 樣本`, r.found === r.pulses && Math.abs(r.meanError) <= MAX_PULSE_ERROR, `${r.found}/${r.pulses}，平均 ${r.meanError}、最大 ${r.maxAbsError}（記錄）`);
      }
      log(`${srcName} → ${o.ext}：幀 ${r.videoFrames}、樣本 ${r.decodedSamples}（應 ${S(750)}）、脈衝 ${r.found}/${r.pulses} 最大誤差 ${r.maxAbsError}／平均 ${r.meanError} 樣本、RSS ${r.maxRssMiB} MiB、${r.rtimeS}s`);
    }
  }

  // ---- 1 s 斷層：pts 法 vs 數樣本法（片段 3–10 s）----
  {
    const gap = fx["pulse-gap-vp9-opus.webm"];
    const p = join(OUT, gap.file);
    const vs = gap.videoStartUs;
    const [k0, k1] = [90, 300];
    const one = (count) =>
      chain(1, "c1", { inUs: absK(k0, vs), outUs: absK(k1, vs), L: S(k1 - k0), delay: 0, count }) + `;\n[c1]apad,atrim=end_sample=${S(k1 - k0)}[aout]\n`;
    const gapRes = {};
    // 期望：來源整秒脈衝 n ∈ [3, 10) 裡 5 s 那個落在斷層中。pts 法：留在 n − 3 秒（斷層位置留白）；
    // 數樣本法：1 s 的斷層被壓掉，之後的脈衝整段提早 1 s，所以是 0,1,2,3,4,5
    const kept = [3, 4, 6, 7, 8, 9];
    const want = { pts: kept.map((n) => n - 3), count: kept.map((_, i) => i) };
    for (const [name, count] of [["pts", false], ["count", true]]) {
      const out = join(OUT, `out-gap-${name}.mkv`);
      await render(one(count), [p], out, { T: k1 - k0, outArgs: ["-c:v", "ffv1", "-c:a", "pcm_s16le", "-f", "matroska"] });
      const x = await decodeAbs(out);
      const m = envelope(x, 1000);
      const found = [];
      for (let s = 0; s * SR < m.length; s++) if (onsetNear(m, s * SR - 121, 0.05)) found.push(s);
      gapRes[name] = { pulsesAtOutputSeconds: found, samples: await decodedSamples(out) };
      log(`斷層素材 ${name} 法：輸出脈衝在 ${found.join(",")} s`);
      gapRes[name].expected = want[name];
    }
    gate("斷層素材 pts 法：斷層留白、之後不提早", gapRes.pts.pulsesAtOutputSeconds.join() === want.pts.join(), gapRes.pts.pulsesAtOutputSeconds.join(","));
    // 數樣本法「應該錯」：確認素材真的能抓到這個坑（抓不到就代表素材沒有斷層，pts 法的通過也不算數）
    gate("斷層素材 數樣本法：確實提早 1 s（素材有效）", gapRes.count.pulsesAtOutputSeconds.join() === want.count.join(), gapRes.count.pulsesAtOutputSeconds.join(","));
    results.gap = { clip: "k 90..300（3–10 s）", sourceGapSeconds: gap.audioGapSeconds, ...gapRes };
  }

  // ---- 1 小時：片段在第 55 分鐘（不加 -ss，音訊從頭解到 55 分）----
  if (LONG) {
    const lf = fx["pulse-1h-vp9-opus.webm"];
    const p = join(OUT, lf.file);
    const vs = lf.videoStartUs;
    const [k0, k1] = [99000, 99300];
    const text = chain(1, "c1", { inUs: absK(k0, vs), outUs: absK(k1, vs), L: S(300), delay: 0 }) + `;\n[c1]apad,atrim=end_sample=${S(300)}[aout]\n`;
    const out = join(OUT, "out-1h-55min.mkv");
    const perf = await render(text, [p], out, { w: 64, h: 36, T: 300, outArgs: ["-c:v", "ffv1", "-c:a", "pcm_s16le", "-f", "matroska"] });
    const ns = pulsesIn(absK(k0, vs), absK(k1, vs), 0, 0);
    const bias = await sourceBias(p, 1000, 0, ns.map((e) => e.n), [3299, 3312]);
    const of = await outputFacts(out);
    const rows = await pulseErrors(out, ns.map((e) => ({ ...e, clip: "c1", freq: 1000 })), bias, of.videoStartUs);
    results.long = { clip: "k 99000..99300（55:00–55:10）", ...perf, videoFrames: of.videoFrames, decodedSamples: await decodedSamples(out), expectedSamples: S(300), ...summarize(rows) };
    log(`1 小時素材：RSS ${perf.maxRssMiB} MiB、${perf.rtimeS}s、脈衝最大誤差 ${results.long.maxAbsError}`);
    gate(`1 小時素材峰值記憶體 < ${MAX_RSS_MIB} MiB`, perf.maxRssMiB != null && perf.maxRssMiB < MAX_RSS_MIB, `${perf.maxRssMiB} MiB、rtime ${perf.rtimeS} s`);
    gate("1 小時素材 解碼樣本數 = S(T)", results.long.decodedSamples === S(300), `${results.long.decodedSamples}`);
    gate(`1 小時素材 脈衝誤差 ≤ ${MAX_PULSE_ERROR} 樣本`, results.long.found === results.long.pulses && results.long.maxAbsError <= MAX_PULSE_ERROR, `${results.long.found}/${results.long.pulses}，最大 ${results.long.maxAbsError}`);
  }
  return results;
}

// ---------------------------------------------------------------- main
const enc = await encoders();
for (const need of ["libvpx-vp9", "libopus", "libmp3lame", "aac", "ffv1"]) if (!enc.has(need)) die(`ffmpeg 沒有 ${need}`);
const manifest = await makeFixtures(enc);
const manifestPath = join(OUT, "av-sync.json");
if (MEASURE) {
  manifest.measure = await measure(manifest, enc);
  manifest.measure.gates = gates;
  manifest.measuredAt = new Date().toISOString();
  for (const g of gates) log(`${g.ok ? "PASS" : "FAIL"}  ${g.name}：${g.detail}`);
} else if (existsSync(manifestPath)) {
  // 只產素材時保留上一次的量測結果
  const prev = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (prev.measure) Object.assign(manifest, { measure: prev.measure, measuredAt: prev.measuredAt });
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
log(`完成：${manifestPath}`);
