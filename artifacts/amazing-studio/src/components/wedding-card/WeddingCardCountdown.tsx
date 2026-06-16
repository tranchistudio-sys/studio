import { useEffect, useState } from "react";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function targetMs(date: string | null, time: string | null): number | null {
  if (!date) return null;
  const t = (time || "09:00").match(/^(\d{1,2}):(\d{2})/);
  const h = t ? Number(t[1]) : 9;
  const m = t ? Number(t[2]) : 0;
  const d = new Date(date + "T" + pad(h) + ":" + pad(m) + ":00");
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function WeddingCardCountdown({
  weddingDate,
  ceremonyTime,
}: {
  weddingDate: string | null;
  ceremonyTime: string | null;
}) {
  const target = targetMs(weddingDate, ceremonyTime);
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!target) return;
    const tick = () => setLeft(Math.max(0, target - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);

  if (!target || left === null) return null;

  const days = Math.floor(left / 86400000);
  const hours = Math.floor((left % 86400000) / 3600000);
  const mins = Math.floor((left % 3600000) / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  const done = left <= 0;

  return (
    <section className="wc-bt-view-section wc-bt-countdown" id="wc-section-countdown">
      <p className="wc-bt-section-eyebrow">Đếm ngược</p>
      <h2 className="wc-bt-section-title">{done ? "Hôm nay là ngày trọng đại!" : "Còn lại"}</h2>
      {!done && (
        <div className="wc-bt-countdown-grid">
          {[
            { v: days, l: "Ngày" },
            { v: hours, l: "Giờ" },
            { v: mins, l: "Phút" },
            { v: secs, l: "Giây" },
          ].map(({ v, l }) => (
            <div key={l} className="wc-bt-countdown-cell">
              <span className="wc-bt-countdown-num">{pad(v)}</span>
              <span className="wc-bt-countdown-label">{l}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
