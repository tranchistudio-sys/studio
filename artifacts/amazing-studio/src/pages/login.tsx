import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Camera, Eye, EyeOff, Loader2 } from "lucide-react";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import { API_BASE } from "@/lib/api-base";
import { normalizeAuthResponse, type AuthConfig, type AuthResponse } from "@/lib/auth-types";

interface Props {
  onLogin: (response: AuthResponse) => void;
}

async function fetchAuthConfig(signal?: AbortSignal): Promise<AuthConfig> {
  const response = await fetch(`${API_BASE}/api/auth/config`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) throw new Error("Không chuẩn bị được phiên đăng nhập");
  return response.json() as Promise<AuthConfig>;
}

async function readResponse(response: Response): Promise<AuthResponse> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("Máy chủ trả về phản hồi không hợp lệ");
  }
  if (!response.ok) {
    const error = raw as { error?: string; message?: string };
    throw new Error(error.error || error.message || "Đăng nhập thất bại");
  }
  const normalized = normalizeAuthResponse(raw);
  if (!normalized) throw new Error("Máy chủ không tạo được phiên đăng nhập");
  return normalized;
}

export default function LoginPage({ onLogin }: Props) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [busyMethod, setBusyMethod] = useState<"local" | "google" | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchAuthConfig(controller.signal)
      .then(value => setConfig(value))
      .catch(() => {})
      .finally(() => setConfigLoaded(true));
    return () => controller.abort();
  }, []);

  const submitAuth = async (method: "local" | "google", path: string, body: Record<string, unknown>) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusyMethod(method);
    setError("");
    try {
      const send = (loginCsrfToken?: string) => fetch(`${API_BASE}${path}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, loginCsrfToken }),
        });
      let response = await send(config?.loginCsrfToken);
      if (response.status === 403) {
        const denied = await response.clone().json().catch(() => null) as { code?: string } | null;
        if (denied?.code === "LOGIN_CSRF_INVALID") {
          const refreshedConfig = await fetchAuthConfig();
          setConfig(refreshedConfig);
          response = await send(refreshedConfig.loginCsrfToken);
        }
      }
      onLogin(await readResponse(response));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không kết nối được máy chủ. Thử lại sau.");
    } finally {
      submittingRef.current = false;
      setBusyMethod(null);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!configLoaded) {
      setError("Đang chuẩn bị phiên đăng nhập. Vui lòng chờ một chút.");
      return;
    }
    void submitAuth("local", "/api/auth/login", { phone: phone.trim(), password });
  };

  const googleAvailable = Boolean(
    config?.platformEnabled && config.googleEnabled && config.googleClientId,
  );
  const loading = busyMethod !== null;

  return (
    <div className="relative min-h-[100dvh] overflow-y-auto bg-gradient-to-br from-rose-50 via-pink-50 to-purple-50 px-4 py-16 dark:from-slate-950 dark:via-slate-900 dark:to-purple-950 sm:py-10">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -right-40 -top-40 h-96 w-96 rounded-full bg-rose-200/40 blur-3xl dark:bg-rose-900/20" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-purple-200/40 blur-3xl dark:bg-purple-900/20" />
      </div>

      <Link
        href="/"
        className="absolute left-4 top-4 z-10 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground sm:left-6 sm:top-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Về trang chủ
      </Link>

      <div className="relative mx-auto flex min-h-[calc(100dvh-8rem)] w-full max-w-sm flex-col justify-center sm:min-h-[calc(100dvh-5rem)]">
        <div className="mb-6 text-center sm:mb-8">
          <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-400 to-purple-600 shadow-2xl shadow-rose-200/50 dark:shadow-rose-900/30 sm:h-20 sm:w-20 sm:rounded-3xl">
            <Camera className="h-8 w-8 text-white sm:h-10 sm:w-10" />
          </div>
          <h1 className="bg-gradient-to-r from-rose-600 to-purple-600 bg-clip-text text-3xl font-bold text-transparent">
            Amazing Studio
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Quản lý studio trên một tài khoản riêng của bạn</p>
        </div>

        <div className="rounded-3xl border border-white/50 bg-white/80 p-6 shadow-2xl shadow-rose-100/50 backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/80 dark:shadow-black/30 sm:p-8">
          <h2 className="mb-1 text-center text-xl font-bold">Đăng nhập</h2>
          <p className="mb-6 text-center text-sm text-muted-foreground">
            Dùng tài khoản đã được chủ studio cấp quyền
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="login-username" className="text-sm font-medium text-foreground">
                Số điện thoại / Tên đăng nhập
              </label>
              <input
                id="login-username"
                type="text"
                inputMode="text"
                placeholder="SĐT hoặc tên đăng nhập"
                value={phone}
                onChange={event => setPhone(event.target.value)}
                required
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="username"
                disabled={loading}
                className="h-11 w-full rounded-xl border border-input bg-background/50 px-4 text-sm transition-all placeholder:text-muted-foreground/60 focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-400/50 disabled:opacity-60"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="login-password" className="text-sm font-medium text-foreground">Mật khẩu</label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPass ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Nhập mật khẩu"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  required
                  disabled={loading}
                  className="h-11 w-full rounded-xl border border-input bg-background/50 px-4 pr-11 text-sm transition-all placeholder:text-muted-foreground/60 focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-400/50 disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(value => !value)}
                  disabled={loading}
                  aria-label={showPass ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !configLoaded || !phone.trim() || !password}
              className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-rose-500 to-purple-600 text-sm font-semibold text-white shadow-lg shadow-rose-200/50 transition-all duration-200 hover:from-rose-600 hover:to-purple-700 disabled:cursor-not-allowed disabled:opacity-50 dark:shadow-rose-900/30"
            >
              {busyMethod === "local" ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Đang đăng nhập…</>
              ) : !configLoaded ? "Đang chuẩn bị…" : "Đăng nhập"}
            </button>
          </form>

          {configLoaded && googleAvailable && (
            <>
              <div className="my-5 flex items-center gap-3" aria-label="Hoặc">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Hoặc</span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <GoogleSignInButton
                clientId={config!.googleClientId!}
                disabled={loading}
                loading={busyMethod === "google"}
                onCredential={credential => void submitAuth("google", "/api/auth/google", { credential })}
                onError={setError}
              />
              <p className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                Google chỉ dùng để xác minh danh tính. Amazing Studio không đọc Gmail, danh bạ hay Google Drive.
              </p>
            </>
          )}

          {error && (
            <div role="alert" className="mt-5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-center text-sm text-destructive">
              {error}
            </div>
          )}

          <p className="mt-5 text-center text-xs text-muted-foreground/70">
            Đăng nhập cũ vẫn được giữ làm phương án dự phòng.
            <br />Liên hệ quản trị viên nếu tài khoản Google chưa được cấp quyền.
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground/50">
          © {new Date().getFullYear()} Amazing Studio · Tây Ninh
        </p>
      </div>
    </div>
  );
}
