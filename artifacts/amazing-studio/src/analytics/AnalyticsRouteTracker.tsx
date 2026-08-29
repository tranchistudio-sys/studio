import { useEffect } from "react";
import { useLocation } from "wouter";
import { analytics } from ".";

const contentRoutes: Array<[RegExp, string, string]> = [
  [/^\/bo-anh\//, "Bộ ảnh", "Gallery"],
  [/^\/bang-gia/, "Bảng giá", "Pricing"],
  [/^\/san-pham\//, "Trang phục", "Rental"],
  [/^\/cho-thue-do/, "Cho thuê đồ", "Rental"],
  [/^\/y-tuong-chup-anh/, "Ý tưởng chụp ảnh", "Inspiration"],
];

export function AnalyticsRouteTracker({ enabled }: { enabled: boolean }) {
  const [path] = useLocation();
  useEffect(() => {
    if (!enabled) return;
    analytics.captureAttribution();
    const fullPath = `${location.pathname}${location.search}`;
    analytics.pageView(fullPath);
    const match = contentRoutes.find(([pattern]) => pattern.test(location.pathname));
    if (match) analytics.viewContent({ content_name: match[1], content_category: match[2], content_ids: [location.pathname] });
  }, [enabled, path]);

  useEffect(() => {
    if (!enabled) return;
    const onClick = (event: MouseEvent) => {
      const element = (event.target as Element | null)?.closest("a,button");
      if (!element) return;
      const href = element instanceof HTMLAnchorElement ? element.href.toLowerCase() : "";
      const label = (element.textContent || "").toLowerCase();
      if (href.startsWith("tel:")) analytics.contact("phone");
      else if (href.startsWith("mailto:")) analytics.contact("email");
      else if (href.includes("zalo.me") || label.includes("zalo")) analytics.contact("zalo");
      else if (href.includes("m.me") || href.includes("messenger") || label.includes("messenger")) analytics.contact("messenger");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [enabled]);
  return null;
}
