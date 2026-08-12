import { WeddingCardMediaManager } from "./WeddingCardMediaManager";
import type { WeddingMediaItem, WeddingMediaRole } from "@/lib/wedding-card-media";

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
  notificationEmail: string;
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
  setNotificationEmail: (v: string) => void;
};

export function WeddingCardEditorPanel({
  form,
  setters,
  mediaItems, onPickMedia, onMediaRole, onSwapCovers, onRemoveMedia, onRetryMedia, onMoveMedia,
}: {
  form: EditorFormState;
  setters: Setters;
  mediaItems: WeddingMediaItem[];
  onPickMedia: (files: File[]) => void;
  onMediaRole: (id: string, role: WeddingMediaRole) => void;
  onSwapCovers: () => void;
  onRemoveMedia: (id: string) => void;
  onRetryMedia: (id: string) => void;
  onMoveMedia: (id: string, direction: -1 | 1) => void;
}) {
  return (
    <div className="space-y-6">
        <section className="space-y-3 wc-fade-in" aria-labelledby="wc-editor-photos">
          <div className="flex items-center gap-3 px-1">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#8f3652] text-sm font-bold text-white">1</span>
            <h2 id="wc-editor-photos" className="text-lg font-semibold text-[var(--wc-bt-text)]">Ảnh cưới</h2>
          </div>
          <WeddingCardMediaManager items={mediaItems} onPick={onPickMedia} onRole={onMediaRole} onSwap={onSwapCovers} onRemove={onRemoveMedia} onRetry={onRetryMedia} onMove={onMoveMedia} />
        </section>

        <section className="space-y-3 wc-fade-in" aria-labelledby="wc-editor-info">
          <div className="flex items-center gap-3 px-1">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#8f3652] text-sm font-bold text-white">2</span>
            <h2 id="wc-editor-info" className="text-lg font-semibold text-[var(--wc-bt-text)]">Thông tin cô dâu chú rể</h2>
          </div>
        <div className="space-y-3 rounded-xl bg-white border border-[var(--wc-bt-border,#e8e0d8)] p-4">
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
            <label className="text-xs text-[var(--wc-bt-muted)]">Email cô dâu/chú rể nhận lời chúc *</label>
            <input type="email" required className="wc-bt-input mt-1" value={form.notificationEmail} onChange={(e) => setters.setNotificationEmail(e.target.value)} placeholder="tenban@example.com" />
            <p className="mt-1 text-[11px] text-[var(--wc-bt-muted)]">Khách gửi lời chúc sẽ chuyển thẳng về email này. Email không hiển thị công khai và nội dung lời chúc không được lưu tại Amazing Studio.</p>
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
        </section>

        <section className="space-y-3 wc-fade-in" aria-labelledby="wc-editor-venue">
          <div className="flex items-center gap-3 px-1">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#8f3652] text-sm font-bold text-white">3</span>
            <h2 id="wc-editor-venue" className="text-lg font-semibold text-[var(--wc-bt-text)]">Địa điểm tổ chức</h2>
          </div>
        <div className="space-y-3 rounded-xl bg-white border border-[var(--wc-bt-border,#e8e0d8)] p-4">
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
        </section>

        <section className="space-y-3 wc-fade-in" aria-labelledby="wc-editor-message">
          <div className="flex items-center gap-3 px-1">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#8f3652] text-sm font-bold text-white">4</span>
            <h2 id="wc-editor-message" className="text-lg font-semibold text-[var(--wc-bt-text)]">Lời mời</h2>
          </div>
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
        </section>
    </div>
  );
}
