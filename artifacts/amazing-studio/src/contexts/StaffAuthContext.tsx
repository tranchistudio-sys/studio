import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api-base";
import { resetClientCacheForScope } from "@/lib/client-runtime";
import {
  canManageTenantMembers,
  authRuntimeScopeKey,
  legacyViewerCanAdmin,
  normalizeAuthResponse,
  resolveAuthClientScope,
  resolveAuthClientState,
  resolveTenantAdmin,
  type AuthResponse,
  type AuthClientScope,
  type LegacyViewerUser,
  type PlatformUser,
  type TenantMembershipSummary,
} from "@/lib/auth-types";

export interface ViewerUser extends LegacyViewerUser {
  isAdmin: boolean;
}

export type ViewMode = "admin" | "staff";
export type SimulateRole = "photographer" | "makeup" | "photoshop" | "sale" | "assistant" | null;

interface StaffAuthContextValue {
  viewer: ViewerUser | null;
  platformUser: PlatformUser | null;
  activeTenant: TenantMembershipSummary | null;
  memberships: TenantMembershipSummary[];
  requiresTenantSelection: boolean;
  authenticated: boolean;
  csrfToken: string | null;
  token: string | null;
  clientScope: AuthClientScope | null;
  authChecked: boolean;
  completeLogin: (response: AuthResponse) => void;
  refreshAuth: () => Promise<boolean>;
  selectTenant: (tenantId: string | number) => Promise<AuthResponse>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  canViewProfile: (staffId: number) => boolean;
  canManageMembers: boolean;
  isAdmin: boolean;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  simulateRole: SimulateRole;
  setSimulateRole: (r: SimulateRole) => void;
  effectiveIsAdmin: boolean;
}

const StaffAuthContext = createContext<StaffAuthContextValue>({
  viewer: null,
  platformUser: null,
  activeTenant: null,
  memberships: [],
  requiresTenantSelection: false,
  authenticated: false,
  csrfToken: null,
  token: null,
  clientScope: null,
  authChecked: false,
  completeLogin: () => {},
  refreshAuth: async () => false,
  selectTenant: async () => { throw new Error("Chưa khởi tạo đăng nhập"); },
  logout: async () => {},
  logoutAll: async () => {},
  canViewProfile: () => false,
  canManageMembers: false,
  isAdmin: false,
  viewMode: "admin",
  setViewMode: () => {},
  simulateRole: null,
  setSimulateRole: () => {},
  effectiveIsAdmin: false,
});

const TOKEN_KEY = "amazingStudioToken_v2";
const OLD_TOKEN_KEYS = ["amazingStudioToken_v1"];
const VIEW_MODE_KEY = "amazingStudioViewMode_v1";
const AUTH_SYNC_KEY = "amazingStudioAuthSync_v1";

function publishAuthSync(): void {
  try {
    // Chỉ phát một nonce; không bao giờ đưa token/session/tenant data vào storage.
    localStorage.setItem(AUTH_SYNC_KEY, `${Date.now()}:${Math.random()}`);
  } catch { /* localStorage may be unavailable */ }
}

function makeViewer(user: LegacyViewerUser, tenantRole?: string): ViewerUser {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return {
    ...user,
    roles,
    // A platform session is authorized by its current tenant membership. The
    // legacy staff role is only a fallback while running without the platform DB.
    isAdmin: tenantRole
      ? tenantRole === "OWNER" || tenantRole === "ADMIN"
      : legacyViewerCanAdmin(user),
  };
}

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "staff" ? "staff" : "admin";
  } catch {
    return "admin";
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string; message?: string };
    return data.error || data.message || `Lỗi ${response.status}`;
  } catch {
    return `Lỗi ${response.status}`;
  }
}

export function StaffAuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [viewer, setViewer] = useState<ViewerUser | null>(null);
  const [platformUser, setPlatformUser] = useState<PlatformUser | null>(null);
  const [activeTenant, setActiveTenant] = useState<TenantMembershipSummary | null>(null);
  const [memberships, setMemberships] = useState<TenantMembershipSummary[]>([]);
  const [requiresTenantSelection, setRequiresTenantSelection] = useState(false);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [viewMode, setViewModeState] = useState<ViewMode>(loadViewMode);
  const [simulateRole, setSimulateRoleState] = useState<SimulateRole>(null);
  const runtimeScopeRef = useRef("anonymous");

  const clearLocalAuth = useCallback((clearQueries = true) => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch { /* localStorage may be unavailable */ }
    resetClientCacheForScope(queryClient, runtimeScopeRef.current, "anonymous", clearQueries);
    runtimeScopeRef.current = "anonymous";
    setViewer(null);
    setPlatformUser(null);
    setActiveTenant(null);
    setMemberships([]);
    setRequiresTenantSelection(false);
    setCsrfToken(null);
    setToken(null);
    setViewModeState("admin");
    setSimulateRoleState(null);
  }, [queryClient]);

  const applyAuthResponse = useCallback((response: AuthResponse, options?: {
    clearQueries?: boolean;
    fallbackToken?: string | null;
  }) => {
    const resolved = resolveAuthClientState(response, options?.fallbackToken ?? null);
    const nextToken = resolved.token;
    try {
      if (nextToken) localStorage.setItem(TOKEN_KEY, nextToken);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* localStorage may be unavailable */ }

    const nextTenant = resolved.activeTenant;
    const nextViewer = response.user ? makeViewer(response.user, nextTenant?.role) : null;
    const nextMemberships = resolved.memberships;
    const needsSelection = resolved.requiresTenantSelection;
    const nextRuntimeScope = authRuntimeScopeKey({
      platformUser: response.platformUser ?? null,
      viewer: nextViewer,
      activeTenant: nextTenant,
    });
    resetClientCacheForScope(
      queryClient,
      runtimeScopeRef.current,
      nextRuntimeScope,
      options?.clearQueries === true,
    );
    runtimeScopeRef.current = nextRuntimeScope;

    setToken(nextToken);
    setViewer(nextViewer);
    setPlatformUser(response.platformUser ?? null);
    setActiveTenant(nextTenant);
    setMemberships(nextMemberships);
    setRequiresTenantSelection(needsSelection);
    setCsrfToken(response.csrfToken ?? null);
    setSimulateRoleState(null);
    setViewModeState(nextViewer?.isAdmin ? "admin" : "staff");

    if (nextViewer) {
      import("@/lib/push-notifications").then(module => module.registerPushNotifications()).catch(() => {});
    }
  }, [queryClient]);

  const fetchCurrentAuth = useCallback(async (fallbackToken?: string | null): Promise<AuthResponse | null> => {
    const headers: Record<string, string> = {};
    if (fallbackToken) headers.Authorization = `Bearer ${fallbackToken}`;
    const response = await fetch(`${API_BASE}/api/auth/me`, {
      credentials: "include",
      headers,
    });
    if (!response.ok) return null;
    return normalizeAuthResponse(await response.json());
  }, []);

  const refreshAuth = useCallback(async (): Promise<boolean> => {
    try {
      const storedToken = token ?? localStorage.getItem(TOKEN_KEY);
      const response = await fetchCurrentAuth(storedToken);
      if (!response) {
        clearLocalAuth();
        return false;
      }
      applyAuthResponse(response, { fallbackToken: storedToken });
      return true;
    } catch {
      clearLocalAuth();
      return false;
    }
  }, [applyAuthResponse, clearLocalAuth, fetchCurrentAuth, token]);

  useEffect(() => {
    OLD_TOKEN_KEYS.forEach(key => {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    });
    const storedToken = (() => {
      try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
    })();

    fetchCurrentAuth(storedToken)
      .then(response => {
        if (response) applyAuthResponse(response, { fallbackToken: storedToken });
        else clearLocalAuth(false);
      })
      .catch(() => clearLocalAuth(false))
      .finally(() => setAuthChecked(true));
  }, [applyAuthResponse, clearLocalAuth, fetchCurrentAuth]);

  useEffect(() => {
    const synchronizeAuth = () => {
      const storedToken = (() => {
        try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
      })();
      fetchCurrentAuth(storedToken)
        .then(response => {
          if (response) applyAuthResponse(response, { clearQueries: true, fallbackToken: storedToken });
          else clearLocalAuth(true);
        })
        .catch(() => clearLocalAuth(true));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_SYNC_KEY) synchronizeAuth();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [applyAuthResponse, clearLocalAuth, fetchCurrentAuth]);

  const completeLogin = useCallback((response: AuthResponse) => {
    applyAuthResponse(response, { clearQueries: true });
    publishAuthSync();
  }, [applyAuthResponse]);

  const selectTenant = useCallback(async (tenantId: string | number): Promise<AuthResponse> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const response = await fetch(`${API_BASE}/api/auth/select-tenant`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ tenantId }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = normalizeAuthResponse(await response.json());
    if (!payload) throw new Error("Máy chủ trả về phiên đăng nhập không hợp lệ");
    applyAuthResponse(payload, { clearQueries: true, fallbackToken: token });
    publishAuthSync();
    return payload;
  }, [applyAuthResponse, csrfToken, token]);

  const endSession = useCallback(async (allDevices: boolean) => {
    // Khi platform DB chưa được bật, phiên cũ chỉ là JWT localStorage và backend
    // không có server session để thu hồi. Xóa phía client vẫn giữ đúng hành vi cũ.
    if (token && !platformUser) {
      clearLocalAuth(true);
      publishAuthSync();
      return;
    }
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const response = await fetch(`${API_BASE}/api/auth/${allDevices ? "logout-all" : "logout"}`, {
        method: "POST",
        credentials: "include",
        headers,
      });
    if (!response.ok && response.status !== 401) {
      throw new Error(await readError(response));
    }
    clearLocalAuth(true);
    publishAuthSync();
  }, [clearLocalAuth, csrfToken, platformUser, token]);

  const authenticated = Boolean(viewer || platformUser);
  const clientScope = useMemo(() => resolveAuthClientScope({
    platformUser,
    viewer,
    activeTenant,
  }), [activeTenant, platformUser, viewer]);
  const runtimeScopeKey = authRuntimeScopeKey({ platformUser, viewer, activeTenant });
  const tenantManager = canManageTenantMembers(activeTenant?.role);
  const isAdmin = resolveTenantAdmin(activeTenant, viewer);
  const effectiveIsAdmin = isAdmin && viewMode === "admin" && !simulateRole;
  const canViewProfile = (staffId: number) => isAdmin || viewer?.id === staffId;

  const setViewMode = (mode: ViewMode) => {
    setViewModeState(mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* ignore */ }
    if (mode === "admin") setSimulateRoleState(null);
  };

  const setSimulateRole = (role: SimulateRole) => {
    setSimulateRoleState(role);
    if (role) setViewModeState("staff");
  };

  const value = useMemo<StaffAuthContextValue>(() => ({
    viewer,
    platformUser,
    activeTenant,
    memberships,
    requiresTenantSelection,
    authenticated,
    csrfToken,
    token,
    clientScope,
    authChecked,
    completeLogin,
    refreshAuth,
    selectTenant,
    logout: () => endSession(false),
    logoutAll: () => endSession(true),
    canViewProfile,
    canManageMembers: tenantManager,
    isAdmin,
    viewMode,
    setViewMode,
    simulateRole,
    setSimulateRole,
    effectiveIsAdmin,
  }), [
    activeTenant, authChecked, authenticated, clientScope, completeLogin, csrfToken, effectiveIsAdmin,
    endSession, isAdmin, memberships, platformUser, refreshAuth, requiresTenantSelection,
    selectTenant, simulateRole, tenantManager, token, viewer, viewMode,
  ]);

  return (
    <StaffAuthContext.Provider value={value}>
      <React.Fragment key={runtimeScopeKey}>{children}</React.Fragment>
    </StaffAuthContext.Provider>
  );
}

export const useStaffAuth = () => useContext(StaffAuthContext);
