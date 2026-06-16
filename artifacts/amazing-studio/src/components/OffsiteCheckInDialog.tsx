import { useRef, useState } from "react";
import { Camera, Loader2, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui";

type Props = {
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onConfirm: (data: { file: File; notes: string }) => void;
};

export function OffsiteCheckInDialog({ open, saving, onClose, onConfirm }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  if (!open) return null;

  const pickPhoto = (f: File | null) => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full max-w-md bg-background rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <span className="font-semibold text-sm flex items-center gap-2">
            <MapPin className="w-4 h-4 text-amber-600" /> Đi Show ngoài
          </span>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-muted" disabled={saving}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">
          <p className="text-xs text-muted-foreground">
            Dùng khi làm việc ngoài studio (chụp, trang điểm, giao đồ, gặp khách…). Chụp selfie → lấy GPS → đăng ký.
          </p>

          <div>
            <p className="text-xs font-semibold mb-2">1. Selfie xác thực <span className="text-red-500">*</span></p>
            {preview ? (
              <div className="relative rounded-xl overflow-hidden border bg-muted/30">
                <img src={preview} alt="Selfie" className="w-full max-h-48 object-cover" />
                <button
                  type="button"
                  className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded"
                  onClick={() => pickPhoto(null)}
                  disabled={saving}
                >
                  Chụp lại
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={saving}
                className="w-full flex flex-col items-center gap-2 py-8 rounded-xl border-2 border-dashed border-amber-300 bg-amber-50/50 hover:bg-amber-50"
              >
                <Camera className="w-8 h-8 text-amber-700" />
                <span className="text-sm font-medium text-amber-900">Chụp / chọn ảnh selfie</span>
              </button>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="user"
              className="hidden"
              onChange={e => pickPhoto(e.target.files?.[0] ?? null)}
            />
          </div>

          <div>
            <p className="text-xs font-semibold mb-1">2. Ghi chú công việc</p>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              disabled={saving}
              placeholder="VD: Chụp cổng tại nhà khách A, giao váy..."
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm resize-none"
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Bước tiếp theo: hệ thống lấy GPS hiện tại và lưu vị trí + ảnh.
          </p>
        </div>
        <div className="p-4 border-t flex gap-2 shrink-0">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>Hủy</Button>
          <Button
            className="flex-1"
            disabled={!file || saving}
            onClick={() => file && onConfirm({ file, notes: notes.trim() })}
          >
            {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-1" /> Đang đăng ký…</> : "Xác nhận & lấy GPS"}
          </Button>
        </div>
      </div>
    </div>
  );
}
