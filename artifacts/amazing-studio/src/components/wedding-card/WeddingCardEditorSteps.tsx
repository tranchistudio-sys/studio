import { cn } from "@/lib/utils";

const STEPS = [
  { key: "template", label: "Mẫu" },
  { key: "photo", label: "Ảnh" },
  { key: "text", label: "Chữ" },
  { key: "link", label: "Link" },
] as const;

export function WeddingCardEditorSteps({
  hasPhoto,
  hasNames,
}: {
  hasPhoto: boolean;
  hasNames: boolean;
}) {
  const done = {
    template: true,
    photo: hasPhoto,
    text: hasNames,
    link: false,
  };

  return (
    <div className="flex items-center justify-between gap-1 py-3 px-1">
      {STEPS.map((s, i) => (
        <div key={s.key} className="flex flex-1 flex-col items-center gap-1 min-w-0">
          <div
            className={cn(
              "wc-step-dot flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-bold border-2 transition-all",
              done[s.key]
                ? "is-done bg-rose-600 border-rose-600 text-white"
                : "bg-white border-neutral-200 text-neutral-400",
            )}
          >
            {i + 1}
          </div>
          <span
            className={cn(
              "text-[9px] uppercase tracking-wide truncate w-full text-center",
              done[s.key] ? "text-rose-700 font-semibold" : "text-neutral-400",
            )}
          >
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
}
