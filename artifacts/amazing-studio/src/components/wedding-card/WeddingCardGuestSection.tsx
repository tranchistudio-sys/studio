import { useState } from "react";
import { useSubmitGuestEntry, useWeddingCardGuestEntries } from "@/hooks/use-wedding-cards";

const DEMO_WISHES = [
  { id: 1, guestName: "BT Studio", message: "Chúc hai bạn trăm năm hạnh phúc! 💕", attendance: "yes" as const, guestCount: 2 },
  { id: 2, guestName: "Ngọc Anh", message: "Mãi mãi yêu thương nhau nhé!", attendance: "unknown" as const, guestCount: 1 },
];

export function WeddingCardGuestSection({
  slug,
  compact,
  preview = false,
}: {
  slug: string;
  compact?: boolean;
  preview?: boolean;
}) {
  const { data: apiEntries = [] } = useWeddingCardGuestEntries(preview ? undefined : slug);
  const entries = preview ? DEMO_WISHES : apiEntries;
  const submit = useSubmitGuestEntry(slug);
  const [guestName, setGuestName] = useState("");
  const [message, setMessage] = useState("");
  const [attendance, setAttendance] = useState<"yes" | "no" | "unknown" | null>(null);
  const [guestCount, setGuestCount] = useState(1);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (preview) return;
    if (!guestName.trim()) { setError("Vui lòng nhập tên khách."); return; }
    if (!attendance) { setError("Vui lòng chọn trạng thái tham dự."); return; }
    setError(null);
    try {
      await submit.mutateAsync({ guestName: guestName || null, message: message || null, attendance, guestCount });
      setGuestName("");
      setMessage("");
      setAttendance(null);
      setGuestCount(1);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không gửi được. Vui lòng thử lại.");
    }
  };

  const inputClass = "wc-bt-input";

  return (
    <section className={compact ? "mt-4" : "mx-auto max-w-lg px-6 py-12"}>
      {preview && (
        <p className="text-center text-xs text-[var(--wc-bt-muted)] mb-4">2 lời chúc đã được gửi (mẫu)</p>
      )}
      {!compact && (
        <h2 className="font-serif text-xl text-center text-[var(--wc-bt-text)] mb-6">
          Lời chúc & xác nhận tham dự
        </h2>
      )}
      <form onSubmit={onSubmit} className="space-y-3 text-sm text-left">
        <input
          type="text"
          placeholder="Tên của bạn..."
          className={inputClass + " wc-bt-guest-pill"}
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          maxLength={120}
          required
        />
        <textarea
          placeholder="Gửi lời chúc yêu thương..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          className={inputClass + " resize-none"}
          maxLength={1000}
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
        {attendance !== "no" && <label className="flex items-center gap-2 text-[var(--wc-bt-muted)]">
          Số người
          <input
            type="number"
            min={1}
            max={20}
            value={guestCount}
            onChange={(e) => setGuestCount(Number(e.target.value) || 1)}
            className="w-16 wc-bt-input py-1"
          />
        </label>}
        {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
        {done && <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">Amazing Studio đã ghi nhận lời chúc và xác nhận của bạn.</p>}
        <button
          type="submit"
          disabled={submit.isPending || !guestName.trim() || !attendance}
          className="wc-bt-btn wc-bt-btn-primary w-full disabled:bg-[#eadde0] disabled:text-[#604f54] disabled:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#8f3f55]"
        >
          {submit.isPending ? "Đang gửi…" : done ? "Đã gửi!" : "Gửi"}
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
