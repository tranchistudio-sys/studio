import { useRef, useState } from "react";
import { Camera, Trash2, ImageUp } from "lucide-react";

// ─── Role → background gradient ──────────────────────────────────────────────
const ROLE_GRADIENT: Record<string, string> = {
  admin:        "from-violet-500 to-purple-600",
  photographer: "from-blue-500 to-indigo-600",
  photo:        "from-blue-500 to-indigo-600",
  makeup:       "from-pink-500 to-rose-600",
  sale:         "from-orange-400 to-amber-500",
  photoshop:    "from-teal-500 to-cyan-600",
  assistant:    "from-slate-400 to-gray-500",
  marketing:    "from-green-500 to-emerald-600",
};

// ─── Staff status → dot color ─────────────────────────────────────────────────
const STATUS_DOT: Record<string, string> = {
  active:    "bg-emerald-500 ring-emerald-200",
  probation: "bg-amber-400 ring-amber-200",
  inactive:  "bg-red-500 ring-red-200",
};

// ─── Image compression: center-crop to square, resize to 200px ───────────────
export function compressStaffAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const SIZE = 200;
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        canvas.getContext("2d")?.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface StaffAvatarProps {
  name: string;
  avatar?: string | null;
  role?: string;
  status?: string;
  isActive?: boolean;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
  editable?: boolean;
  onUpload?: (base64: string) => void;
  onDelete?: () => void;
  uploading?: boolean;
}

// ─── Size map ─────────────────────────────────────────────────────────────────
const SIZE_MAP = {
  xs:  { outer: "w-7 h-7",    initials: "text-[11px]", dot: "w-2 h-2 bottom-0 right-0",         cam: 12 },
  sm:  { outer: "w-9 h-9",    initials: "text-xs",      dot: "w-2 h-2 bottom-0 right-0",         cam: 14 },
  md:  { outer: "w-14 h-14",  initials: "text-base",    dot: "w-2.5 h-2.5 bottom-0 right-0",     cam: 16 },
  lg:  { outer: "w-20 h-20",  initials: "text-2xl",     dot: "w-3 h-3 bottom-0.5 right-0.5",     cam: 18 },
  xl:  { outer: "w-28 h-28",  initials: "text-3xl",     dot: "w-4 h-4 bottom-1 right-1",         cam: 22 },
  "2xl": { outer: "w-36 h-36", initials: "text-4xl",   dot: "w-4.5 h-4.5 bottom-1.5 right-1.5", cam: 26 },
};

export default function StaffAvatar({
  name, avatar, role = "assistant", status, isActive, size = "md",
  editable = false, onUpload, onDelete, uploading = false,
}: StaffAvatarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imgError, setImgError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const { outer, initials, dot, cam } = SIZE_MAP[size];

  // Derive status dot key
  const dotKey = status || (isActive === false ? "inactive" : isActive === true ? "active" : "active");
  const dotClass = STATUS_DOT[dotKey] || STATUS_DOT.active;

  // Role gradient
  const gradient = ROLE_GRADIENT[role] || ROLE_GRADIENT.assistant;

  // Initials
  const initial = (name || "?").trim().charAt(0).toUpperCase();

  // Show image?
  const showImage = avatar && !imgError;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const compressed = await compressStaffAvatar(file);
    onUpload?.(compressed);
    setImgError(false);
    setMenuOpen(false);
  };

  return (
    <div className="relative inline-block">
      {/* Main circle */}
      <div
        className={`
          ${outer} rounded-full overflow-hidden flex-shrink-0 relative
          ring-2 ring-primary/30 shadow-md
          ${editable ? "cursor-pointer select-none" : ""}
        `}
        onClick={editable ? () => setMenuOpen(v => !v) : undefined}
      >
        {showImage ? (
          <img
            src={avatar!}
            alt={name}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${gradient} flex items-center justify-center`}>
            <span className={`${initials} font-bold text-white leading-none select-none`}>{initial}</span>
          </div>
        )}

        {/* Uploading overlay */}
        {uploading && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Editable hover overlay */}
        {editable && !uploading && (
          <div className="absolute inset-0 bg-black/0 hover:bg-black/25 transition-colors flex items-center justify-center group">
            <Camera size={cam} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        )}
      </div>

      {/* Status dot */}
      <span
        className={`
          absolute ${dot} rounded-full ring-2 ring-white ${dotClass}
          transition-transform
        `}
      />

      {/* Upload/Delete menu */}
      {editable && menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="absolute left-full ml-2 top-0 z-50 bg-popover border border-border rounded-xl shadow-lg p-1 min-w-[140px] animate-in fade-in-0 zoom-in-95 duration-100">
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg hover:bg-muted transition-colors"
              onClick={() => { fileInputRef.current?.click(); }}
            >
              <ImageUp size={14} className="text-primary" />
              {avatar ? "Đổi ảnh" : "Tải ảnh lên"}
            </button>
            {avatar && (
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg hover:bg-red-50 text-red-600 transition-colors"
                onClick={() => { onDelete?.(); setMenuOpen(false); }}
              >
                <Trash2 size={14} />
                Xóa ảnh
              </button>
            )}
          </div>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
