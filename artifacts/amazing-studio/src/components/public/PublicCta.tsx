import { Link } from "wouter";
import { cn } from "@/lib/utils";

type PublicCtaProps = {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "ghost" | "ghost-light";
  className?: string;
};

export function PublicCta({ href, children, variant = "primary", className }: PublicCtaProps) {
  const base =
    "inline-flex items-center justify-center text-xs sm:text-sm tracking-[0.2em] uppercase px-8 py-3.5";

  const variants = {
    primary:
      "btn-public-primary bg-neutral-900 text-white hover:bg-neutral-800",
    ghost:
      "btn-public-ghost border border-neutral-900 text-neutral-900 hover:bg-neutral-900 hover:text-white",
    "ghost-light":
      "btn-public-ghost border border-white/80 text-white hover:bg-white hover:text-neutral-900",
  };

  return (
    <Link href={href} className={cn(base, variants[variant], className)}>
      {children}
    </Link>
  );
}
