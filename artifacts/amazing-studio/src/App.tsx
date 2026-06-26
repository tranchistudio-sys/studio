import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api-base";
import { Layout } from "@/components/layout";
import { PublicLayout } from "@/components/PublicLayout";
import Dashboard from "@/pages/dashboard";
import CalendarPage from "@/pages/calendar";
import TasksPage from "@/pages/tasks";
import CustomersPage from "@/pages/customers";
import QuotesPage from "@/pages/quotes";
import ServicesPage from "@/pages/services";
import ServiceDetailPage from "@/pages/service-detail";
import PricingPage from "@/pages/pricing";
import AccountingHrPage from "@/pages/accounting-hr";
import StaffPage from "@/pages/staff";
import StaffProfilePage from "@/pages/staff-profile";
import AiAssistantPage from "@/pages/ai-assistant";
import SettingsPage from "@/pages/settings";
import BookingsPage from "@/pages/bookings";
import BookingsTrashPage from "@/pages/bookings/trash";
import ContractsPage from "@/pages/contracts";
import ReportsPage from "@/pages/reports";
import PaymentsPage from "@/pages/payments";
import ExpensesPage from "@/pages/expenses";
import RevenuePage from "@/pages/revenue";
import PhotoshopJobsPage from "@/pages/photoshop-jobs";
import AttendancePage from "@/pages/attendance";
import AttendanceCheckinPage from "@/pages/attendance-checkin";
import MyProfilePage from "@/pages/my-profile";
import CrmLeadsPage from "@/pages/crm-leads";
import FacebookInboxAiPage from "@/pages/facebook-inbox-ai";
import AiSaleScriptsPage from "@/pages/ai-sale-scripts";
import AiTestRoomPage from "@/pages/ai-test-room";
import ClaudeSaleSettingsPage from "@/pages/claude-sale-settings";
import ClaudeSaleMonitorPage from "@/pages/claude-sale-monitor";
import ClaudeSaleReengagePage from "@/pages/claude-sale-reengage";
import SaleLearningPage from "@/pages/sale-learning";
import LuluHumanReviewPage from "@/pages/lulu-human-review";
import LuluBrainLabPage from "@/pages/lulu-brain-lab";
import AutoPostFacebookPage from "@/pages/auto-post-facebook";
import NotificationsPage from "@/pages/notifications";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import CmsGalleryPage from "@/pages/cms/gallery";
import CmsPricingPublicPage from "@/pages/cms/pricing-public";
import CmsCategoriesPage from "@/pages/cms/categories";
import CmsPhotoIdeasPage from "@/pages/cms/photo-ideas";
import PublicPhotoIdeasPage from "@/pages/public/photo-ideas";
import CmsTrashPage from "@/pages/cms/trash";
import CmsHomeSettingsPage from "@/pages/cms/home-settings";
import CmsWeddingTemplatesPage from "@/pages/cms/wedding-templates";
import PublicHomePage from "@/pages/public/home";
import {
  PUBLIC_PREVIEW_PARAM,
  PUBLIC_PREVIEW_SESSION_KEY,
  PUBLIC_PREVIEW_VALUE,
} from "@/lib/public-site-url";
import PublicGalleryPage from "@/pages/public/gallery";
import PublicPricingPage from "@/pages/public/pricing-public";
import PublicRentalPage from "@/pages/public/rental-public";
import PublicContactPage from "@/pages/public/contact";
import RentalDetailPage from "@/pages/public/rental-detail";
import PublicGalleryDetailPage from "@/pages/public/gallery-detail";
import WeddingCardsLandingPage from "@/pages/public/wedding-cards-landing";
import WeddingCardsCreatePage from "@/pages/public/wedding-cards-create";
import WeddingCardViewPage from "@/pages/public/wedding-card-view";
import { StaffAuthProvider, useStaffAuth } from "@/contexts/StaffAuthContext";
import { UploadQueueProvider } from "@/contexts/UploadQueueContext";
import { Camera, Shirt } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";

// Register auth token getter once at app startup so all api-client-react hooks
// (useListStaff, useListTasks, etc.) automatically include the auth header.
setAuthTokenGetter(() => localStorage.getItem("amazingStudioToken_v2"));

const apiOrigin = getApiBase();
if (apiOrigin) {
  setBaseUrl(apiOrigin);
}

// Routes that do NOT require authentication.
const PUBLIC_ROUTES = [
  "/",
  "/trang-chu",
  "/bo-anh",
  "/bang-gia",
  "/cho-thue-do",
  "/san-pham",
  "/y-tuong-chup-anh",
  "/lien-he",
  "/thiep-cuoi-online",
  "/thiep-cuoi",
  "/login",
];

// Path prefixes that REQUIRE authentication. Anything else falls back to public 404.
const INTERNAL_PREFIXES = [
  "/dashboard", "/calendar", "/tasks", "/customers", "/quotes",
  "/pricing", "/services", "/staff", "/accounting", "/ai-assistant", "/settings",
  "/bookings", "/payments", "/expenses", "/revenue", "/contracts", "/reports",
  "/my-profile", "/photoshop-jobs", "/attendance",
  "/crm-leads", "/facebook-inbox-ai", "/ai-sale-scripts", "/ai-test", "/claude-sale-test", "/claude-sale-settings", "/claude-sale-monitor", "/claude-sale-reengage", "/sale-learning", "/lulu-human-review", "/lulu-brain-lab", "/auto-post-facebook", "/notifications",
  "/cms",
];

function isPublicPath(path: string): boolean {
  return PUBLIC_ROUTES.some((p) => (p === "/" ? path === "/" : path === p || path.startsWith(p + "/")));
}

function isInternalPath(path: string): boolean {
  return INTERNAL_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

// Khách mở website lần đầu (TẢI TRANG mới ngay tại root / domain chính) → ưu tiên trang Cho thuê đồ.
// Chỉ căn cứ URL lúc tải trang: điều hướng nội bộ của wouter KHÔNG nạp lại module này, nên khi khách
// tự bấm menu "Trang chủ" sẽ không bị đẩy đi, và mở thẳng /san-pham/:slug hay deep-link khác cũng
// không dính (lúc tải trang không ở root).
const INITIAL_LOAD_AT_ROOT = (() => {
  if (typeof window === "undefined") return false;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  let path = window.location.pathname;
  if (base && path.startsWith(base)) path = path.slice(base.length);
  return path === "" || path === "/" || path === "/trang-chu";
})();

// Chỉ ưu tiên Cho thuê đồ đúng 1 lần cho mỗi lần tải trang; sau đó để khách điều hướng tự do.
let rootLandingConsumed = !INITIAL_LOAD_AT_ROOT;

const RETURN_TO_KEY = "amazingStudioReturnTo_v1";

/** Globe / new tab: staff preview customer website (skip auto-redirect to /calendar). */
function isPublicPreviewMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get(PUBLIC_PREVIEW_PARAM) === PUBLIC_PREVIEW_VALUE) {
      sessionStorage.setItem(PUBLIC_PREVIEW_SESSION_KEY, "1");
      return true;
    }
    return sessionStorage.getItem(PUBLIC_PREVIEW_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function AdminRoute({ component: Component, fallback }: { component: React.ComponentType; fallback?: string }) {
  const { effectiveIsAdmin } = useStaffAuth();
  if (!effectiveIsAdmin) return <Redirect to={fallback ?? "/calendar"} />;
  return <Component />;
}

/** CMS admin pages: quyền theo role admin thật (vẫn vào được khi chế độ test chấm công). */
function CmsAdminRoute({ component: Component, fallback }: { component: React.ComponentType; fallback?: string }) {
  const { isAdmin } = useStaffAuth();
  if (!isAdmin) return <Redirect to={fallback ?? "/calendar"} />;
  return <Component />;
}

function StaffRoute() {
  const { effectiveIsAdmin, viewer } = useStaffAuth();
  if (!effectiveIsAdmin) {
    return viewer?.id ? <Redirect to={`/staff/${viewer.id}`} /> : <Redirect to="/login" />;
  }
  return <StaffPage />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  },
});

function PublicNotFound() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-24 text-center">
      <p className="text-xs tracking-[0.4em] text-neutral-500 uppercase mb-4">404</p>
      <h1 className="font-serif text-4xl sm:text-5xl font-light text-neutral-900 mb-4">
        Không tìm thấy trang
      </h1>
      <p className="text-neutral-600 mb-8">
        Đường dẫn bạn truy cập không tồn tại hoặc đã được di chuyển.
      </p>
      <a
        href={import.meta.env.BASE_URL}
        className="inline-flex items-center justify-center bg-neutral-900 text-white text-sm tracking-widest uppercase px-8 py-3 hover:bg-neutral-700 transition-colors"
      >
        Về trang chủ
      </a>
    </div>
  );
}

function PublicRouter() {
  const [location] = useLocation();

  // Editor + thiệp public — không header/footer marketing (mobile-first)
  if (location.startsWith("/thiep-cuoi-online/tao")) {
    return (
      <Switch>
        <Route path="/thiep-cuoi-online/tao" component={WeddingCardsCreatePage} />
        <Route component={PublicNotFound} />
      </Switch>
    );
  }
  if (location.startsWith("/thiep-cuoi/") && !location.startsWith("/thiep-cuoi-online")) {
    return (
      <Switch>
        <Route path="/thiep-cuoi/:slug" component={WeddingCardViewPage} />
        <Route component={PublicNotFound} />
      </Switch>
    );
  }

  return (
    <PublicLayout>
      <Switch>
        <Route path="/" component={PublicHomePage} />
        <Route path="/trang-chu"><Redirect to="/" /></Route>
        <Route path="/bo-anh" component={PublicGalleryPage} />
        <Route path="/bo-anh/:slug" component={PublicGalleryDetailPage} />
        <Route path="/bang-gia" component={PublicPricingPage} />
        <Route path="/cho-thue-do" component={PublicRentalPage} />
        <Route path="/san-pham/:slug" component={RentalDetailPage} />
        <Route path="/y-tuong-chup-anh" component={PublicPhotoIdeasPage} />
        <Route path="/lien-he" component={PublicContactPage} />
        <Route path="/thiep-cuoi-online" component={WeddingCardsLandingPage} />
        <Route component={PublicNotFound} />
      </Switch>
    </PublicLayout>
  );
}

function InternalRouter() {
  return (
    <Layout>
      <Switch>
        <Route path="/dashboard" component={() => <AdminRoute component={Dashboard} />} />
        <Route path="/calendar" component={CalendarPage} />
        <Route path="/tasks" component={TasksPage} />
        <Route path="/customers" component={CustomersPage} />
        <Route path="/quotes" component={() => <AdminRoute component={QuotesPage} />} />
        <Route path="/pricing" component={PricingPage} />
        <Route path="/services/:id" component={ServiceDetailPage} />
        <Route path="/services" component={ServicesPage} />
        <Route path="/staff/:id" component={StaffProfilePage} />
        <Route path="/staff" component={StaffRoute} />
        <Route path="/accounting" component={AccountingHrPage} />
        <Route path="/ai-assistant" component={AiAssistantPage} />
        <Route path="/settings" component={() => <AdminRoute component={SettingsPage} />} />
        <Route path="/bookings/trash" component={() => <AdminRoute component={BookingsTrashPage} />} />
        <Route path="/bookings" component={BookingsPage} />
        <Route path="/payments" component={PaymentsPage} />
        <Route path="/expenses" component={ExpensesPage} />
        <Route path="/revenue" component={() => <CmsAdminRoute component={RevenuePage} />} />
        <Route path="/contracts" component={() => <AdminRoute component={ContractsPage} />} />
        <Route path="/reports" component={() => <AdminRoute component={ReportsPage} />} />
        <Route path="/my-profile" component={MyProfilePage} />
        <Route path="/photoshop-jobs" component={PhotoshopJobsPage} />
        <Route path="/attendance/check-in" component={AttendanceCheckinPage} />
        <Route path="/attendance" component={AttendancePage} />
        <Route path="/crm-leads" component={CrmLeadsPage} />
        <Route path="/facebook-inbox-ai" component={FacebookInboxAiPage} />
        <Route path="/ai-sale-scripts" component={AiSaleScriptsPage} />
        <Route path="/ai-test" component={AiTestRoomPage} />
        {/* "Lulu Sale Test" gộp vào Lulu Brain Lab → tab "Sửa & Test Lulu". Giữ route để link/bookmark cũ tự chuyển hướng. */}
        <Route path="/claude-sale-test" component={() => <Redirect to="/lulu-brain-lab?tab=fixtest" />} />
        <Route path="/claude-sale-settings" component={() => <AdminRoute component={ClaudeSaleSettingsPage} />} />
        <Route path="/claude-sale-monitor" component={() => <AdminRoute component={ClaudeSaleMonitorPage} />} />
        <Route path="/claude-sale-reengage" component={() => <AdminRoute component={ClaudeSaleReengagePage} />} />
        <Route path="/sale-learning" component={() => <AdminRoute component={SaleLearningPage} />} />
        <Route path="/lulu-human-review" component={() => <AdminRoute component={LuluHumanReviewPage} />} />
        <Route path="/lulu-brain-lab" component={LuluBrainLabPage} />
        <Route path="/auto-post-facebook" component={() => <AdminRoute component={AutoPostFacebookPage} />} />
        <Route path="/notifications" component={NotificationsPage} />
        <Route path="/cms/home-settings" component={CmsHomeSettingsPage} />
        <Route path="/cms/gallery" component={CmsGalleryPage} />
        <Route path="/cms/wedding-templates" component={() => <CmsAdminRoute component={CmsWeddingTemplatesPage} />} />
        <Route path="/cms/pricing" component={CmsPricingPublicPage} />
        <Route path="/cms/rentals" component={() => <Redirect to="/cms/categories" />} />
        <Route path="/cms/products-rental" component={() => <Redirect to="/cms/categories" />} />
        <Route path="/cms/categories" component={CmsCategoriesPage} />
        <Route path="/cms/photo-ideas" component={CmsPhotoIdeasPage} />
        <Route path="/cms/trash" component={() => <CmsAdminRoute component={CmsTrashPage} />} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function popReturnTo(): string {
  try {
    const v = sessionStorage.getItem(RETURN_TO_KEY);
    if (v) sessionStorage.removeItem(RETURN_TO_KEY);
    return v && v.startsWith("/") && !v.startsWith("/login") ? v : "/calendar";
  } catch {
    return "/calendar";
  }
}

function LoginRoute() {
  const { login, viewer } = useStaffAuth();
  const [, setLocation] = useLocation();
  if (viewer) {
    return <Redirect to={popReturnTo()} />;
  }
  return (
    <LoginPage
      onLogin={(u, t) => {
        login(u, t);
        setLocation(popReturnTo());
      }}
    />
  );
}

function RedirectToLogin({ from }: { from: string }) {
  try {
    sessionStorage.setItem(RETURN_TO_KEY, from);
  } catch { /* ignore */ }
  return <Redirect to="/login" />;
}

/** Mở website từ root → đưa khách sang /cho-thue-do. Dùng `replace` để không kẹt nút Back. */
function RootLandingRedirect() {
  useEffect(() => {
    rootLandingConsumed = true;
  }, []);
  return <Redirect to="/cho-thue-do" replace />;
}

function RouterRoot() {
  const { viewer, authChecked } = useStaffAuth();
  const [location] = useLocation();

  if (!authChecked) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white">
        <div className="inline-flex items-center justify-center w-20 h-20 bg-neutral-900 rounded-3xl shadow-lg mb-5 animate-pulse">
          <Camera className="w-10 h-10 text-white" />
        </div>
        <p className="text-neutral-500 text-sm mt-2">Đang tải...</p>
      </div>
    );
  }

  // /login route — always render LoginPage (or redirect if already logged in).
  if (location === "/login") {
    return <LoginRoute />;
  }

  const publicPreview = isPublicPreviewMode();

  // Preview mode: staff xem website khách (globe) — luôn hiện public, không vào app.
  if (publicPreview && isPublicPath(location)) {
    return <PublicRouter />;
  }

  // Nhân viên/admin đã đăng nhập: vào "/" → Lịch Chụp.
  if ((location === "/" || location === "/trang-chu") && viewer) {
    return <Redirect to="/calendar" />;
  }

  // Public routes — khách lạ / link ẩn (chưa đăng nhập).
  if (isPublicPath(location)) {
    // Lần đầu mở website từ root → ưu tiên trang Cho thuê đồ (studio đang đẩy mạnh cho thuê đồ).
    if (!rootLandingConsumed && (location === "/" || location === "/trang-chu")) {
      return <RootLandingRedirect />;
    }
    return <PublicRouter />;
  }

  // Internal routes — require authentication, preserve return-to.
  if (isInternalPath(location)) {
    if (!viewer) return <RedirectToLogin from={location} />;
    return <InternalRouter />;
  }

  // Unknown path → public 404 (not forced through login).
  return <PublicRouter />;
}

function AppContent() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <RouterRoot />
    </WouterRouter>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <StaffAuthProvider>
        <UploadQueueProvider>
          <AppContent />
          <Toaster />
        </UploadQueueProvider>
      </StaffAuthProvider>
    </QueryClientProvider>
  );
}

export default App;
