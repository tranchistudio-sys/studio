import { useState } from "react";
import { getImageSrc } from "@/lib/imageUtils";
import { WeddingCardImageUploader } from "./WeddingCardImageUploader";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "photos", label: "Ảnh" },
  { key: "info", label: "Thông tin" },
  { key: "venue", label: "Địa điểm" },
  { key: "message", label: "Lời mời" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export interface EditorFormState {
  groomName: string;
  brideName: string;
  weddingDate: string;
  ceremonyTime: string;
  receptionTime: string;
  venueGroom: string;
  venueBride: string;
  venueReception: string;
  mapsUrlGroom: string;
  mapsUrlBride: string;
  mapsUrlReception: string;
  invitationMessage: string;
  contactPhone: string;
  coverImageUrl: string | null;
  coupleImageUrl: string | null;
}

type Setters = {
  setGroomName: (v: string) => void;
  setBrideName: (v: string) => void;
  setWeddingDate: (v: string) => void;
  setCeremonyTime: (v: string) => void;
  setReceptionTime: (v: string) => void;
  setVenueGroom: (v: string) => void;
  setVenueBride: (v: string) => void;
  setVenueReception: (v: string) => void;
  setMapsUrlGroom: (v: string) => void;
  setMapsUrlBride: (v: string) => void;
  setMapsUrlReception: (v: string) => void;
  setInvitationMessage: (v: string) => void;
  setContactPhone: (v: string) => void;
};

export function WeddingCardEditorPanel({
  form,
  setters,
  uploading,
  onUpload,
  onClearCover,
  onClearCouple,
  albumImageUrls = [],
  onUploadAlbum,
  onRemoveAlbum,
  uploadingAlbum = false,
}: {
  form: EditorFormState;
  setters: Setters;
  uploading: "cover" | "couple" | "extra" | null;
  onUpload: (file: File, kind: "cover" | "couple" | "extra") => void;
  onClearCover: () => void;
  onClearCouple: () => void;
  albumImageUrls?: string[];
  onUploadAlbum?: (file: File) => void;
  onRemoveAlbum?: (index: number) => void;
  uploadingAlbum?: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("photos");

  return (
    <div className="space-y-3">
      <div className="wc-bt-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={cn("wc-bt-tab", tab === t.key && "is-active")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "photos" && (
        <div className="space-y-4 wc-fade-in">
          <div className="rounded-xl bg-white border border-[var(--wc-bt-border,#e8e0d8)] p-4">
            <p className="text-sm font-semibold text-[var(--wc-bt-text)]">Ảnh cưới của bạn</p>
            <p className="text-xs text-[var(--wc-bt-muted)] mt-1 mb-3">
              Tải ảnh lên — thiệp bên cạnh đổi ngay. Nên có ảnh bìa và ảnh cặp đôi.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <WeddingCardImageUploader
                slot="cover"
                label="Ảnh bìa"
                hint="Ảnh nền đầu thiệp"
                tall
                imageUrl={form.coverImageUrl}
                uploading={uploading === "cover"}
                onPick={(f) => onUpload(f, "cover")}
                onClear={onClearCover}
              />
              <WeddingCardImageUploader
                slot="couple"
                label="Ảnh cặp đôi"
                hint="Cô dâu & chú rể"
                tall
                imageUrl={form.coupleImageUrl}
                uploading={uploading === "couple"}
                onPick={(f) => onUpload(f, "couple")}
                onClear={onClearCouple}
              />
            </div>
            {onUploadAlbum && (
              <div className="mt-3">
                <WeddingCardImageUploader
                  slot="extra"
                  label="Album phụ"
                  hint="Thêm ảnh kỷ niệm"
                  imageUrl={null}
                  uploading={uploadingAlbum}
                  onPick={onUploadAlbum}
                />
                {albumImageUrls.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {albumImageUrls.map((url, i) => {
                      const src = getImageSrc(url);
                      if (!src) return null;
                      return (
                        <div key={`${url}-${i}`} className="relative h-16 w-16 rounded-lg overflow-hidden">
                          <img src={src} alt="" className="h-full w-full object-cover" />
                          {onRemoveAlbum && (
                            <button
                              type="button"
                              onClick={() => onRemoveAlbum(i)}
                              className="absolute top-0.5 right-0.5 rounded-full bg-black/55 p-0.5 text-white"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "info" && (
        <div className="space-y-3 wc-fade-in rounded-xl bg-white border border-[var(--wc-bt-border,#e8e0d8)] p-4">
          <div>
            <label className="text-xs text-[var(--wc-bt-muted)]">Tên chú rể *</label>
            <input
              className="wc-bt-input mt-1"
              value={form.groomName}
              onChange={(e) => setters.setGroomName(e.target.value)}
              placeholder="VD: Nguyễn Văn A"
            />
          </div>
          <div>
            <label className="text-xs text-[var(--wc-bt-muted)]">Tên cô dâu *</label>
            <input
              className="wc-bt-input mt-1"
              value={form.brideName}
              onChange={(e) => setters.setBrideName(e.target.value)}
              placeholder="VD: Trần Thị B"
            />
          </div>
          <div>
            <label className="text-xs text-[var(--wc-bt-muted)]">Số điện thoại liên hệ</label>
            <input
              className="wc-bt-input mt-1"
              value={form.contactPhone}
              onChange={(e) => setters.setContactPhone(e.target.value)}
              placeholder="Gọi cho cô dâu chú rể"
            />
          </div>
          <div>
            <label className="text-xs text-[var(--wc-bt-muted)]">Ngày cưới</label>
            <input
              type="date"
              className="wc-bt-input mt-1"
              value={form.weddingDate}
              onChange={(e) => setters.setWeddingDate(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[var(--wc-bt-muted)]">Giờ lễ</label>
              <input
                className="wc-bt-input mt-1"
                value={form.ceremonyTime}
                onChange={(e) => setters.setCeremonyTime(e.target.value)}
                placeholder="09:00"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--wc-bt-muted)]">Giờ tiệc</label>
              <input
                className="wc-bt-input mt-1"
                value={form.receptionTime}
                onChange={(e) => setters.setReceptionTime(e.target.value)}
                placeholder="17:00"
              />
            </div>
          </div>
        </div>
      )}

      {tab === "venue" && (
        <div className="space-y-3 wc-fade-in rounded-xl bg-white border border-[var(--wc-bt-border,#e8e0d8)] p-4">
          <div>
            <label className="text-xs text-[var(--wc-bt-muted)]">Nhà trai</label>
            <input
              className="wc-bt-input mt-1"
              placeholder="Địa chỉ nhà trai"
              value={form.venueGroom}
              onChange={(e) => setters.setVenueGroom(e.target.value)}
            />
          </div>
          <input
            className="wc-bt-input"
            placeholder="Link Google Maps (tùy chọn)"
            value={form.mapsUrlGroom}
            onChange={(e) => setters.setMapsUrlGroom(e.target.value)}
          />
          <div>
            <label className="text-xs text-[var(--wc-bt-muted)]">Nhà gái</label>
            <input
              className="wc-bt-input mt-1"
              placeholder="Địa chỉ nhà gái"
              value={form.venueBride}
              onChange={(e) => setters.setVenueBride(e.target.value)}
            />
          </div>
          <input
            className="wc-bt-input"
            placeholder="Link Maps nhà gái"
            value={form.mapsUrlBride}
            onChange={(e) => setters.setMapsUrlBride(e.target.value)}
          />
          <div>
            <label className="text-xs text-[var(--wc-bt-muted)]">Địa điểm tiệc cưới</label>
            <input
              className="wc-bt-input mt-1"
              placeholder="Nhà hàng / sảnh tiệc"
              value={form.venueReception}
              onChange={(e) => setters.setVenueReception(e.target.value)}
            />
          </div>
          <input
            className="wc-bt-input"
            placeholder="Link Maps tiệc"
            value={form.mapsUrlReception}
            onChange={(e) => setters.setMapsUrlReception(e.target.value)}
          />
        </div>
      )}

      {tab === "message" && (
        <div className="wc-fade-in rounded-xl bg-white border border-[var(--wc-bt-border,#e8e0d8)] p-4">
          <label className="text-xs text-[var(--wc-bt-muted)]">Lời mời</label>
          <textarea
            className="wc-bt-input mt-1 resize-none min-h-[120px]"
            rows={5}
            placeholder="Lời mời trân trọng gửi tới quý khách…"
            value={form.invitationMessage}
            onChange={(e) => setters.setInvitationMessage(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
