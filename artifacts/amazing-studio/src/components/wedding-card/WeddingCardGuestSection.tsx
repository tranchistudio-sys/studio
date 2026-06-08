import { useState } from "react";
import { useSubmitGuestEntry, useWeddingCardGuestEntries } from "@/hooks/use-wedding-cards";

export function WeddingCardGuestSection({ slug, compact }: { slug: string; compact?: boolean }) {
  const { data: entries = [] } = useWeddingCardGuestEntries(slug);
  const submit = useSubmitGuestEntry(slug);
  const [guestName, setGuestName] = useState("");
  const [message, setMessage] = useState("");
  const [attendance, setAttendance] = useState<"yes" | "no" | "unknown">("unknown");
  const [guestCount, setGuestCount] = useState(1);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await submit.mutateAsync({ guestName: guestName || null, message: message || null, attendance, guestCount });
      setGuestName("");
      setMessage("");
      setAttendance("unknown");
      setGuestCount(1);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch {
      alert("Không gửi được. Vui lòng thử lại.");
    }
  };

  const inputClass = "wc-bt-input";

  return (
    <section className={compact ? "mt-4" : "mx-auto max-w-lg px-6 py-12"}>
      {!compact && (
        <h2 className="font-serif text-xl text-center text-[var(--wc-bt-text)] mb-6">
          Lời chúc & xác nhận tham dự
        </h2>
      )}
      <form onSubmit={onSubmit} className="space-y-3 text-sm text-left">
        <input
          type="text"
          placeholder="Tên của bạn"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          className={inputClass}
          maxLength={120}
        />
        <textarea
          placeholder="Lời chúc"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          className={inputClass + " resize-none"}
          maxLength={2000}
        />
        <div className="flex flex-wrap gap-2">
          {(["yes", "no", "unknown"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setAttendance(v)}
              className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                attendance === v
                  ? "bg-[var(--wc-bt-taupe)] text-white border-[var(--wc-bt-taupe)]"
                  : "border-[var(--wc-bt-border)] text-[var(--wc-bt-muted)]"
              }`}
            >
              {v === "yes" ? "Tham dự" : v === "no" ? "Không tham dự" : "Chưa rõ"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[var(--wc-bt-muted)]">
          Số người
          <input
            type="number"
            min={1}
            max={20}
            value={guestCount}
            onChange={(e) => setGuestCount(Number(e.target.value) || 1)}
            className="w-16 wc-bt-input py-1"
          />
        </label>
        <button
          type="submit"
          disabled={submit.isPending}
          className="wc-bt-btn wc-bt-btn-primary w-full disabled:opacity-60"
        >
          {submit.isPending ? "Đang gửi…" : done ? "Đã gửi!" : "Gửi lời chúc"}
        </button>
      </form>
      {entries.length > 0 && (
        <ul className={compact ? "mt-6 space-y-3 max-h-48 overflow-y-auto text-left" : "mt-10 space-y-4"}>
          {entries.map((e) => (
            <li key={e.id} className="border-b border-[var(--wc-bt-border)] pb-3">
              <p className="font-medium text-[var(--wc-bt-text)]">{e.guestName || "Khách"}</p>
              {e.message && <p className="text-[var(--wc-bt-muted)] text-sm mt-1">{e.message}</p>}
              {e.attendance !== "unknown" && (
                <p className="text-[10px] uppercase tracking-wider text-[var(--wc-bt-taupe)] mt-1">
                  {e.attendance === "yes" ? "Tham dự" : "Không tham dự"}
                  {e.guestCount > 1 ? ` · ${e.guestCount} người` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
