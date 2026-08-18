import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { renderOfficialGoogleButton } from "@/lib/google-identity";

const GIS_SCRIPT_ID = "google-identity-services";
const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";

interface GoogleSignInButtonProps {
  clientId: string;
  disabled?: boolean;
  loading?: boolean;
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
}

export function GoogleSignInButton({
  clientId,
  disabled = false,
  loading = false,
  onCredential,
  onError,
}: GoogleSignInButtonProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  const errorRef = useRef(onError);
  const [scriptReady, setScriptReady] = useState(Boolean(window.google?.accounts?.id));
  const [scriptFailed, setScriptFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  callbackRef.current = onCredential;
  errorRef.current = onError;

  useEffect(() => {
    if (window.google?.accounts?.id) {
      setScriptReady(true);
      return;
    }

    let script = document.getElementById(GIS_SCRIPT_ID) as HTMLScriptElement | null;
    const handleLoad = () => {
      setScriptFailed(false);
      setScriptReady(true);
    };
    const handleError = () => {
      script?.remove();
      setScriptFailed(true);
      setScriptReady(false);
      errorRef.current("Không tải được nút đăng nhập Google. Vui lòng thử lại.");
    };

    if (!script) {
      script = document.createElement("script");
      script.id = GIS_SCRIPT_ID;
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    return () => {
      script?.removeEventListener("load", handleLoad);
      script?.removeEventListener("error", handleError);
    };
  }, [retryNonce]);

  useEffect(() => {
    const host = hostRef.current;
    const googleId = window.google?.accounts?.id;
    if (!host || !googleId || !scriptReady || !clientId) return;

    renderOfficialGoogleButton({
      api: googleId,
      host,
      clientId,
      onCredential: credential => callbackRef.current(credential),
      onError: message => errorRef.current(message),
    });
  }, [clientId, scriptReady]);

  return (
    <div className="relative min-h-11 w-full">
      <div
        ref={hostRef}
        className={`flex min-h-11 w-full justify-center transition-opacity ${disabled ? "pointer-events-none opacity-50" : ""}`}
        aria-hidden={disabled}
      />
      {!scriptReady && !scriptFailed && !loading && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Đang tải Google…
        </div>
      )}
      {scriptFailed && !loading && (
        <button
          type="button"
          className="absolute inset-0 rounded-lg border border-input bg-background text-sm font-medium hover:bg-muted"
          onClick={() => {
            setScriptFailed(false);
            setRetryNonce(value => value + 1);
          }}
        >
          Tải lại nút Google
        </button>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center rounded bg-background/90 text-sm font-medium">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Đang xác thực Google…
        </div>
      )}
    </div>
  );
}
