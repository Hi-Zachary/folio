import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

export default function Modal({
  title,
  onClose,
  children,
  footer,
  variant = "default",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  variant?: "default" | "wide" | "reader";
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 px-0 py-0 sm:items-center sm:px-4 sm:py-8"
      onClick={onClose}
    >
      <div
        className={`flex w-full flex-col overflow-hidden border border-line bg-card ${variant === "reader" ? "h-[96vh] max-h-[96vh] max-w-6xl rounded-none sm:rounded-2xl" : variant === "wide" ? "max-h-[92vh] max-w-5xl rounded-t-2xl sm:rounded-2xl" : "max-h-[85vh] max-w-lg rounded-t-2xl sm:rounded-2xl"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="btn btn-ghost -mr-1 px-2 py-1.5" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
