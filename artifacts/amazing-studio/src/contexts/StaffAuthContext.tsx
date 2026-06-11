import React, { createContext, useContext, useState, useEffect } from "react";
import { API_BASE } from "@/lib/api-base";

export interface ViewerUser {
  id: number;
  name: string;
  role: string;
  roles: string[];
  isAdmin: boolean;
  phone?: string;
  email?: string;
  avatar?: string;
}

export type ViewMode = "admin" | "staff";
export type SimulateRole = "photographer" | "makeup" | "photoshop" | "sale" | "assistant" | null;

interface StaffAuthContextValue {
  viewer: ViewerUser | null;
  token: string | null;
  authChecked: boolean;
  login: (user: Omit<ViewerUser, "isAdmin">, token: string) => void;
  logout: () => void;
  setViewer: (v: ViewerUser | null) => void;
  canViewProfile: (staffId: number) => boolean;
  isAdmin: boolean;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  simulateRole: SimulateRole;
  setSimulateRole: (r: SimulateRole) => void;
  effectiveIsAdmin: boolean;
}

const StaffAuthContext = createContext<StaffAuthContextValue>({
  viewer: null,
  token: null,
  authChecked: false,
  login: () => {},
  logout: () => {},
  setViewer: () => {},
  canViewProfile: () => false,
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

function makeViewer(u: Omit<ViewerUser, "isAdmin">): ViewerUser {
  return {
    ...u,
    isAdmin: u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin")),
  };
}

function loadViewMode(): ViewMode {
  try {
    const s = localStorage.getItem(VIEW_MODE_KEY);
    return (s === "staff" ? "staff" : "admin") as ViewMode;
  } catch { return "admin"; }
}

export function StaffAuthProvider({ children }: { children: React.ReactNode }) {
  const [viewer, setViewerState] = useState<ViewerUser | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [viewMode, setViewModeState] = useState<ViewMode>(loadViewMode);
  const [simulateRole, setSimulateRoleState] = useState<SimulateRole>(null);

  useEffect(() => {
    OLD_TOKEN_KEYS.forEach(k => localStorage.removeItem(k));
    const storedToken = localStorage.getItem(TOKEN_KEY);
    if (!storedToken) {
      setAuthChecked(true);
      return;
    }
    fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${storedToken}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then((u: Omit<ViewerUser, "isAdmin"> | null) => {
        if (u) {
          setViewerState(makeViewer(u));
          setTokenState(storedToken);
        } else {
          localStorage.removeItem(TOKEN_KEY);
          setTokenState(null);
        }
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
      })
      .finally(() => setAuthChecked(true));
  }, []);

  const login = (u: Omit<ViewerUser, "isAdmin">, tok: string) => {
    const v = makeViewer(u);
    localStorage.setItem(TOKEN_KEY, tok);
    setTokenState(tok);
    setViewerState(v);
    if (v.isAdmin) {
      setViewModeState("admin");
    } else {
      setViewModeState("staff");
    }
    import("@/lib/push-notifications").then(m => m.registerPushNotifications()).catch(() => {});
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setTokenState(null);
    setViewerState(null);
    setViewModeState("admin");
    setSimulateRoleState(null);
  };

  const setViewer = (v: ViewerUser | null) => setViewerState(v);

  const setViewMode = (m: ViewMode) => {
    setViewModeState(m);
    localStorage.setItem(VIEW_MODE_KEY, m);
    if (m === "admin") setSimulateRoleState(null);
  };

  const setSimulateRole = (r: SimulateRole) => {
    setSimulateRoleState(r);
    if (r) setViewModeState("staff");
  };

  const isAdmin = Boolean(
    viewer && (viewer.role === "admin" || viewer.roles?.includes("admin"))
  );

  const effectiveIsAdmin = isAdmin && viewMode === "admin" && !simulateRole;

  const canViewProfile = (staffId: number) => isAdmin || viewer?.id === staffId;

  return (
    <StaffAuthContext.Provider value={{
      viewer, token, authChecked,
      login, logout, setViewer, canViewProfile,
      isAdmin, viewMode, setViewMode,
      simulateRole, setSimulateRole, effectiveIsAdmin,
    }}>
      {children}
    </StaffAuthContext.Provider>
  );
}

export const useStaffAuth = () => useContext(StaffAuthContext);
