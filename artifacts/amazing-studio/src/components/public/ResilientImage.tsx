import { useEffect, useMemo, useState, type ImgHTMLAttributes } from "react";
import { getImageSrc } from "@/lib/imageUtils";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string | null | undefined;
  fallbacks?: Array<string | null | undefined>;
  placeholder: string;
};

export function ResilientImage({
  src,
  fallbacks = [],
  placeholder,
  alt = "",
  onError,
  onLoad,
  ...rest
}: Props) {
  const candidates = useMemo(() => {
    const list = [src, ...fallbacks, placeholder]
      .map((u) => (u ? getImageSrc(u) ?? u : null))
      .filter((u): u is string => !!u);
    return [...new Set(list)];
  }, [src, fallbacks, placeholder]);

  const [idx, setIdx] = useState(0);

  useEffect(() => {
    setIdx(0);
  }, [candidates.join("|")]);

  const current = candidates[Math.min(idx, candidates.length - 1)] ?? placeholder;

  return (
    <img
      {...rest}
      alt={alt}
      src={current}
      onLoad={(e) => {
        onLoad?.(e);
      }}
      onError={(e) => {
        setIdx((i) => (i < candidates.length - 1 ? i + 1 : i));
        onError?.(e);
      }}
    />
  );
}
