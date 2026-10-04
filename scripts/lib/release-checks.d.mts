// scripts/lib/release-checks.mjs 的型別（src/updater/releaseChecks.test.ts 從 TS 測它；tsconfig 沒開 allowJs）。

export type SigningKeyKind = { kind: "empty" } | { kind: "content" } | { kind: "path"; path: string };

export function classifySigningKey(value: unknown): SigningKeyKind;
export function printableKeyPath(value: unknown): string | null;
export function sameRepo(a: unknown, b: unknown): boolean;
export function urlPointsAtRepo(url: unknown, repo: unknown): boolean;
export const APP_VERSION_RE: RegExp;
export function pep440Version(v: unknown): string;
