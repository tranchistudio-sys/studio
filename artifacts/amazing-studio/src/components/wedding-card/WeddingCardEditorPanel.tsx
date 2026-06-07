import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { getImageSrc } from "@/lib/imageUtils";
import { WeddingCardImageUploader } from "./WeddingCardImageUploader";
import { X } from "lucide-react";

const inputClass =
  "w-full border border-neutral-200 rounded-lg px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-rose-200 focus:border-rose-300";

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
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-gradient-to-br from-rose-50 to-amber-50/80 border border-rose-100 p-4">
        <p className="text-sm font-semibold text-neutral-900">Ảnh cưới của bạn</p>
        <p className="text-xs text-neutral-600 mt-1 mb-3">
          Tải ảnh lên — thiệp bên phải đổi ngay. Nên có ảnh bìa và ảnh cặp đôi.
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
              hint="Thêm ảnh kỷ niệm — xem ngay dưới preview"
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

      <Accordion
        type="single"
        collapsible
        defaultValue="couple"
        className="wc-accordion bg-white rounded-xl border border-neutral-200/80 px-1 shadow-sm"
      >
        <AccordionItem value="couple" className="px-3 border-neutral-100">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline py-3.5 min-h-[48px]">
            Thông tin cô dâu chú rể
          </AccordionTrigger>
          <AccordionContent className="wc-acc-content space-y-3 pb-4">
            <div>
              <label className="text-xs text-neutral-500">Tên chú rể *</label>
              <input
                className={inputClass + " mt-1"}
                value={form.groomName}
                onChange={(e) => setters.setGroomName(e.target.value)}
                placeholder="VD: Nguyễn Văn A"
              />
            </div>
            <div>
              <label className="text-xs text-neutral-500">Tên cô dâu *</label>
              <input
                className={inputClass + " mt-1"}
                value={form.brideName}
                onChange={(e) => setters.setBrideName(e.target.value)}
                placeholder="VD: Trần Thị B"
              />
            </div>
            <div>
              <label className="text-xs text-neutral-500">Số điện thoại liên hệ</label>
              <input
                className={inputClass + " mt-1"}
                value={form.contactPhone}
                onChange={(e) => setters.setContactPhone(e.target.value)}
                placeholder="Gọi cho cô dâu chú rể"
              />
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="datetime" className="px-3 border-neutral-100">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline py-3.5 min-h-[48px]">
            Ngày giờ
          </AccordionTrigger>
          <AccordionContent className="wc-acc-content space-y-3 pb-4">
            <div>
              <label className="text-xs text-neutral-500">Ngày cưới</label>
              <input
                type="date"
                className={inputClass + " mt-1"}
                value={form.weddingDate}
                onChange={(e) => setters.setWeddingDate(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-neutral-500">Giờ lễ</label>
                <input
                  className={inputClass + " mt-1"}
                  value={form.ceremonyTime}
                  onChange={(e) => setters.setCeremonyTime(e.target.value)}
                  placeholder="09:00"
                />
              </div>
              <div>
                <label className="text-xs text-neutral-500">Giờ tiệc</label>
                <input
                  className={inputClass + " mt-1"}
                  value={form.receptionTime}
                  onChange={(e) => setters.setReceptionTime(e.target.value)}
                  placeholder="17:00"
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="venue" className="px-3 border-neutral-100">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline py-3.5 min-h-[48px]">
            Địa điểm
          </AccordionTrigger>
          <AccordionContent className="wc-acc-content space-y-3 pb-4">
            <input
              className={inputClass}
              placeholder="Nhà trai"
              value={form.venueGroom}
              onChange={(e) => setters.setVenueGroom(e.target.value)}
            />
            <input
              className={inputClass}
              placeholder="Link Google Maps (tùy chọn)"
              value={form.mapsUrlGroom}
              onChange={(e) => setters.setMapsUrlGroom(e.target.value)}
            />
            <input
              className={inputClass}
              placeholder="Nhà gái"
              value={form.venueBride}
              onChange={(e) => setters.setVenueBride(e.target.value)}
            />
            <input
              className={inputClass}
              placeholder="Link Maps nhà gái"
              value={form.mapsUrlBride}
              onChange={(e) => setters.setMapsUrlBride(e.target.value)}
            />
            <input
              className={inputClass}
              placeholder="Địa điểm tiệc cưới"
              value={form.venueReception}
              onChange={(e) => setters.setVenueReception(e.target.value)}
            />
            <input
              className={inputClass}
              placeholder="Link Maps tiệc"
              value={form.mapsUrlReception}
              onChange={(e) => setters.setMapsUrlReception(e.target.value)}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="photos" className="px-3 border-neutral-100">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline py-3.5 min-h-[48px]">
            Hình ảnh
          </AccordionTrigger>
          <AccordionContent className="wc-acc-content space-y-3 pb-4">
            <WeddingCardImageUploader
              slot="cover"
              label="Ảnh bìa chính"
              imageUrl={form.coverImageUrl}
              uploading={uploading === "cover"}
              onPick={(f) => onUpload(f, "cover")}
              onClear={onClearCover}
              tall
            />
            <WeddingCardImageUploader
              slot="couple"
              label="Ảnh cặp đôi"
              imageUrl={form.coupleImageUrl}
              uploading={uploading === "couple"}
              onPick={(f) => onUpload(f, "couple")}
              onClear={onClearCouple}
              tall
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="message" className="px-3 border-neutral-100">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline py-3.5 min-h-[48px]">
            Lời mời
          </AccordionTrigger>
          <AccordionContent className="wc-acc-content pb-4">
            <textarea
              className={inputClass + " resize-none min-h-[100px]"}
              rows={4}
              placeholder="Lời mời trân trọng gửi tới quý khách…"
              value={form.invitationMessage}
              onChange={(e) => setters.setInvitationMessage(e.target.value)}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
