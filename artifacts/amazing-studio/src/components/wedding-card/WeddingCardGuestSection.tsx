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

  return (
    <section className={compact ? "p-4" : "mx-auto max-w-lg px-6 py-12 border-t border-neutral-200/60 bg-white/80"}>
      <h2
        className={
          compact
            ? "text-xs font-bold uppercase tracking-wider text-neutral-500 mb-3"
            : "font-serif text-xl text-center text-neutral-800 mb-6"
        }
      >
        {compact ? "Lời chúc & RSVP" : "Lời chúc & xác nhận tham dự"}
      </h2>
      <form onSubmit={onSubmit} className="space-y-3 text-sm">
        <input
          type="text"
          placeholder="Tên của bạn"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          className="w-full border border-neutral-200 rounded-lg px-3 py-2.5"
          maxLength={120}
        />
        <textarea
          placeholder="Lời chúc"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          className="w-full border border-neutral-200 rounded-lg px-3 py-2.5 resize-none"
          maxLength={2000}
        />
        <div className="flex flex-wrap gap-2">
          {(["yes", "no", "unknown"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setAttendance(v)}
              className={`px-3 py-1.5 rounded-full text-xs border ${
                attendance === v ? "bg-neutral-900 text-white border-neutral-900" : "border-neutral-300"
              }`}
            >
              {v === "yes" ? "Tham dự" : v === "no" ? "Không tham dự" : "Chưa rõ"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-neutral-600">
          Số người
          <input
            type="number"
            min={1}
            max={20}
            value={guestCount}
            onChange={(e) => setGuestCount(Number(e.target.value) || 1)}
            className="w-16 border border-neutral-200 rounded px-2 py-1"
          />
        </label>
        <button
          type="submit"
          disabled={submit.isPending}
          className="w-full py-3 rounded-lg bg-neutral-900 text-white text-sm font-medium disabled:opacity-60"
        >
          {submit.isPending ? "Đang gửi…" : done ? "Đã gửi!" : "Gửi lời chúc"}
        </button>
      </form>
      {entries.length > 0 && (
        <ul className={compact ? "mt-4 space-y-2 max-h-40 overflow-y-auto" : "mt-10 space-y-4"}>
          {entries.map((e) => (
            <li key={e.id} className="border-b border-neutral-100 pb-3">
              <p className="font-medium text-neutral-800">{e.guestName || "Khách"}</p>
              {e.message && <p className="text-neutral-600 text-sm mt-1">{e.message}</p>}
              {e.attendance !== "unknown" && (
                <p className="text-[10px] uppercase tracking-wider text-neutral-400 mt-1">
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
