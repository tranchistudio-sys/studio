import * as React from "react";
import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { SmartSearch } from "./SmartSearch";
import { 
  LayoutDashboard, CalendarDays, CheckSquare, Users, 
  FileText, Shirt, Bot, Settings, Sparkles,
  Moon, LogOut, Bell, Wallet, UserPlus, Menu,
  ClipboardList, TrendingUp, LayoutList, UserCog,
  CreditCard, Film, MessageSquare, ChevronDown, Shield, Eye,
  Camera, Palette, Layers, Banknote, Star, TrendingDown, User, Timer, Funnel, FlaskConical,
  Volume2, VolumeX, CheckCheck,
  Images, DollarSign, Tag, Trash2, Globe, Home, ExternalLink, Heart, LayoutTemplate, Lightbulb,
  SlidersHorizontal, Activity, RefreshCw
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStaffAuth, type SimulateRole } from "@/contexts/StaffAuthContext";
import StaffAvatar from "./StaffAvatar";
import { useNotifications, type Notification } from "@/hooks/use-notifications";
import { registerPushNotifications } from "@/lib/push-notifications";
import { getPublicPageUrl } from "@/lib/public-site-url";
import { PublicSiteLink } from "@/components/PublicSiteLink";
import { UploadQueueIndicator } from "@/components/UploadQueueIndicator";

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} giờ trước`;
  const days = Math.floor(hrs / 24);
  return `${days} ngày trước`;
}

// ─── Navigation Items ──────────────────────────────────────────────────────────
const ALL_NAV_ITEMS = [
  { href: "/dashboard",       label: "Tổng quan",           icon: LayoutDashboard, adminOnly: true  },
  { href: "/my-profile",      label: "Hồ sơ của tôi",       icon: User,            adminOnly: false },

  // 🔥 Nhóm dùng hàng ngày — flow kiếm tiền: Lịch → Tiền → Chi → Hậu kỳ
  { href: "/calendar",        label: "Lịch chụp",            icon: CalendarDays,    adminOnly: false },
  { href: "/payments",        label: "Thu tiền",             icon: CreditCard,      adminOnly: false },
  { href: "/expenses",        label: "Chi tiền",             icon: TrendingDown,    adminOnly: false },
  { href: "/photoshop-jobs",  label: "Tiến độ hậu kỳ",       icon: Film,            adminOnly: false },

  // 📦 Nhóm vận hành chính
  { href: "/customers",       label: "Khách hàng",           icon: Users,           adminOnly: false },
  { href: "/crm-leads",       label: "CRM Leads",            icon: Funnel,          adminOnly: false },
  { href: "/bookings",        label: "Đơn hàng",             icon: ClipboardList,   adminOnly: false },
  { href: "/revenue",         label: "Doanh thu & Lợi nhuận", icon: TrendingUp,    adminOnly: true },

  // 🧠 Nhóm phụ / ít dùng
  { href: "/facebook-inbox-ai", label: "Inbox Facebook",     icon: MessageSquare,    adminOnly: false },
  { href: "/claude-sale-test",  label: "Claude Sale Test",   icon: FlaskConical,     adminOnly: true  },
  { href: "/claude-sale-settings", label: "Claude Sale Settings", icon: SlidersHorizontal, adminOnly: true },
  { href: "/claude-sale-monitor",  label: "Claude Sale Monitor",  icon: Activity,          adminOnly: true },
  { href: "/claude-sale-reengage", label: "Khách cần chăm lại",   icon: RefreshCw,         adminOnly: true },
  { href: "/sale-learning",     label: "Sale Learning",      icon: Sparkles,         adminOnly: true  },
  // ⏸️ Bộ não ChatGPT/OpenAI cũ — TẠM ẨN khỏi menu (chuẩn bị chuyển sang Claude).
  //    Code & route vẫn còn (vào trực tiếp /ai-sale-scripts, /ai-test để rollback).
  //    Bỏ comment 2 dòng dưới để hiện lại menu bot cũ.
  // { href: "/ai-sale-scripts",   label: "Kịch bản Sale AI",   icon: Sparkles,         adminOnly: false },
  // { href: "/ai-test",           label: "Phòng test AI",       icon: FlaskConical,     adminOnly: false },
  { href: "/pricing",         label: "Dịch vụ & Bảng giá",  icon: LayoutList,      adminOnly: false },
  { href: "/staff",           label: "Nhân sự",              icon: UserCog,         adminOnly: false },
  { href: "/tasks",           label: "Giao việc",            icon: CheckSquare,     adminOnly: false },
  { href: "/attendance",      label: "Chấm công",             icon: Timer,           adminOnly: false },

  // Khác
  { href: "/quotes",          label: "Báo giá tạm tính",     icon: FileText,        adminOnly: true  },
];

const SECONDARY_NAV = [
  { href: "/reports",       label: "Báo cáo",        icon: TrendingUp, adminOnly: true  },
  { href: "/ai-assistant",  label: "Studio Copilot",      icon: Bot,        adminOnly: false },
  { href: "/settings",      label: "Cài đặt",        icon: Settings,   adminOnly: true  },
];

type CmsNavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  /** Chỉ admin/owner thật (isAdmin), không phụ thuộc chế độ nhân viên test. */
  adminOnly: boolean;
  /** Mở trang public preview (tab mới), không route nội bộ. */
  publicPreview?: boolean;
  /** Đường dẫn public tương ứng (mở tab mới cạnh link CMS). */
  publicPath?: string;
};

const CMS_NAV: CmsNavItem[] = [
  { href: "/",               label: "Trang chủ",     icon: Home,       adminOnly: false, publicPreview: true },
  { href: "/cms/home-settings", label: "Cài đặt Trang chủ", icon: LayoutTemplate, adminOnly: false, publicPath: "/" },
  { href: "/cms/gallery",    label: "Concept ảnh",  icon: Images,     adminOnly: false, publicPath: "/bo-anh" },
  { href: "/cms/pricing",    label: "Bảng giá",      icon: DollarSign, adminOnly: false, publicPath: "/bang-gia" },
  { href: "/cms/categories", label: "Cho thuê đồ",   icon: Shirt,      adminOnly: false, publicPath: "/cho-thue-do" },
  { href: "/cms/photo-ideas", label: "Ý tưởng chụp ảnh", icon: Lightbulb, adminOnly: false, publicPath: "/y-tuong-chup-anh" },
  { href: "/cms/wedding-templates", label: "Cài đặt Thiệp cưới", icon: Heart, adminOnly: true, publicPath: "/thiep-cuoi-online" },
  { href: "/cms/trash",      label: "Thùng rác CMS", icon: Trash2,     adminOnly: true },
];

const SIMULATE_ROLES: { key: SimulateRole; label: string; icon: React.ElementType; color: string }[] = [
  { key: "photographer", label: "Nhân viên Chụp ảnh", icon: Camera,    color: "text-blue-500" },
  { key: "makeup",       label: "Nhân viên Makeup",   icon: Palette,   color: "text-pink-500" },
  { key: "photoshop",    label: "Nhân viên Photoshop",icon: Layers,    color: "text-violet-500" },
  { key: "sale",         label: "Nhân viên Sale",     icon: Star,      color: "text-amber-500" },
  { key: "assistant",    label: "Nhân viên Hỗ trợ",  icon: UserCog,   color: "text-slate-500" },
];

// ─── Layout ──────────────────────────────────────────────────────────────────
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string) {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [isMobileOpen, setIsMobileOpen] = React.useState(false);
  const [showRoleMenu, setShowRoleMenu] = React.useState(false);
  const [showBellMenu, setShowBellMenu] = useState(false);
  const roleMenuRef = React.useRef<HTMLDivElement>(null);
  const bellMenuRef = useRef<HTMLDivElement>(null);
  const { isAdmin, viewMode, setViewMode, simulateRole, setSimulateRole, effectiveIsAdmin, logout, viewer } = useStaffAuth();

  const { notifications: notifList, unreadCount: notifUnread, soundEnabled, toggleSound, markAsRead, markAllRead, fetchNotifications } = useNotifications();
  const [pushEnabled, setPushEnabled] = useState(() => localStorage.getItem("pushRegistered") === "1");

  React.useEffect(() => {
    if (!pushEnabled && viewer && "Notification" in window && Notification.permission === "granted") {
      registerPushNotifications().then(ok => { if (ok) setPushEnabled(true); }).catch(() => {});
    }
  }, [viewer]);

  React.useEffect(() => {
    setIsMobileOpen(false);
    setShowRoleMenu(false);
  }, [location]);

  // Close role menu on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (roleMenuRef.current && !roleMenuRef.current.contains(e.target as Node)) {
        setShowRoleMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close bell menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (bellMenuRef.current && !bellMenuRef.current.contains(e.target as Node)) {
        setShowBellMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggleDarkMode = () => {
    document.documentElement.classList.toggle("dark");
  };

  // Filter nav items based on effective role
  const visibleMain = ALL_NAV_ITEMS.filter(item =>
    effectiveIsAdmin || !item.adminOnly || item.href === "/expenses"
  );
  const visibleSecondary = SECONDARY_NAV.filter(item =>
    effectiveIsAdmin || !item.adminOnly
  );

  // Current mode label
  const modeLabel = simulateRole
    ? SIMULATE_ROLES.find(r => r.key === simulateRole)?.label ?? "Nhân viên"
    : viewMode === "admin" ? "Quản trị viên" : "Nhân viên";

  const modeBadgeColor = simulateRole
    ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
    : viewMode === "admin"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
      : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Mobile overlay */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden backdrop-blur-sm"
          onClick={() => setIsMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed lg:static inset-y-0 left-0 z-50 w-72 bg-sidebar border-r border-sidebar-border flex flex-col transition-transform duration-300 ease-in-out transform lg:translate-x-0",
        isMobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
      )}>
        {/* Logo */}
        <div className="p-6 flex items-center gap-3">
          <div className="h-10 w-10 bg-primary/10 rounded-xl flex items-center justify-center">
            <img src={`${import.meta.env.BASE_URL}images/logo.png`} alt="Logo" className="w-8 h-8 object-contain" />
          </div>
          <div>
            <h1 className="font-bold text-lg text-sidebar-foreground leading-tight">Amazing</h1>
            <p className="text-[10px] tracking-widest text-muted-foreground font-semibold uppercase">STUDIO</p>
          </div>
        </div>

        {/* Account card with role switcher */}
        <div className="px-4 mb-4" ref={roleMenuRef}>
          <button
            onClick={() => setShowRoleMenu(v => !v)}
            className="w-full flex items-center gap-3 p-3 rounded-xl bg-accent/50 border border-accent/20 hover:bg-accent/80 transition-colors group">
            <div className="flex-shrink-0">
              {viewer ? (
                <StaffAvatar
                  name={viewer.name ?? "?"}
                  avatar={viewer.avatar}
                  role={viewer.role ?? "assistant"}
                  status="active"
                  size="lg"
                />
              ) : (
                <div className="h-11 w-11 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">
                  {simulateRole
                    ? (() => { const r = SIMULATE_ROLES.find(x => x.key === simulateRole); return r ? <r.icon className={cn("w-5 h-5", r.color)} /> : "NV"; })()
                    : viewMode === "admin" ? <Shield className="w-5 h-5 text-emerald-600" /> : <Eye className="w-5 h-5 text-blue-600" />
                  }
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-xs font-semibold text-sidebar-foreground truncate">{viewer?.name ?? modeLabel}</p>
              <p className="text-[10px] text-muted-foreground truncate">{modeLabel}</p>
            </div>
            <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform flex-shrink-0", showRoleMenu && "rotate-180")} />
          </button>

          {/* Role dropdown */}
          {showRoleMenu && (
            <div className="mt-1 bg-popover border border-border rounded-xl shadow-lg overflow-hidden z-50">
              {/* Admin mode */}
              {isAdmin && (
                <button
                  onClick={() => { setViewMode("admin"); setSimulateRole(null); setShowRoleMenu(false); }}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-muted transition-colors",
                    viewMode === "admin" && !simulateRole && "bg-emerald-50 dark:bg-emerald-950/20"
                  )}>
                  <Shield className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  <span>Quản trị viên</span>
                  {viewMode === "admin" && !simulateRole && <span className="ml-auto text-xs text-emerald-600 font-medium">Đang dùng</span>}
                </button>
              )}
              {/* Staff mode */}
              <button
                onClick={() => { setViewMode("staff"); setSimulateRole(null); setShowRoleMenu(false); }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-muted transition-colors",
                  viewMode === "staff" && !simulateRole && "bg-blue-50 dark:bg-blue-950/20"
                )}>
                <Eye className="w-4 h-4 text-blue-600 flex-shrink-0" />
                <span>Chế độ nhân viên</span>
                {viewMode === "staff" && !simulateRole && <span className="ml-auto text-xs text-blue-600 font-medium">Đang dùng</span>}
              </button>

              {/* Simulate roles (admin only) */}
              {isAdmin && (
                <>
                  <div className="px-3 py-1.5 border-t border-border">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Xem thử vai trò</p>
                  </div>
                  {SIMULATE_ROLES.map(r => (
                    <button key={r.key}
                      onClick={() => { setSimulateRole(r.key); setShowRoleMenu(false); }}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-muted transition-colors",
                        simulateRole === r.key && "bg-violet-50 dark:bg-violet-950/20"
                      )}>
                      <r.icon className={cn("w-3.5 h-3.5 flex-shrink-0", r.color)} />
                      <span>{r.label}</span>
                      {simulateRole === r.key && <span className="ml-auto text-xs text-violet-600 font-medium">Đang xem</span>}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          <div className="space-y-0.5">
            {visibleMain.map(item => {
              const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link key={item.href} href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                      : "text-sidebar-foreground hover:bg-muted"
                  )}>
                  <item.icon className={cn("w-4.5 h-4.5 transition-transform duration-200 group-hover:scale-110",
                    isActive ? "text-sidebar-accent-foreground" : "text-muted-foreground")} />
                  {item.label}
                </Link>
              );
            })}
          </div>

          <div className="mt-3 pt-3 border-t border-sidebar-border space-y-0.5">
            <p className="px-4 mb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Công cụ</p>
            {visibleSecondary.map(item => {
              const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link key={item.href} href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                      : "text-sidebar-foreground hover:bg-muted"
                  )}>
                  <item.icon className={cn("w-4.5 h-4.5 transition-transform duration-200 group-hover:scale-110",
                    isActive ? "text-sidebar-accent-foreground" : "text-muted-foreground")} />
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* ── Quản lý website public ── */}
          {CMS_NAV.some(item => isAdmin || !item.adminOnly) && (
            <div className="mt-3 pt-3 border-t border-sidebar-border space-y-0.5">
              <p className="px-4 mb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Quản lý website</p>
              {CMS_NAV.filter(item => isAdmin || !item.adminOnly).map(item => {
                const isActive = !item.publicPreview && (location === item.href || location.startsWith(item.href + "/"));
                const itemCls = cn(
                  "flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                    : "text-sidebar-foreground hover:bg-muted"
                );
                const iconCls = cn("w-4.5 h-4.5 transition-transform duration-200 group-hover:scale-110",
                  isActive ? "text-sidebar-accent-foreground" : "text-muted-foreground");
                if (item.publicPreview) {
                  return (
                    <PublicSiteLink
                      key={item.href}
                      path="/"
                      className={itemCls}
                      title="Mở website khách hàng (trang chủ public)"
                    >
                      <item.icon className={iconCls} />
                      {item.label}
                    </PublicSiteLink>
                  );
                }
                if (item.publicPath) {
                  return (
                    <div key={item.href} className="flex items-center gap-0.5 pr-1">
                      <Link href={item.href} className={cn(itemCls, "flex-1 min-w-0")}>
                        <item.icon className={iconCls} />
                        {item.label}
                      </Link>
                      <PublicSiteLink
                        path={item.publicPath!}
                        className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0"
                        title={`Xem ${item.label} trên website khách hàng`}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </PublicSiteLink>
                    </div>
                  );
                }
                return (
                  <Link key={item.href} href={item.href} className={itemCls}>
                    <item.icon className={iconCls} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div className="p-4 border-t border-sidebar-border space-y-1">
          <button onClick={toggleDarkMode}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-sidebar-foreground hover:bg-muted w-full transition-colors">
            <Moon className="w-5 h-5 text-muted-foreground" />
            Chế độ Tối
          </button>
          <button
            onClick={logout}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-destructive hover:bg-destructive/10 w-full transition-colors">
            <LogOut className="w-5 h-5" />
            Đăng xuất
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Header */}
        <header className="h-16 flex-shrink-0 bg-background/80 backdrop-blur-md border-b border-border flex items-center justify-between px-4 sm:px-6 lg:px-8 z-10">
          <div className="flex items-center gap-3">
            <button className="lg:hidden p-2 text-muted-foreground hover:bg-muted rounded-lg"
              onClick={() => setIsMobileOpen(true)}>
              <Menu className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-semibold hidden sm:block">Amazing Studio</h2>
            {/* View mode badge */}
            {(!effectiveIsAdmin) && (
              <span className={cn("hidden sm:flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full", modeBadgeColor)}>
                {simulateRole
                  ? `Đang xem thử: ${SIMULATE_ROLES.find(r => r.key === simulateRole)?.label}`
                  : isAdmin && viewMode === "staff"
                    ? "Test chấm công · NHÂN VIÊN TEST"
                    : "Chế độ nhân viên"}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2 sm:gap-4">
            <SmartSearch />
            <Link href="/customers"
              className="flex items-center gap-2 text-sm font-medium text-primary bg-primary/10 hover:bg-primary/20 px-3 py-1.5 sm:px-4 sm:py-2 rounded-full transition-colors">
              <UserPlus className="w-4 h-4" />
              <span className="hidden sm:inline">Khách hàng mới</span>
            </Link>
            {effectiveIsAdmin && (
              <Link href="/payments" className="p-2 text-muted-foreground hover:bg-muted rounded-full transition-colors hidden sm:flex">
                <Wallet className="w-5 h-5" />
              </Link>
            )}
            <UploadQueueIndicator />
            <PublicSiteLink
                  path="/"
                  title="Mở website khách hàng (trang chủ public)"
                  className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted px-2 sm:px-3 py-1.5 rounded-full transition-colors"
                >
                  <Globe className="w-4 h-4" />
                  <span className="hidden sm:inline">Xem website</span>
                </PublicSiteLink>
            <div ref={bellMenuRef} className="relative">
              <button
                onClick={() => { setShowBellMenu(prev => !prev); if (!showBellMenu) fetchNotifications(); }}
                className="p-2 text-muted-foreground hover:bg-muted rounded-full transition-colors relative"
                title="Thông báo"
              >
                <Bell className="w-5 h-5" />
                {notifUnread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold bg-destructive text-destructive-foreground rounded-full px-1 border border-background animate-pulse">
                    {notifUnread > 9 ? "9+" : notifUnread}
                  </span>
                )}
              </button>
              {showBellMenu && (
                <div className="absolute right-0 top-full mt-1.5 w-80 sm:w-96 bg-popover border rounded-xl shadow-lg z-50 overflow-hidden">
                  <div className="px-3 py-2 border-b bg-muted/40 flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Thông báo
                    </span>
                    <div className="flex items-center gap-1.5">
                      {!pushEnabled && "Notification" in window && Notification.permission !== "denied" && (
                        <button
                          onClick={() => { registerPushNotifications().then(ok => { if (ok) setPushEnabled(true); }).catch(() => {}); }}
                          className="flex items-center gap-1 text-[10px] text-amber-600 hover:text-amber-700 font-medium bg-amber-50 px-1.5 py-0.5 rounded"
                          title="Bật thông báo đẩy"
                        >
                          <Bell className="w-3 h-3" /> Bật Push
                        </button>
                      )}
                      <button onClick={toggleSound} className="p-1 rounded hover:bg-muted transition-colors" title={soundEnabled ? "Tắt âm thanh" : "Bật âm thanh"}>
                        {soundEnabled ? <Volume2 className="w-3.5 h-3.5 text-primary" /> : <VolumeX className="w-3.5 h-3.5 text-muted-foreground" />}
                      </button>
                      {notifUnread > 0 && (
                        <button onClick={() => markAllRead()} className="flex items-center gap-1 text-[10px] text-primary hover:underline font-medium">
                          <CheckCheck className="w-3 h-3" /> Đọc hết
                        </button>
                      )}
                    </div>
                  </div>
                  {notifList.length === 0 ? (
                    <>
                      <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                        Chưa có thông báo nào
                      </div>
                      <Link href="/notifications" onClick={() => setShowBellMenu(false)} className="block px-3 py-2 border-t bg-muted/30 text-center text-xs font-medium text-primary hover:underline">
                        Xem tất cả thông báo →
                      </Link>
                    </>
                  ) : (
                    <div className="divide-y max-h-80 overflow-y-auto">
                      {notifList.slice(0, 20).map(n => {
                        const priorityColor = n.priority === "urgent" ? "border-l-red-500 bg-red-50/50 dark:bg-red-950/20" :
                          n.priority === "high" ? "border-l-red-400 bg-red-50/30 dark:bg-red-950/10" :
                          n.priority === "warning" ? "border-l-amber-400 bg-amber-50/30 dark:bg-amber-950/10" : "border-l-transparent";
                        // Deep-link: ?bookingId=N để các trang tự mở detail panel
                        const bidQuery = n.bookingId ? `?bookingId=${n.bookingId}` : "";
                        const href = n.targetModule === "calendar" ? `/calendar${bidQuery}` :
                          n.targetModule === "payments" ? `/payments${bidQuery}` :
                          n.targetModule === "photoshop-jobs" ? `/photoshop-jobs${bidQuery}` :
                          n.targetModule === "tasks" ? `/tasks${bidQuery}` : null;
                        const timeAgo = getTimeAgo(n.createdAt);
                        return (
                          <div
                            key={n.id}
                            onClick={() => { if (!n.isRead) markAsRead(n.id); }}
                            className={cn(
                              "flex flex-col gap-0.5 px-3 py-2.5 border-l-2 transition-colors cursor-pointer hover:bg-muted/50",
                              priorityColor,
                              !n.isRead && "bg-primary/5"
                            )}
                          >
                            {(() => {
                              const inner = (
                                <>
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                                      {n.type === "photoshop_deadline_digest" && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold shrink-0">Tổng hợp</span>
                                      )}
                                      <span className={cn("text-sm leading-snug", !n.isRead ? "font-semibold text-foreground" : "text-foreground/80")}>{n.title}</span>
                                    </div>
                                    {!n.isRead && <span className="mt-1 w-2 h-2 rounded-full bg-primary flex-shrink-0" />}
                                  </div>
                                  {n.message && (
                                    <p className="text-[13px] text-foreground/70 leading-relaxed mt-0.5 line-clamp-3">{n.message}</p>
                                  )}
                                  <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground/80 flex-wrap">
                                    {n.senderName && (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                                        <User className="w-2.5 h-2.5" />{n.senderName}
                                      </span>
                                    )}
                                    <span>· {timeAgo}</span>
                                  </div>
                                </>
                              );
                              return href ? (
                                <Link href={href} onClick={() => { setShowBellMenu(false); }} className="contents">{inner}</Link>
                              ) : inner;
                            })()}
                          </div>
                        );
                      })}
                      <Link href="/notifications" onClick={() => setShowBellMenu(false)} className="block px-3 py-2 border-t bg-muted/30 text-center text-xs font-medium text-primary hover:underline sticky bottom-0">
                        Xem tất cả thông báo →
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* Logout — always visible in header */}
            <button
              onClick={logout}
              title="Đăng xuất"
              className="p-2 text-destructive hover:bg-destructive/10 rounded-full transition-colors">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Page Content */}
        {/* Full-screen pages (chat UIs) skip padding and max-width */}
        {location.startsWith("/ai-test") || location.startsWith("/facebook-inbox-ai") ? (
          <div className="flex-1 overflow-hidden min-h-0">
            {children}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            <div className="max-w-7xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
              {children}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
