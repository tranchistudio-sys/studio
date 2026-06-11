import { useEffect, useState } from "react";

const PETALS = [
  { left: "8%", delay: "0s", dur: "14s", char: "♥", size: 12 },
  { left: "22%", delay: "2s", dur: "16s", char: "✿", size: 11 },
  { left: "38%", delay: "4s", dur: "13s", char: "♥", size: 10 },
  { left: "55%", delay: "1s", dur: "15s", char: "❀", size: 13 },
  { left: "72%", delay: "3s", dur: "17s", char: "♥", size: 11 },
  { left: "88%", delay: "5s", dur: "14s", char: "✿", size: 10 },
] as const;

export function WeddingCardPetals() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setShow(!reduced);
  }, []);

  if (!show) return null;

  return (
    <div className="wc-petals" aria-hidden>
      {PETALS.map((p, i) => (
        <span
          key={i}
          className="wc-petal text-rose-300/70"
          style={{
            left: p.left,
            animationDelay: p.delay,
            animationDuration: p.dur,
            fontSize: p.size,
          }}
        >
          {p.char}
        </span>
      ))}
    </div>
  );
}
