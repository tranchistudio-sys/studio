import * as React from "react";
import { cn } from "@/lib/utils";

function rawToDisplay(value: string | number | undefined | null): string {
  const str = String(value ?? "").replace(/\D/g, "");
  if (!str) return "";
  return Number(str).toLocaleString("vi-VN");
}

interface CurrencyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value?: string | number;
  onChange?: (rawValue: string) => void;
}

const CurrencyInput = React.forwardRef<HTMLInputElement, CurrencyInputProps>(
  ({ value, onChange, className, onBlur, onFocus, ...props }, ref) => {
    const [display, setDisplay] = React.useState(() => rawToDisplay(value));
    const isEditing = React.useRef(false);

    React.useEffect(() => {
      if (!isEditing.current) {
        setDisplay(rawToDisplay(value));
      }
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value.replace(/\D/g, "");
      const formatted = raw ? Number(raw).toLocaleString("vi-VN") : "";
      setDisplay(formatted);
      onChange?.(raw);
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      isEditing.current = true;
      onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      isEditing.current = false;
      const raw = display.replace(/\D/g, "");
      const formatted = raw ? Number(raw).toLocaleString("vi-VN") : "";
      if (formatted !== display) setDisplay(formatted);
      onBlur?.(e);
    };

    return (
      <input
        ref={ref}
        type="text"
        inputMode="numeric"
        pattern="[0-9.,\s]*"
        value={display}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        {...props}
      />
    );
  }
);
CurrencyInput.displayName = "CurrencyInput";

export { CurrencyInput };
