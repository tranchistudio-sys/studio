import { Link } from "wouter";
import { Eye } from "lucide-react";
import { getTemplateDisplay, resolveTemplatePreviewUrls } from "./wedding-card-config";
import type { WeddingCardTemplate } from "@/hooks/use-wedding-cards";
import { getImageSrc } from "@/lib/imageUtils";
import { weddingTemplatePlaceholder } from "@/lib/cms-placeholders";
import { WeddingCardBtReveal } from "./WeddingCardBtReveal";

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
  if (variant === "demo") {
    const loop = templates.length > 1 ? [...templates, ...templates] : templates;
    return (
      <WeddingCardBtReveal className="wc-bt-demo-wrap">
        <div className={`wc-bt-demo-row ${templates.length > 2 ? "wc-bt-demo-row--marquee" : ""}`}>
          {loop.map((template, i) => {
            const display = getTemplateDisplay(template.slug, template.name);
            const imgSrc = templateImage(template);
            return (
              <div key={`${template.slug}-${i}`} className="wc-bt-demo-card">
                <div className="wc-bt-mockup-phone">
                  <img src={imgSrc} alt={template.name} className="w-full h-full object-cover" draggable={false} />
                </div>
                <p className="wc-bt-demo-names">{display.coupleNames || display.title}</p>
                <p className="wc-bt-demo-date">Wedding Invitation</p>
              </div>
            );
          })}
        </div>
      </WeddingCardBtReveal>
    );
  }

  return (
    <div className="wc-bt-rail">
      {templates.map((template, i) => {
        const display = getTemplateDisplay(template.slug, template.name);
        const href = `/thiep-cuoi-online/tao?template=${template.slug}`;
        const imgSrc = templateImage(template);

        return (
          <WeddingCardBtReveal key={template.slug} as="article" className="wc-bt-rail-item" delay={i * 80}>
            <div className="wc-bt-rail-preview">
              <img src={imgSrc} alt={template.name} loading="lazy" draggable={false} />
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
          </WeddingCardBtReveal>
        );
      })}
    </div>
  );
}
