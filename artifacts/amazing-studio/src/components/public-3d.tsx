import { useRef } from "react";

/**
 * Bộ hiệu ứng 3D dùng chung cho website public:
 * - <Style3D/>           : keyframes + helper classes (nhúng 1 lần mỗi trang)
 * - <Tilt3D/>            : card nghiêng 3D theo chuột + bóng đổ đổi hướng (tắt trên cảm ứng)
 * - .pi-grid-item        : hiệu ứng xuất hiện 3D từ dưới lên (đặt animationDelay để stagger)
 * - .pi-shine            : lớp ánh sáng quét chéo khi hover card cha .pi-card3d
 */

export const STYLE_3D = `
@keyframes piFadeUp3d {
  0%   { opacity: 0; transform: perspective(900px) translateY(34px) rotateX(8deg) scale(.96); }
  100% { opacity: 1; transform: perspective(900px) translateY(0) rotateX(0deg) scale(1); }
}
@keyframes piFloat {
  0%, 100% { transform: translateY(0) rotateX(12deg) rotateY(-14deg); }
  50%      { transform: translateY(-10px) rotateX(18deg) rotateY(10deg); }
}
@keyframes piFloatSoft {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-14px); }
}
@keyframes piRing {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes piShine {
  0%   { transform: translateX(-130%) skewX(-18deg); }
  100% { transform: translateX(230%) skewX(-18deg); }
}
@keyframes piZoomIn {
  0%   { opacity: 0; transform: scale(.86) translateZ(0); }
  100% { opacity: 1; transform: scale(1) translateZ(0); }
}
@keyframes piGateIn {
  0%   { opacity: 0; transform: perspective(1000px) rotateX(14deg) translateY(40px); }
  100% { opacity: 1; transform: perspective(1000px) rotateX(0deg) translateY(0); }
}
.pi-grid-item { animation: piFadeUp3d .65s cubic-bezier(.22,.85,.35,1) both; }
.pi-lightbox-img { animation: piZoomIn .35s cubic-bezier(.22,.85,.35,1) both; }
.pi-gate-card { animation: piGateIn .7s cubic-bezier(.22,.85,.35,1) both; }
.pi-float-soft { animation: piFloatSoft 6s ease-in-out infinite; }
.pi-shine::after {
  content: ""; position: absolute; inset-block: -20%; width: 38%;
  left: 0; background: linear-gradient(105deg, transparent, rgba(255,255,255,.42), transparent);
  transform: translateX(-130%) skewX(-18deg); pointer-events: none;
}
.pi-card3d:hover .pi-shine::after { animation: piShine .9s ease; }
@media (prefers-reduced-motion: reduce) {
  .pi-grid-item, .pi-lightbox-img, .pi-gate-card, .pi-float-soft { animation: none; }
}
`;

/** Nhúng keyframes 3D — đặt 1 lần ở đầu trang. */
export function Style3D() {
  return <style>{STYLE_3D}</style>;
}

/** Card nghiêng 3D theo vị trí chuột — tự tắt trên thiết bị cảm ứng. */
export function Tilt3D({ children, className = "", onClick, onKeyDown, intensity = 9, role, tabIndex, style }: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  intensity?: number;
  role?: string;
  tabIndex?: number;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<number>(0);

  function handleMove(e: React.MouseEvent) {
    const el = ref.current;
    if (!el || window.matchMedia("(hover: none)").matches) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      el.style.transform =
        `perspective(900px) rotateX(${(-py * intensity).toFixed(2)}deg) rotateY(${(px * intensity).toFixed(2)}deg) translateZ(14px) scale(1.025)`;
      el.style.boxShadow =
        `${(-px * 22).toFixed(0)}px ${(18 - py * 10).toFixed(0)}px 42px -16px rgba(23,23,23,.35)`;
    });
  }
  function handleLeave() {
    const el = ref.current;
    if (!el) return;
    cancelAnimationFrame(frame.current);
    el.style.transform = "perspective(900px) rotateX(0deg) rotateY(0deg) translateZ(0) scale(1)";
    el.style.boxShadow = "0 10px 28px -18px rgba(23,23,23,.22)";
  }
  return (
    <div
      ref={ref}
      role={role}
      tabIndex={tabIndex}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`pi-card3d will-change-transform transition-[transform,box-shadow] duration-300 ease-out ${className}`}
      style={{
        transformStyle: "preserve-3d",
        boxShadow: "0 10px 28px -18px rgba(23,23,23,.22)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
