import { useState, useEffect } from "react";
import { ImageOff } from "lucide-react";

interface ConceptImageProps {
  src: string;
  alt?: string;
  className?: string;
}

export function ConceptImage({ src, alt = "concept", className = "w-full h-full object-cover" }: ConceptImageProps) {
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [src]);

  if (errored) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-muted text-muted-foreground">
        <ImageOff className="w-4 h-4 opacity-50" />
        <span className="text-[9px] leading-tight text-center px-1 opacity-60">Không tải được</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setErrored(true)}
    />
  );
}
