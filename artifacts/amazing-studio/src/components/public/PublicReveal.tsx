import { useRevealOnScroll } from "@/hooks/use-reveal-on-scroll";
import { cn } from "@/lib/utils";

type Props = {
  children: React.ReactNode;
  className?: string;
  stagger?: boolean;
  as?: "section" | "div";
};

export function PublicReveal({ children, className, stagger, as: Tag = "section" }: Props) {
  const ref = useRevealOnScroll<HTMLDivElement>();

  return (
    <Tag
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ref={ref as any}
      className={cn(stagger ? "reveal-stagger" : "reveal", className)}
    >
      {children}
    </Tag>
  );
}

export function PublicRevealItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("reveal-item", className)}>{children}</div>;
}
