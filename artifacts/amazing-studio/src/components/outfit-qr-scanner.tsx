import { useEffect, useRef, useState } from "react";
import { X, Camera, Keyboard, AlertTriangle } from "lucide-react";

type Props = {
  onClose: () => void;
  onScan: (code: string) => void;
  onCameraFail?: (reason: string) => void;
};

type DetectorLike = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => DetectorLike;
  }
}

export default function OutfitQrScanner({ onClose, onScan, onCameraFail }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<DetectorLike | null>(null);
  const cancelledRef = useRef(false);
  const lastScanRef = useRef<{ code: string; ts: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (manualMode) return;

    const hasDetector = typeof window !== "undefined" && !!window.BarcodeDetector;
    if (!hasDetector) {
      if (onCameraFail) { onCameraFail("Trình duyệt không hỗ trợ quét QR"); return; }
      setError("Trình duyệt không hỗ trợ quét QR. Nhập mã thủ công bên dưới.");
      setManualMode(true);
      return;
    }
    if (!navigator?.mediaDevices?.getUserMedia) {
      if (onCameraFail) { onCameraFail("Không truy cập được camera"); return; }
      setError("Không truy cập được camera. Nhập mã thủ công.");
      setManualMode(true);
      return;
    }

    let stopped = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelledRef.current || stopped) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play().catch(() => {});

        try {
          detectorRef.current = new window.BarcodeDetector!({
            formats: ["qr_code", "code_128", "code_39", "ean_13"],
          });
        } catch {
          detectorRef.current = new window.BarcodeDetector!();
        }

        setScanning(true);

        const tick = async () => {
          if (cancelledRef.current || !detectorRef.current || !videoRef.current) return;
          try {
            const codes = await detectorRef.current.detect(videoRef.current);
            if (codes && codes.length > 0) {
              const raw = (codes[0].rawValue || "").trim();
              if (raw) {
                const now = Date.now();
                const last = lastScanRef.current;
                if (!last || last.code !== raw || now - last.ts > 1500) {
                  lastScanRef.current = { code: raw, ts: now };
                  onScan(raw);
                }
              }
            }
          } catch {
            // ignore frame errors
          }
          rafRef.current = window.setTimeout(() => {
            rafRef.current = requestAnimationFrame(tick);
          }, 150) as unknown as number;
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e: any) {
        if (onCameraFail) { onCameraFail(e?.message || "Không mở được camera"); return; }
        setError(e?.message || "Không mở được camera.");
        setManualMode(true);
      }
    })();

    return () => {
      stopped = true;
      cancelledRef.current = true;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        clearTimeout(rafRef.current);
        rafRef.current = null;
      }
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      setScanning(false);
    };
  }, [manualMode, onScan]);

  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    const v = manualCode.trim();
    if (v) onScan(v);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-background rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Camera className="w-4 h-4" /> Quét mã trang phục
          </div>
          <button type="button" onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!manualMode ? (
          <div className="relative aspect-square bg-black">
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div className="w-2/3 h-2/3 border-2 border-white/70 rounded-lg" />
            </div>
            {!scanning && !error && (
              <div className="absolute inset-0 flex items-center justify-center text-white/80 text-xs">
                Đang khởi động camera...
              </div>
            )}
          </div>
        ) : null}

        <div className="p-3 space-y-2">
          {error && (
            <div className="text-[11px] text-destructive flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {manualMode ? (
            <form onSubmit={submitManual} className="flex gap-2">
              <input
                autoFocus
                value={manualCode}
                onChange={e => setManualCode(e.target.value)}
                placeholder="Nhập mã trang phục..."
                className="flex-1 h-9 px-3 rounded-lg border border-input bg-background text-sm font-mono"
              />
              <button
                type="submit"
                className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium"
              >
                Chọn
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setManualMode(true)}
              className="w-full text-xs text-muted-foreground hover:text-foreground flex items-center justify-center gap-1.5 py-1"
            >
              <Keyboard className="w-3.5 h-3.5" /> Nhập mã thủ công
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
