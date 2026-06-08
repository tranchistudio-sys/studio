import { Link } from "wouter";
import { Eye } from "lucide-react";
import { getTemplateDisplay, resolveTemplatePreviewUrls } from "./wedding-card-config";
import type { WeddingCardTemplate } from "@/hooks/use-wedding-cards";
import { getImageSrc } from "@/lib/imageUtils";
import { weddingTemplatePlaceholder } from "@/lib/cms-placeholders";

function templateImage(template: WeddingCardTemplate): string {
  const urls = resolveTemplatePreviewUrls(template);
  return (
    getImageSrc(urls.mockup) ??
    getImageSrc(urls.cover) ??
    weddingTemplatePlaceholder(template.category)
  );
}

export function WeddingCardBtTemplateRail({
  templates,
  onPreview,
  variant = "gallery",
}: {
  templates: WeddingCardTemplate[];
  onPreview: (t: WeddingCardTemplate) => void;
  variant?: "gallery" | "demo";
}) {
  const railClass = variant === "demo" ? "wc-bt-demo-row" : "wc-bt-rail";

  return (
    <div className={railClass}>
      {templates.map((template) => {
        const display = getTemplateDisplay(template.slug, template.name);
        const href = `/thiep-cuoi-online/tao?template=${template.slug}`;
        const imgSrc = templateImage(template);

        if (variant === "demo") {
          return (
            <div key={template.slug} className="wc-bt-demo-card wc-fade-in">
              <div className="wc-bt-mockup-phone">
                <img src={imgSrc} alt={template.name} className="w-full h-full object-cover" />
              </div>
              <p className="wc-bt-demo-names">{display.title}</p>
              <p className="wc-bt-demo-date">Wedding Invitation</p>
            </div>
          );
        }

        return (
          <article key={template.slug} className="wc-bt-rail-item wc-fade-in">
            <div className="wc-bt-rail-preview">
              <img src={imgSrc} alt={template.name} loading="lazy" />
            </div>
            <p className="wc-bt-rail-cat">{template.category || display.title}</p>
            <p className="wc-bt-rail-name">{template.name || display.title}</p>
            <p className="wc-bt-rail-desc line-clamp-2">
              {template.description || display.subtitle}
            </p>
            <div className="wc-bt-rail-actions">
              <Link href={href} className="wc-bt-btn wc-bt-btn-taupe">
                Dùng mẫu này
              </Link>
              <button
                type="button"
                onClick={() => onPreview(template)}
                className="wc-bt-btn wc-bt-btn-outline"
              >
                <Eye className="h-4 w-4" />
                Xem mẫu
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
