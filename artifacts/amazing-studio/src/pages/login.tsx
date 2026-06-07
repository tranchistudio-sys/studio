import { useState } from "react";
import { Link } from "wouter";
import { Eye, EyeOff, Camera, Loader2, ArrowLeft } from "lucide-react";
import { API_BASE } from "@/lib/api-base";

interface LoginUser {
  id: number;
  name: string;
  role: string;
  roles: string[];
  phone: string;
  email?: string;
  avatar?: string;
}

interface Props {
  onLogin: (user: LoginUser, token: string) => void;
}

export default function LoginPage({ onLogin }: Props) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, password }),
      });
      const data = await res.json() as { token?: string; user?: LoginUser; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Đăng nhập thất bại");
        return;
      }
      if (data.token && data.user) {
        onLogin(data.user, data.token);
      }
    } catch {
      setError("Không kết nối được máy chủ. Thử lại sau.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-rose-50 via-pink-50 to-purple-50 dark:from-slate-950 dark:via-slate-900 dark:to-purple-950 px-4">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-rose-200/40 dark:bg-rose-900/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-purple-200/40 dark:bg-purple-900/20 rounded-full blur-3xl" />
      </div>

      {/* Back to public site */}
      <Link
        href="/"
        className="absolute top-6 left-6 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors z-10"
      >
        <ArrowLeft className="w-4 h-4" />
        Về trang chủ
      </Link>

      {/* Card */}
      <div className="relative w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-rose-400 to-purple-600 rounded-3xl shadow-2xl shadow-rose-200/50 dark:shadow-rose-900/30 mb-5">
            <Camera className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-rose-600 to-purple-600 bg-clip-text text-transparent">
            Amazing Studio
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Chụp ảnh cưới & Cho thuê váy cưới</p>
        </div>

        {/* Form card */}
        <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-3xl shadow-2xl shadow-rose-100/50 dark:shadow-black/30 border border-white/50 dark:border-white/10 p-8">
          <h2 className="text-xl font-bold text-center mb-1">Đăng nhập</h2>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Dùng số điện thoại hoặc tên đăng nhập
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Phone / Username */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Số điện thoại / Tên đăng nhập</label>
              <input
                type="text"
                inputMode="text"
                placeholder="SĐT hoặc tên đăng nhập"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                required
                autoFocus
                className="w-full h-11 px-4 rounded-xl border border-input bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400/50 focus:border-rose-400 transition-all placeholder:text-muted-foreground/60"
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Mật khẩu</label>
              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Nhập mật khẩu"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full h-11 px-4 pr-11 rounded-xl border border-input bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400/50 focus:border-rose-400 transition-all placeholder:text-muted-foreground/60"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm rounded-xl px-4 py-3 text-center">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !phone || !password}
              className="w-full h-11 rounded-xl bg-gradient-to-r from-rose-500 to-purple-600 hover:from-rose-600 hover:to-purple-700 text-white font-semibold text-sm shadow-lg shadow-rose-200/50 dark:shadow-rose-900/30 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-2"
            >
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Đang đăng nhập...</>
              ) : (
                "Đăng nhập"
              )}
            </button>
          </form>

          <p className="text-xs text-muted-foreground/70 text-center mt-6">
            Mật khẩu mặc định là số điện thoại của bạn.
            <br />Liên hệ quản trị viên nếu cần hỗ trợ.
          </p>
        </div>

        <p className="text-center text-xs text-muted-foreground/50 mt-6">
          © {new Date().getFullYear()} Amazing Studio · Tây Ninh
        </p>
      </div>
    </div>
  );
}
