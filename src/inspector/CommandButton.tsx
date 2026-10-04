import type { LucideIcon } from "lucide-react";
import { command, runCommand, useEnabled } from "../commands/registry";
import { useT } from "../i18n";
import { Button, IconButton, type ButtonVariant } from "../ui/index";

/**
 * 面板上的按鈕一律派發**指令**（一功能一 Command，計畫 §9）：追到尾、清除之前、找物件……
 * 都是 commands/ 裡登記的 id，面板不直接碰 pipeline。指令還沒登記（里程碑未到）或 enabled() 說不行
 * → 按鈕灰掉、title 說原因，不靜默失敗。標籤由面板給（計畫的 UI 文案），不取指令 title，
 * 這樣指令沒登記時面板長相也一樣。
 */
interface CommandButtonProps {
  id: string;
  label: string;
  icon?: LucideIcon;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  className?: string;
  full?: boolean;
}

export function useCommandGate(id: string): { disabled: boolean; why: string | undefined } {
  const t = useT();
  const c = command(id);
  const en = useEnabled(c);
  if (!c) return { disabled: true, why: t("這個指令還沒接上（{id}）", { id }) };
  if (!en.ok) return { disabled: true, why: t(en.why) };
  return { disabled: false, why: undefined };
}

export function CommandButton({ id, label, icon, variant = "secondary", size = "sm", className, full }: CommandButtonProps) {
  const { disabled, why } = useCommandGate(id);
  return (
    <Button icon={icon} variant={variant} size={size} className={className} full={full} disabled={disabled} title={why ?? label} onClick={() => void runCommand(id, "toolbar")}>
      {label}
    </Button>
  );
}

export function CommandIconButton({ id, label, icon, iconSize = 15, className }: { id: string; label: string; icon: LucideIcon; iconSize?: number; className?: string }) {
  const { disabled, why } = useCommandGate(id);
  return <IconButton icon={icon} label={why ? `${label} — ${why}` : label} iconSize={iconSize} disabled={disabled} className={className} onClick={() => void runCommand(id, "toolbar")} />;
}
