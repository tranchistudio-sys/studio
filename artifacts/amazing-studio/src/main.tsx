import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

declare global {
  interface Window {
    __amazingBootTimer?: number;
    __amazingCleanReload?: () => Promise<void>;
  }
}

interface CrashBoundaryProps {
  children: ReactNode;
}

interface CrashBoundaryState {
  crashed: boolean;
}

class AppCrashBoundary extends Component<CrashBoundaryProps, CrashBoundaryState> {
  state: CrashBoundaryState = { crashed: false };

  static getDerivedStateFromError(): CrashBoundaryState {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[app] React render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return <BootFailure />;
  }
}

function BootFailure() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#faf7f2] p-6">
      <section className="w-full max-w-md rounded-2xl border border-[#eadfd3] bg-white p-7 text-center shadow-sm">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-neutral-900 text-2xl">📷</div>
        <h1 className="mb-2 text-xl font-semibold text-neutral-900">Không thể mở giao diện</h1>
        <p className="mb-5 leading-relaxed text-neutral-600">
          Trình duyệt đang giữ dữ liệu cũ hoặc kết nối vừa bị gián đoạn. Bấm nút dưới đây để ứng dụng tự làm mới.
        </p>
        <button
          type="button"
          onClick={() => void window.__amazingCleanReload?.()}
          className="w-full rounded-xl bg-amber-600 px-4 py-3 font-semibold text-white hover:bg-amber-700"
        >
          Tải lại sạch
        </button>
      </section>
    </main>
  );
}

async function bootstrap() {
  const { default: App } = await import("./App");
  let tree = <App />;
  if (import.meta.env.DEV) {
    const { DevResponsivePreview } = await import("@/components/dev/DevResponsivePreview");
    tree = <DevResponsivePreview>{tree}</DevResponsivePreview>;
  }
  if (window.__amazingBootTimer) window.clearTimeout(window.__amazingBootTimer);
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root element");
  createRoot(root).render(<AppCrashBoundary>{tree}</AppCrashBoundary>);
}

bootstrap().catch((error) => {
  console.error("[app] Bootstrap failed", error);
  if (window.__amazingBootTimer) window.clearTimeout(window.__amazingBootTimer);
  const status = document.getElementById("app-boot-status");
  const actions = document.getElementById("app-boot-actions");
  if (status) status.textContent = "Không tải được giao diện. Bấm Tải lại sạch để ứng dụng tự khắc phục.";
  if (actions) actions.hidden = false;
});
