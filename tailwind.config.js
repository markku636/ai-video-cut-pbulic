/** @type {import('tailwindcss').Config} */
export default {
  // 外掛（plugins/<id>/frontend）的元件也要掃：不然只有外掛用到的 class 不會產生任何 CSS（沒有 plugins/ 時 glob 是空的）
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./plugins/*/frontend/**/*.{ts,tsx}"],
  // 亮色主題以 <html class="light"> 覆寫 CSS 變數切換；深色為預設（:root）。
  darkMode: ["selector", '[class~="light"] &'],
  theme: {
    extend: {
      colors: {
        // ---- 語意化表面 / 文字（CSS 變數驅動，明暗主題自動翻轉；rgb(var(--x) / <alpha-value>) 讓 text-fg/60 照常）----
        app: "rgb(var(--c-app) / <alpha-value>)",
        panel: "rgb(var(--c-panel) / <alpha-value>)",
        bar: "rgb(var(--c-bar) / <alpha-value>)",
        elevated: "rgb(var(--c-elevated) / <alpha-value>)",
        inset: "rgb(var(--c-inset) / <alpha-value>)",
        well: "rgb(var(--c-well) / <alpha-value>)",
        fg: "rgb(var(--c-fg) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        "on-accent": "rgb(var(--c-on-accent) / <alpha-value>)",
        success: "rgb(var(--c-success) / <alpha-value>)",
        warning: "rgb(var(--c-warning) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        info: "rgb(var(--c-info) / <alpha-value>)",
        // ---- 追蹤 / 遮罩 / 鏡頭 語意色（VideoStage 圖層、FrameTimeline 車道、Inspector chip 共用）----
        // 每個主題在 themes.ts 各自給值；這裡只宣告名字。使用者硬釘與解算分兩色，因為兩列時間軸的紀律
        // 就是「重跑 track 永不覆寫使用者關鍵幀」，顏色得讓人一眼分得出誰是誰。
        "track-user": "rgb(var(--c-track-user) / <alpha-value>)",
        "track-solver": "rgb(var(--c-track-solver) / <alpha-value>)",
        "track-lost": "rgb(var(--c-track-lost) / <alpha-value>)",
        "track-occluded": "rgb(var(--c-track-occluded) / <alpha-value>)",
        "mask-pos": "rgb(var(--c-mask-pos) / <alpha-value>)",
        "mask-neg": "rgb(var(--c-mask-neg) / <alpha-value>)",
        shot: "rgb(var(--c-shot) / <alpha-value>)",
        preview: "rgb(var(--c-preview) / <alpha-value>)",
        // ---- 序列時間軸（M2.10；docs/editor-m2-design.md §9.2）：片段、空白、波形、音量線、淡化、已用於序列 ----
        // 值在 themes.ts SequenceColors（深 / 淺各一組）；canvas 由 frametimeline/drawSequence.ts 讀同名 CSS 變數，
        // 軌道標頭（DOM）用這裡的 class，兩邊換主題時一起翻。
        "clip-video": "rgb(var(--c-clip-video) / <alpha-value>)",
        "clip-audio": "rgb(var(--c-clip-audio) / <alpha-value>)",
        "clip-selected": "rgb(var(--c-clip-selected) / <alpha-value>)",
        "clip-disabled": "rgb(var(--c-clip-disabled) / <alpha-value>)",
        "clip-offline": "rgb(var(--c-clip-offline) / <alpha-value>)",
        gap: "rgb(var(--c-gap) / <alpha-value>)",
        waveform: "rgb(var(--c-waveform) / <alpha-value>)",
        "waveform-rms": "rgb(var(--c-waveform-rms) / <alpha-value>)",
        "gain-line": "rgb(var(--c-gain-line) / <alpha-value>)",
        fade: "rgb(var(--c-fade) / <alpha-value>)",
        "envelope-point": "rgb(var(--c-envelope-point) / <alpha-value>)",
        "used-in-sequence": "rgb(var(--c-used-in-sequence) / <alpha-value>)",
      },
      // @colors-end  ← scripts/check-theme-tokens.mjs 只解析到這個哨兵；新顏色一律加在哨兵之上，哨兵本身不要動
      borderRadius: {
        xs: "var(--r-xs)",
        sm: "var(--r-sm)",
        DEFAULT: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
        full: "var(--r-full)",
      },
      boxShadow: {
        e1: "var(--e-1)",
        e2: "var(--e-2)",
        e3: "var(--e-3)",
        e4: "var(--e-4)",
      },
    },
  },
  plugins: [],
};
