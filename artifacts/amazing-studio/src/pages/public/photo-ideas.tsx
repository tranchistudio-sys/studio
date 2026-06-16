import { useState, useMemo, useEffect, useCallback } from "react";
import {
  Lightbulb, Lock, Loader2, ChevronLeft, Sparkles, Wrench, Camera,
} from "lucide-react";
import { getImageSrc } from "@/lib/imageUtils";
import { Tilt3D, STYLE_3D } from "@/components/public-3d";
import PublicGalleryLightbox from "@/components/public/PublicGalleryLightbox";

// ─── Types ──────────────────────────────────────────────────────────────────
interface IdeaCategory {
  id: number; parentId: number | null; name: string;
  slug: string | null; coverImageUrl: string | null; sortOrder: number;
}
interface PublicIdea {
  id: number; name: string; slug: string | null; categoryId: number | null;
  description: string | null; tagsText: string | null;
  executionStatus: "available" | "need_investment";
  coverImageUrl: string | null;
  imageUrl: string | null;
  extraImages: string[];
}

const TOKEN_KEY = "amazingPhotoIdeasToken_v1";
const TOKEN_EXP_KEY = "amazingPhotoIdeasTokenExp_v1";

function loadToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    const exp = Number(localStorage.getItem(TOKEN_EXP_KEY) || 0);
    if (!t || !exp || Date.now() > exp) return null;
    return t;
  } catch { return null; }
}
function saveToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(TOKEN_EXP_KEY, String(Date.now() + 24 * 3600 * 1000));
  } catch { /* ignore */ }
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_EXP_KEY); } catch { /* ignore */ }
}

function albumOf(idea: PublicIdea): string[] {
  const imgs: string[] = [];
  if (idea.imageUrl) imgs.push(idea.imageUrl);
  for (const x of idea.extraImages || []) { if (x && !imgs.includes(x)) imgs.push(x); }
  if (!imgs.length && idea.coverImageUrl) imgs.push(idea.coverImageUrl);
  return imgs;
}

// ─── Badge khả năng thực hiện ────────────────────────────────────────────────
function ExecutionBadge({ status, size = "sm" }: { status: PublicIdea["executionStatus"]; size?: "sm" | "md" }) {
  const cls = size === "md" ? "text-xs px-3 py-1.5" : "text-[10px] px-2 py-0.5";
  if (status === "need_investment") {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-medium bg-amber-50 text-amber-700 border border-amber-200/70 shadow-sm ${cls}`}>
        <Wrench className={size === "md" ? "w-3.5 h-3.5" : "w-2.5 h-2.5"} />
        Cần đầu tư thêm
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/70 shadow-sm ${cls}`}>
      <Sparkles className={size === "md" ? "w-3.5 h-3.5" : "w-2.5 h-2.5"} />
      Có sẵn tại Amazing Studio
    </span>
  );
}

// ─── Password gate — thẻ kính + ổ khoá nổi 3D ────────────────────────────────
function PasswordGate({ onUnlocked }: { onUnlocked: (token: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);

  async function submit() {
    if (!password.trim() || loading) return;
    setLoading(true); setError("");
    try {
      const r = await fetch("/api/public/photo-ideas/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.token) {
        setError((d as { error?: string }).error ?? "Bạn không có quyền truy cập");
        setShake(true); setTimeout(() => setShake(false), 500);
        return;
      }
      saveToken(d.token);
      onUnlocked(d.token);
    } catch {
      setError("Không kết nối được máy chủ. Thử lại sau.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-[78vh] flex items-center justify-center px-4 py-16 overflow-hidden">
      <style>{STYLE_3D}</style>
      {/* Nền gradient mềm */}
      <div aria-hidden className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-32 -left-24 w-96 h-96 rounded-full bg-rose-100/60 blur-3xl" />
        <div className="absolute -bottom-40 -right-24 w-[28rem] h-[28rem] rounded-full bg-amber-100/60 blur-3xl" />
        <div className="absolute top-1/3 right-1/4 w-64 h-64 rounded-full bg-emerald-100/40 blur-3xl" />
      </div>

      <div
        className={`pi-gate-card relative w-full max-w-sm rounded-3xl border border-white/70 bg-white/70 backdrop-blur-xl shadow-[0_24px_70px_-30px_rgba(23,23,23,.35)] p-8 text-center ${shake ? "animate-[piShake_.45s_ease]" : ""}`}
        style={{ transformStyle: "preserve-3d" }}
      >
        <style>{`@keyframes piShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-9px)}40%{transform:translateX(8px)}60%{transform:translateX(-6px)}80%{transform:translateX(4px)}}`}</style>

        {/* Ổ khoá nổi 3D + vòng xoay */}
        <div className="relative w-24 h-24 mx-auto mb-6" style={{ perspective: "600px" }}>
          <div
            aria-hidden
            className="absolute inset-[-8px] rounded-full opacity-70"
            style={{
              background: "conic-gradient(from 0deg, transparent 0%, rgba(212,165,116,.85) 18%, transparent 40%, transparent 55%, rgba(23,23,23,.25) 70%, transparent 90%)",
              animation: "piRing 7s linear infinite",
              maskImage: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))",
              WebkitMaskImage: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))",
            }}
          />
          <div
            className="absolute inset-2 rounded-2xl bg-gradient-to-br from-neutral-800 via-neutral-900 to-black text-white flex items-center justify-center shadow-[0_18px_38px_-12px_rgba(0,0,0,.55)]"
            style={{ animation: "piFloat 5.5s ease-in-out infinite", transformStyle: "preserve-3d" }}
          >
            <Lock className="w-8 h-8 drop-shadow-[0_3px_6px_rgba(0,0,0,.6)]" style={{ transform: "translateZ(22px)" }} />
          </div>
        </div>

        <p className="text-[11px] tracking-[0.4em] text-neutral-500 uppercase mb-2">Ý tưởng chụp ảnh</p>
        <h1 className="font-serif text-2xl text-neutral-900 mb-2">Nội dung dành riêng cho khách</h1>
        <p className="text-sm text-neutral-500 mb-6">Vui lòng nhập mật khẩu để xem nội dung.</p>

        <input
          type="password"
          inputMode="numeric"
          value={password}
          onChange={e => { setPassword(e.target.value); setError(""); }}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder="••••••"
          autoFocus
          className="w-full h-13 py-3 px-4 rounded-2xl border border-neutral-200/90 bg-white/80 text-center text-xl tracking-[0.45em] shadow-inner focus:outline-none focus:ring-2 focus:ring-neutral-900/15 focus:border-neutral-400 transition-all"
        />
        {error && <p className="text-sm text-rose-600 mt-3">{error}</p>}

        <button
          onClick={submit}
          disabled={!password.trim() || loading}
          className="pi-shine relative overflow-hidden w-full mt-5 h-12 rounded-2xl bg-neutral-900 text-white text-sm tracking-[0.25em] uppercase hover:bg-neutral-700 hover:-translate-y-0.5 hover:shadow-[0_16px_30px_-12px_rgba(0,0,0,.5)] active:translate-y-0 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          Xác nhận
        </button>
        <p className="text-[11px] text-neutral-400 mt-4">Liên hệ Amazing Studio nếu bạn chưa có mật khẩu.</p>
      </div>
    </div>
  );
}

// ─── Concept detail (album view) ─────────────────────────────────────────────
function IdeaDetail({ idea, onBack }: { idea: PublicIdea; onBack: () => void }) {
  const images = albumOf(idea);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  return (
    <div>
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-900 hover:-translate-x-0.5 transition-all mb-5"
      >
        <ChevronLeft className="w-4 h-4" /> Quay lại danh sách
      </button>

      <div className="mb-7">
        <h1 className="font-serif text-2xl sm:text-3xl text-neutral-900 mb-2.5">{idea.name}</h1>
        <ExecutionBadge status={idea.executionStatus} size="md" />
        {idea.executionStatus === "need_investment" && (
          <p className="text-sm text-neutral-500 mt-2">
            Concept này cần chuẩn bị thêm đạo cụ / bối cảnh / trang phục theo yêu cầu.
          </p>
        )}
        {idea.description && (
          <p className="text-neutral-600 mt-3 leading-relaxed whitespace-pre-line">{idea.description}</p>
        )}
        {idea.tagsText && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {idea.tagsText.split(",").map(t => t.trim()).filter(Boolean).map(t => (
              <span key={t} className="text-[11px] px-2.5 py-1 rounded-full bg-neutral-100 text-neutral-600 shadow-sm">{t}</span>
            ))}
          </div>
        )}
      </div>

      {images.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-neutral-400">
          <Camera className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">Album đang được cập nhật</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-4" style={{ perspective: "1200px" }}>
          {images.map((src, i) => (
            <div key={src} className="pi-grid-item" style={{ animationDelay: `${Math.min(i * 60, 480)}ms` }}>
              <Tilt3D
                intensity={7}
                onClick={() => setLightboxIdx(i)}
                className="relative aspect-[3/4] rounded-xl overflow-hidden bg-neutral-100 cursor-zoom-in"
              >
                <div className="pi-shine absolute inset-0 z-10 pointer-events-none overflow-hidden rounded-xl" aria-hidden />
                <img
                  src={getImageSrc(src) ?? src}
                  alt={`${idea.name} ${i + 1}`}
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              </Tilt3D>
            </div>
          ))}
        </div>
      )}

      {lightboxIdx !== null && (
        <PublicGalleryLightbox items={images} startIndex={lightboxIdx} onClose={() => setLightboxIdx(null)} />
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────
export default function PublicPhotoIdeasPage() {
  const [token, setToken] = useState<string | null>(() => loadToken());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [cats, setCats] = useState<IdeaCategory[]>([]);
  const [ideas, setIdeas] = useState<PublicIdea[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tier1Id, setTier1Id] = useState<number | null>(null);
  const [tier2Id, setTier2Id] = useState<number | null>(null);
  const [tier3Id, setTier3Id] = useState<number | null>(null);
  const [openIdea, setOpenIdea] = useState<PublicIdea | null>(null);

  const fetchContent = useCallback(async (t: string) => {
    setLoading(true); setLoadError("");
    try {
      const r = await fetch("/api/public/photo-ideas", { headers: { "x-ideas-token": t } });
      if (r.status === 401) {
        clearToken(); setToken(null); setLoaded(false);
        return;
      }
      const d = await r.json();
      if (!r.ok) throw new Error((d as { error?: string }).error ?? "Lỗi tải dữ liệu");
      setCats(d.categories ?? []);
      setIdeas(d.ideas ?? []);
      setLoaded(true);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token && !loaded) void fetchContent(token);
  }, [token, loaded, fetchContent]);

  // ── Category tiers ──
  const tier1 = useMemo(() => cats.filter(c => c.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder), [cats]);
  const tier2 = useMemo(() => tier1Id ? cats.filter(c => c.parentId === tier1Id).sort((a, b) => a.sortOrder - b.sortOrder) : [], [cats, tier1Id]);
  const tier3 = useMemo(() => tier2Id ? cats.filter(c => c.parentId === tier2Id).sort((a, b) => a.sortOrder - b.sortOrder) : [], [cats, tier2Id]);

  const activeBranchIds = useMemo(() => {
    const rootId = tier3Id ?? tier2Id ?? tier1Id;
    if (!rootId) return null;
    const ids = new Set<number>([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of cats) {
        if (c.parentId !== null && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); changed = true; }
      }
    }
    return ids;
  }, [cats, tier1Id, tier2Id, tier3Id]);

  const visibleIdeas = useMemo(() => {
    if (!activeBranchIds) return ideas;
    return ideas.filter(d => d.categoryId !== null && activeBranchIds.has(d.categoryId));
  }, [ideas, activeBranchIds]);

  function TierChips({ items, activeId, onPick }: { items: IdeaCategory[]; activeId: number | null; onPick: (id: number | null) => void }) {
    if (!items.length) return null;
    return (
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => onPick(null)}
          className={`px-3.5 py-1.5 rounded-full text-xs sm:text-sm border transition-all duration-200 ${
            activeId === null
              ? "bg-neutral-900 text-white border-neutral-900 shadow-[0_8px_18px_-8px_rgba(0,0,0,.5)] -translate-y-0.5"
              : "bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400 hover:-translate-y-0.5 hover:shadow-md"
          }`}
        >
          Tất cả
        </button>
        {items.map(c => (
          <button
            key={c.id}
            onClick={() => onPick(c.id)}
            className={`px-3.5 py-1.5 rounded-full text-xs sm:text-sm border transition-all duration-200 ${
              activeId === c.id
                ? "bg-neutral-900 text-white border-neutral-900 shadow-[0_8px_18px_-8px_rgba(0,0,0,.5)] -translate-y-0.5"
                : "bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400 hover:-translate-y-0.5 hover:shadow-md"
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>
    );
  }

  // ── Gate ──
  if (!token) {
    return <PasswordGate onUnlocked={t => { setToken(t); setLoaded(false); }} />;
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      <style>{STYLE_3D}</style>
      {openIdea ? (
        <IdeaDetail idea={openIdea} onBack={() => setOpenIdea(null)} />
      ) : (
        <>
          <div className="text-center mb-8 sm:mb-10">
            <p className="text-xs tracking-[0.35em] text-neutral-500 uppercase mb-3 flex items-center justify-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-500" /> Dành riêng cho khách của Amazing Studio
            </p>
            <h1 className="font-serif text-3xl sm:text-4xl font-light text-neutral-900">Ý tưởng chụp ảnh</h1>
            <p className="text-neutral-500 mt-3 max-w-xl mx-auto text-sm sm:text-base">
              Bộ sưu tập concept, dáng chụp và phong cách mẫu để bạn tham khảo trước buổi chụp.
            </p>
          </div>

          {loading ? (
            <div className="flex justify-center py-24"><Loader2 className="w-7 h-7 animate-spin text-neutral-400" /></div>
          ) : loadError ? (
            <div className="text-center py-20">
              <p className="text-rose-600 text-sm mb-4">{loadError}</p>
              <button onClick={() => token && fetchContent(token)} className="text-sm underline text-neutral-600">Thử lại</button>
            </div>
          ) : (
            <>
              <div className="space-y-2.5 mb-8">
                <TierChips items={tier1} activeId={tier1Id} onPick={id => { setTier1Id(id); setTier2Id(null); setTier3Id(null); }} />
                <TierChips items={tier2} activeId={tier2Id} onPick={id => { setTier2Id(id); setTier3Id(null); }} />
                <TierChips items={tier3} activeId={tier3Id} onPick={setTier3Id} />
              </div>

              {visibleIdeas.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-neutral-400">
                  <Lightbulb className="w-12 h-12 mb-3 opacity-30" />
                  <p>Chưa có ý tưởng nào trong mục này</p>
                </div>
              ) : (
                <div
                  className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-6"
                  style={{ perspective: "1400px" }}
                >
                  {visibleIdeas.map((d, idx) => {
                    const cover = d.coverImageUrl;
                    const count = albumOf(d).length;
                    return (
                      <div key={d.id} className="pi-grid-item" style={{ animationDelay: `${Math.min(idx * 70, 560)}ms` }}>
                        <Tilt3D
                          onClick={() => { setOpenIdea(d); window.scrollTo({ top: 0 }); }}
                          className="text-left rounded-2xl overflow-hidden bg-white border border-neutral-200/70 cursor-pointer"
                        >
                          <div className="relative aspect-[3/4] bg-neutral-100 overflow-hidden">
                            <div className="pi-shine absolute inset-0 z-10 pointer-events-none overflow-hidden" aria-hidden />
                            {cover ? (
                              <img
                                src={getImageSrc(cover) ?? cover}
                                alt={d.name}
                                loading="lazy"
                                className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-neutral-300">
                                <Camera className="w-8 h-8" />
                              </div>
                            )}
                            <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/35 to-transparent pointer-events-none" />
                            {count > 1 && (
                              <span className="absolute bottom-2 right-2 text-[10px] bg-black/55 text-white px-2 py-0.5 rounded-full backdrop-blur-sm">
                                {count} ảnh
                              </span>
                            )}
                          </div>
                          <div className="p-2.5 sm:p-3.5" style={{ transform: "translateZ(26px)" }}>
                            <p className="font-medium text-sm sm:text-base text-neutral-900 leading-snug line-clamp-2">{d.name}</p>
                            <div className="mt-1.5">
                              <ExecutionBadge status={d.executionStatus} />
                            </div>
                          </div>
                        </Tilt3D>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
