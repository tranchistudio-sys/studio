import { cn } from "@/lib/utils";

type Props = {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "left" | "center";
  className?: string;
};

export function PublicSectionHeader({
  eyebrow,
  title,
  description,
  align = "center",
  className,
}: Props) {
  return (
    <header
      className={cn(
        "mb-12 sm:mb-16",
        align === "center" && "text-center",
        className,
      )}
    >
      {eyebrow && (
        <p className="text-[11px] tracking-[0.35em] text-neutral-500 uppercase mb-4">
          {eyebrow}
        </p>
      )}
      <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-light text-neutral-900 leading-tight">
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            "mt-4 text-neutral-600 leading-relaxed text-base sm:text-lg max-w-2xl",
            align === "center" && "mx-auto",
          )}
        >
          {description}
        </p>
      )}
    </header>
  );
}
