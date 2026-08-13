import { ExternalLink, MapPin, Phone } from "lucide-react";
import { STUDIO_NAME, STUDIO_PHONE, STUDIO_PHONE_DISPLAY } from "@/lib/public-site-config";
import { getPublicSiteHomeUrl } from "@/lib/public-site-url";

export function WeddingCardBrandingFooter({ className = "" }: { className?: string }) {
  const websiteUrl = getPublicSiteHomeUrl();

  return (
    <footer
      className={`wc-bt-branding-footer ${className}`}
      aria-label="Thương hiệu Amazing Studio"
    >
      <a
        href={websiteUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="wc-bt-branding-logo-link"
        aria-label="Khám phá Amazing Studio"
      >
        <img
          src="/images/logo.png"
          alt="Amazing Studio Tây Ninh"
          className="wc-bt-branding-logo"
        />
      </a>

      <p className="wc-bt-branding-kicker">Đơn vị thực hiện hình ảnh & thiệp cưới</p>
      <p className="wc-bt-branding-name">{STUDIO_NAME}</p>
      <p className="wc-bt-branding-tagline">PHOTO • BRIDAL • MAKE UP</p>
      <p className="wc-bt-branding-services">
        Đồ cưới • Áo dài • Vest • Chụp cưới • Beauty • Gia đình
      </p>

      <address className="wc-bt-branding-contact">
        <p>
          <MapPin aria-hidden="true" />
          <span>Số 80 hẻm 71, CMT8, Phường Hiệp Ninh, Tây Ninh</span>
        </p>
        <a href={`tel:${STUDIO_PHONE}`} aria-label={`Gọi Amazing Studio ${STUDIO_PHONE_DISPLAY}`}>
          <Phone aria-hidden="true" />
          <span>{STUDIO_PHONE_DISPLAY}</span>
        </a>
      </address>

      <a
        href={websiteUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="wc-bt-branding-cta"
        aria-label="Khám phá website Amazing Studio"
      >
        <span>Khám phá Amazing Studio</span>
        <ExternalLink aria-hidden="true" />
      </a>
    </footer>
  );
}
