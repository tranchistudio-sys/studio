import { useRevealOnScroll } from "@/hooks/use-reveal-on-scroll";
import { cn } from "@/lib/utils";

export function WeddingCardReveal({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRevealOnScroll<HTMLDivElement>();
  return (
    <div ref={ref} className={cn("wc-reveal", className)}>
      {children}
    </div>
  );
}
