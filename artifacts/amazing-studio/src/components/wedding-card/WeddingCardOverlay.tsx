import { Loader2, Sparkles } from "lucide-react";

export function WeddingCardOverlay({
  message,
  sub,
}: {
  message: string;
  sub?: string;
}) {
  return (
    <div
      className="wc-overlay fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#faf8f5]/96 backdrop-blur-sm px-6"
      role="status"
      aria-live="polite"
    >
      <div className="wc-overlay-spinner flex flex-col items-center gap-4">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-rose-200/40 blur-xl scale-150" />
          <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-lg border border-rose-100">
            <Loader2 className="h-7 w-7 animate-spin text-rose-500" />
          </div>
        </div>
        <div className="text-center">
          <p className="flex items-center justify-center gap-2 font-serif text-lg text-neutral-900">
            <Sparkles className="h-4 w-4 text-rose-400" />
            {message}
          </p>
          {sub && <p className="mt-1.5 text-sm text-neutral-500">{sub}</p>}
        </div>
      </div>
    </div>
  );
}
