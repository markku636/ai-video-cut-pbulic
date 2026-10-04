import type { ReactNode } from "react";

/** 設定對話框的一段（標題 + 框）。外掛的設定區段也用這一個，長相才一致。 */
export default function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-fg/45 uppercase tracking-wide">{title}</div>
      <div className="min-w-0 overflow-x-hidden rounded-md border border-fg/10 p-3 space-y-3">{children}</div>
    </div>
  );
}
