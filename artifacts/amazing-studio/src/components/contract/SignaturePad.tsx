/**
 * SignaturePad — ô ký tên vẽ tay (chuột / cảm ứng / bút) trên canvas.
 * KHÔNG gọi API: đã có chữ ký (value) thì hiển thị ảnh; chưa có thì cho vẽ,
 * bấm "Xác nhận chữ ký" → trả PNG data URL qua onConfirm cho trang cha xử lý.
 * Logic canvas port từ trang ký HTML cũ của backend (pointer events + DPR scaling).
 */
import { useEffect, useRef, useState } from "react";

type SignaturePadProps = {
  /** Chữ ký đã lưu (PNG data URL hoặc URL ảnh). Có giá trị → chỉ hiển thị, không cho vẽ. */
  value: string | null;
  /** Bấm "Xác nhận chữ ký" với canvas có nét vẽ → nhận PNG data URL. */
  onConfirm: (dataUrl: string) => void;
  /** Khóa toàn bộ thao tác (đang gửi, không có quyền ký...). */
  disabled?: boolean;
  /** Nhãn bên trên ô ký, vd "BÊN A – AMAZING STUDIO". */
  label: string;
  /** Dòng phụ dưới nhãn (tên/SĐT người ký hoặc ngày ký). */
  signerLine?: string | null;
  /** Đang chờ xác nhận (hiện spinner text trên nút). */
  confirming?: boolean;
};

const CANVAS_HEIGHT = 150;

export default function SignaturePad({
  value,
  onConfirm,
  disabled = false,
  label,
  signerLine,
  confirming = false,
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<[number, number] | null>(null);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resize canvas theo container + devicePixelRatio để nét ký sắc trên màn retina.
  useEffect(() => {
    if (value) return; // đang hiển thị ảnh, không có canvas
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const r = c.getBoundingClientRect();
      if (r.width === 0) return;
      c.width = r.width * devicePixelRatio;
      c.height = CANVAS_HEIGHT * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
      setHasStrokes(false);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [value]);

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    drawingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    lastRef.current = getPos(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || disabled) return;
    const c = e.currentTarget;
    const ctx = c.getContext("2d");
    if (!ctx || !lastRef.current) return;
    const p = getPos(e);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a1a2e";
    ctx.beginPath();
    ctx.moveTo(lastRef.current[0], lastRef.current[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    lastRef.current = p;
    if (!hasStrokes) setHasStrokes(true);
    if (error) setError(null);
  };

  const handlePointerUp = () => {
    drawingRef.current = false;
    lastRef.current = null;
  };

  const handleClear = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    setHasStrokes(false);
    setError(null);
  };

  const handleConfirm = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const empty = ctx.getImageData(0, 0, c.width, c.height).data.every((v) => v === 0);
    if (empty) {
      setError("Vui lòng ký tên vào ô trước khi xác nhận.");
      return;
    }
    onConfirm(c.toDataURL("image/png"));
  };

  return (
    <div className="rounded-xl border border-dashed border-muted-foreground/40 p-3 text-center">
      <div className="text-sm font-bold">{label}</div>
      {signerLine ? <div className="text-xs text-muted-foreground mt-0.5">{signerLine}</div> : null}

      {value ? (
        // Đã có chữ ký → hiển thị ảnh đã lưu
        <img
          src={value}
          alt={`Chữ ký ${label}`}
          className="mx-auto mt-3 max-h-[120px] max-w-full object-contain rounded-lg bg-white p-1.5 border"
        />
      ) : (
        <>
          <canvas
            ref={canvasRef}
            className="mt-3 w-full rounded-lg bg-white border cursor-crosshair"
            style={{ height: CANVAS_HEIGHT, touchAction: "none" }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
          />
          <div className="text-[11px] text-muted-foreground mt-1.5">
            Dùng ngón tay, bút hoặc chuột để ký vào ô trên
          </div>
          {error ? <div className="text-xs font-semibold text-destructive mt-1.5">{error}</div> : null}
          <div className="mt-3 flex gap-2 justify-center print:hidden">
            <button
              type="button"
              onClick={handleClear}
              disabled={disabled}
              className="rounded-lg px-4 py-2 text-sm font-bold bg-muted text-muted-foreground hover:opacity-85 disabled:opacity-50"
            >
              Xóa ký lại
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={disabled || confirming}
              className="rounded-lg px-4 py-2 text-sm font-bold bg-primary text-primary-foreground hover:opacity-85 disabled:opacity-50"
            >
              {confirming ? "Đang lưu..." : "✅ Xác nhận chữ ký"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
