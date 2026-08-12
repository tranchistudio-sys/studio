import { useState } from "react";
import { cn } from "@/lib/utils";
import { WeddingCardMediaManager } from "./WeddingCardMediaManager";
import type { WeddingMediaItem, WeddingMediaRole } from "@/lib/wedding-card-media";

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
          <WeddingCardMediaManager items={mediaItems} onPick={onPickMedia} onRole={onMediaRole} onSwap={onSwapCovers} onRemove={onRemoveMedia} onRetry={onRetryMedia} onMove={onMoveMedia} />
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
            <label className="text-xs text-[var(--wc-bt-muted)]">Email nhận lời chúc và xác nhận</label>
            <input type="email" className="wc-bt-input mt-1" value={form.notificationEmail} onChange={(e) => setters.setNotificationEmail(e.target.value)} placeholder="tenban@example.com" />
            <p className="mt-1 text-[11px] text-[var(--wc-bt-muted)]">Lời chúc và xác nhận tham dự của khách sẽ được gửi về email này. Email không hiển thị công khai.</p>
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
