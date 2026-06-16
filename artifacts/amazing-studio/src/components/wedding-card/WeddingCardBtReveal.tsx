import { type CSSProperties, type ElementType, type ReactNode } from "react";
import { useRevealOnScroll } from "@/hooks/use-reveal-on-scroll";
import { cn } from "@/lib/utils";

type Props<T extends ElementType = "div"> = {
  as?: T;
  children: ReactNode;
  className?: string;
  delay?: number;
};

export function WeddingCardBtReveal<T extends ElementType = "div">({
  as,
  children,
  className,
  delay = 0,
}: Props<T>) {
  const Tag = (as ?? "div") as ElementType;
  const ref = useRevealOnScroll<HTMLElement>();

  return (
    <Tag
      ref={ref as never}
      className={cn("wc-bt-reveal", className)}
      style={{ "--wc-bt-reveal-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  );
}
