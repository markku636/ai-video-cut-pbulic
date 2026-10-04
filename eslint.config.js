import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// 最小化 ESLint 設定：專注守住 React Hooks 規則。
// 背景（沿自 ai-music-cut）：曾發生 React #310（「Rendered more hooks than during the previous render」）——
// 即「在條件式 / 提前 return 之前呼叫 hook」導致跨 render hook 數量不一致而崩潰。
// 過去沒有 lint 把關，這類錯誤才會混進 build。rules-of-hooks 設為 error，build 時即攔下。
//
// scripts/**/*.mjs 也進 lint：check-*.mjs / sync-version.mjs 是 `npm run check` 與 build 的一部分，
// 它們壞掉的症狀是「檢查安靜地過」，所以至少要有語法層與未定義變數的把關。
//
// plugins/<id>/frontend/ 是選配外掛（開源版沒有這個資料夾）：跟 src/ 同一套規則。
export default [
  {
    files: ["src/**/*.{ts,tsx}", "plugins/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // Node 24 的全域；no-undef 靠這張表判斷，漏了就會誤報
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        WebSocket: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        globalThis: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
