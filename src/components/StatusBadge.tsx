import { CheckCircle2, Clock3, Loader2, XCircle } from "lucide-react";
import type { DocStatus } from "../types";

const config: Record<DocStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  pending: { label: "待解析", className: "text-muted bg-black/5", icon: Clock3 },
  parsed: { label: "已解析", className: "text-brand-dark bg-brand-soft", icon: CheckCircle2 },
  parsing: { label: "解析中", className: "text-warn bg-warn-soft", icon: Loader2 },
  failed: { label: "解析失败", className: "text-danger bg-danger-soft", icon: XCircle },
};

export default function StatusBadge({ status }: { status: DocStatus }) {
  const { label, className, icon: Icon } = config[status];
  return (
    <span className={`pill ${className}`}>
      <Icon className={`h-3.5 w-3.5 ${status === "parsing" ? "animate-spin" : ""}`} />
      {label}
    </span>
  );
}
