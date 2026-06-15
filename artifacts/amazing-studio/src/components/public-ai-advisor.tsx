import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Sparkles, X, Send, Loader2, Lock, Wrench, Globe, SearchCheck, SlidersHorizontal, Eraser } from "lucide-react";
import { cn } from "@/lib/utils";
import { getImageSrc } from "@/lib/imageUtils";

/**
 * Widget AI tư vấn hình ảnh — nút nổi góc phải, hiện trên mọi trang public.
 * Gọi POST /api/cms/public/visual-advisor; server chỉ trả dữ liệu thật từ DB.
 *
 * Phạm vi nguồn: mặc định tìm theo MODULE đang xem (Cho thuê đồ → dress,
 * Bộ ảnh mẫu → album, Ý tưởng chụp ảnh → idea, Bảng giá/Dịch vụ → service).
 * Chỉ khi khách bật "Toàn studio" mới hợp nhất tất cả nguồn (sourceScope=all).
 */

type SourceType = "dress" | "album" | "idea" | "service";

interface AdvisorItem {
  sourceType: SourceType;
  id: number;
  title: string;
  imageUrl: string | null;
  link: string;
  tags: string[];
  status: string | null;
}

interface AdvisorReply {
  answer: string;
  items: AdvisorItem[];
  ideasLocked: boolean;
  ideasLink: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  items?: AdvisorItem[];
  ideasLocked?: boolean;
  ideasLink?: string;
  /** Câu hỏi để tìm lại trong toàn studio (khi tìm theo module không ra kết quả) */
  retryAllQuery?: string;
}

interface AdvisorFilters {
  sizes: string[];
  weights: string[];
  colors: string[];
  styles: string[];
}

/** Module public đang xem → nguồn dữ liệu tương ứng của advisor. */
function detectModule(path: string): { source: SourceType; label: string } | null {
  if (path.startsWith("/cho-thue-do") || path.startsWith("/san-pham")) {
    return { source: "dress", label: "Cho thuê đồ" };
  }
  if (path.startsWith("/bo-anh")) return { source: "album", label: "Bộ ảnh mẫu" };
  if (path.startsWith("/y-tuong-chup-anh")) return { source: "idea", label: "Ý tưởng chụp ảnh" };
  if (path.startsWith("/bang-gia")) return { source: "service", label: "Gói dịch vụ" };
  return null;
}

// Dự phòng khi chưa tải được tiêu chí từ server (giá trị thực tế của studio)
const FALLBACK_FILTERS: AdvisorFilters = {
  sizes: ["L", "M", "S", "XL", "XS"],
  weights: ["40-48kg", "49-55kg", "56-65kg"],
  colors: ["Hồng", "Hồng pastel", "Kem", "Trắng", "Đen"],
  styles: ["CUTE", "Hàn Quốc", "công chúa", "cổ điển", "hiện đại", "nàng thơ", "quyến rũ", "sang trọng", "sinh nhật", "tiểu thư", "đuôi cá"],
};

// Dùng chung token với trang Ý tưởng chụp ảnh (khách đã nhập mật khẩu trong 24h)
const IDEAS_TOKEN_KEY = "amazingPhotoIdeasToken_v1";
const IDEAS_TOKEN_EXP_KEY = "amazingPhotoIdeasTokenExp_v1";

function loadIdeasToken(): string | null {
  try {
    const t = localStorage.getItem(IDEAS_TOKEN_KEY);
    const exp = Number(localStorage.getItem(IDEAS_TOKEN_EXP_KEY) || 0);
    if (!t || !exp || Date.now() > exp) return null;
    return t;
  } catch { return null; }
}

const SOURCE_LABEL: Record<AdvisorItem["sourceType"], string> = {
  dress: "Cho thuê đồ",
  album: "Bộ ảnh mẫu",
  idea: "Ý tưởng",
  service: "Gói dịch vụ",
};

// Gợi ý nhanh theo module đang xem (key "all" = không ở trang module / Toàn studio)
const QUICK_PROMPTS: Record<SourceType | "all", string[]> = {
  dress: ["Em thích váy nàng thơ", "Váy kín đáo, sang trọng", "Váy đi tiệc quyến rũ", "Váy cưới công chúa"],
  album: ["Có mẫu ảnh beauty không?", "Bộ ảnh cưới ngoại cảnh", "Mẫu ảnh chụp gia đình"],
  idea: ["Có ý tưởng chụp mới lạ không?", "Concept chụp đôi lãng mạn", "Ý tưởng chụp sinh nhật"],
  service: ["Gói chụp cưới giá bao nhiêu?", "Có gói chụp gia đình không?", "Gói nào tiết kiệm nhất?"],
  all: ["Em thích váy nàng thơ", "Váy kín đáo, sang trọng", "Có mẫu ảnh beauty không?", "Có ý tưởng chụp mới lạ không?"],
};

const INPUT_PLACEHOLDER: Record<SourceType | "all", string> = {
  dress: "VD: váy nàng thơ kín đáo…",
  album: "VD: bộ ảnh cưới ngoại cảnh…",
  idea: "VD: concept chụp mới lạ…",
  service: "VD: gói chụp cưới trọn gói…",
  all: "VD: váy nàng thơ kín đáo…",
};

function StatusBadge({ item }: { item: AdvisorItem }) {
  if (item.sourceType === "idea") {
    return item.status === "need_investment" ? (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/70">
        <Wrench className="w-2.5 h-2.5" /> Cần đầu tư thêm
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/70">
        <Sparkles className="w-2.5 h-2.5" /> Có sẵn
      </span>
    );
  }
  if (item.sourceType === "dress" && item.status && item.status !== "san_sang") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600 border border-neutral-200">
        Đang cho thuê
      </span>
    );
  }
  return null;
}

function ResultCard({ item, onNavigate }: { item: AdvisorItem; onNavigate: () => void }) {
  const img = getImageSrc(item.imageUrl);
  return (
    <Link
      href={item.link}
      onClick={onNavigate}
      className="flex gap-2.5 p-2 rounded-xl border border-neutral-200 bg-white hover:border-neutral-400 hover:shadow-sm transition-all"
    >
      <div className="w-16 h-20 flex-shrink-0 rounded-lg overflow-hidden bg-neutral-100">
        {img ? (
          <img src={img} alt={item.title} loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-300">
            <Sparkles className="w-5 h-5" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <div className="text-[10px] tracking-widest uppercase text-neutral-400">
          {SOURCE_LABEL[item.sourceType]}
        </div>
        <div className="text-sm font-medium text-neutral-900 leading-snug line-clamp-2">{item.title}</div>
        <div className="mt-1 flex flex-wrap gap-1 items-center">
          <StatusBadge item={item} />
          {item.tags.slice(0, 3).map(t => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-neutral-500">
              {t}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}

export function PublicAiAdvisor() {
  const [location] = useLocation();
  const module = detectModule(location);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [searchAll, setSearchAll] = useState(false);
  const [filters, setFilters] = useState<AdvisorFilters | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Hiện lại bảng chip tiêu chí giữa hội thoại (nút "Đổi tiêu chí")
  const [showFilters, setShowFilters] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const moduleSource = module?.source;
  const scopeKey: SourceType | "all" = searchAll || !module ? "all" : module.source;
  const dressInScope = scopeKey === "all" || scopeKey === "dress";

  // Mỗi module mặc định tìm theo context của nó — đổi module thì tắt "Toàn studio"
  useEffect(() => { setSearchAll(false); }, [moduleSource]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading, open]);

  // Tải bộ tiêu chí (Size/Số đo/Màu/Kiểu) từ dữ liệu thật khi mở panel lần đầu
  useEffect(() => {
    if (!open || filters) return;
    let alive = true;
    fetch("/api/cms/public/visual-advisor/meta")
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!alive) return;
        const f = (d?.filters ?? null) as AdvisorFilters | null;
        const ok = !!f && [f.sizes, f.weights, f.colors, f.styles].every(Array.isArray) &&
          f.sizes.length + f.weights.length + f.colors.length + f.styles.length > 0;
        setFilters(ok ? f : FALLBACK_FILTERS);
      })
      .catch(() => { if (alive) setFilters(FALLBACK_FILTERS); });
    return () => { alive = false; };
  }, [open, filters]);

  async function send(text: string, opts?: { forceAll?: boolean }) {
    const q = text.trim();
    if (!q || loading) return;
    const scopeAll = !!opts?.forceAll || searchAll || !module;
    setInput("");
    setShowFilters(false);
    setMessages(m => [...m, { role: "user", text: q }]);
    setLoading(true);
    try {
      const r = await fetch("/api/cms/public/visual-advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          ideasToken: loadIdeasToken() ?? undefined,
          sourceScope: scopeAll ? "all" : "current",
          currentSource: module?.source,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as Partial<AdvisorReply> & { error?: string };
      if (!r.ok) {
        setMessages(m => [...m, { role: "assistant", text: d.error ?? "Có lỗi xảy ra, bạn thử lại nhé." }]);
        return;
      }
      setMessages(m => [...m, {
        role: "assistant",
        text: d.answer ?? "",
        items: d.items ?? [],
        ideasLocked: d.ideasLocked,
        ideasLink: d.ideasLink,
        // Tìm theo module mà không ra gì → mời tìm lại trong toàn studio
        retryAllQuery: !scopeAll && !d.items?.length && !d.ideasLocked ? q : undefined,
      }]);
    } catch {
      setMessages(m => [...m, { role: "assistant", text: "Không kết nối được máy chủ. Bạn thử lại sau nhé." }]);
    } finally {
      setLoading(false);
    }
  }

  function togglePick(key: string) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function sendPicked() {
    const by = (g: string) => [...picked].filter(k => k.startsWith(`${g}:`)).map(k => k.slice(g.length + 1));
    const sizes = by("size"), weights = by("weight"), colors = by("color"), styles = by("style");
    const parts: string[] = [];
    if (sizes.length) parts.push(`size ${sizes.join(" hoặc ")}`);
    if (weights.length) parts.push(`số đo ${weights.join(" hoặc ")}`);
    if (colors.length) parts.push(`màu ${colors.join(", ")}`);
    if (styles.length) parts.push(`kiểu ${styles.join(", ")}`);
    if (!parts.length) return;
    // Giữ nguyên lựa chọn để khách bấm "Đổi tiêu chí" chỉnh lại nhanh (send() tự đóng bảng chip)
    void send(`${dressInScope ? "Tìm váy" : "Tìm mẫu"} ${parts.join(", ")}`);
  }

  // Nhóm chip tiêu chí: Size/Số đo chỉ có nghĩa với váy; trang Gói dịch vụ (scope hiện tại) thì ẩn hết
  const MAX_CHIPS_PER_GROUP = 14;
  const chipGroups = !filters || scopeKey === "service" ? [] : [
    ...(dressInScope
      ? [
          { key: "size", label: "Size", options: filters.sizes },
          { key: "weight", label: "Số đo", options: filters.weights },
        ]
      : []),
    { key: "color", label: "Màu", options: filters.colors },
    { key: "style", label: "Kiểu", options: filters.styles },
  ]
    .map(g => ({ ...g, options: g.options.slice(0, MAX_CHIPS_PER_GROUP) }))
    .filter(g => g.options.length > 0);

  // Bảng chip dùng chung: trong màn hình chào và khi bấm "Đổi tiêu chí" giữa hội thoại
  const filterChipsPanel = (
    <>
      {chipGroups.map(g => (
        <div key={g.key} className="px-1">
          <p className="text-[10px] uppercase tracking-widest text-neutral-400 mb-1">{g.label}</p>
          <div className="flex flex-wrap gap-1.5">
            {g.options.map(opt => {
              const k = `${g.key}:${opt}`;
              const active = picked.has(k);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => togglePick(k)}
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-full border transition-colors",
                    active
                      ? "bg-neutral-900 text-white border-neutral-900"
                      : "border-neutral-200 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900",
                  )}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {picked.size > 0 && (
        <div className="px-1 pb-1 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={sendPicked}
            className="inline-flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-full bg-neutral-900 text-amber-100 hover:bg-neutral-700 transition-colors"
          >
            <SearchCheck className="w-3.5 h-3.5" />
            Tìm theo {picked.size} tiêu chí đã chọn
          </button>
          <button
            type="button"
            onClick={() => setPicked(new Set())}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-full border border-neutral-200 text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors"
          >
            <Eraser className="w-3.5 h-3.5" />
            Xoá lựa chọn
          </button>
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Hiệu ứng phép thuật cho nút + nhãn 3D */}
      <style>{`
        @keyframes aiAdvGlow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(212,165,116,.65), 0 0 18px 2px rgba(244,114,182,.35), 0 8px 24px -6px rgba(0,0,0,.45); }
          50%      { box-shadow: 0 0 0 14px rgba(212,165,116,0), 0 0 30px 6px rgba(244,114,182,.55), 0 8px 28px -4px rgba(0,0,0,.5); }
        }
        @keyframes aiAdvTwinkle {
          0%, 100% { opacity: 0; transform: scale(.2) rotate(0deg); }
          50%      { opacity: 1; transform: scale(1) rotate(180deg); }
        }
        @keyframes aiAdvBob {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-5px); }
        }
        @keyframes aiAdvLabel3d {
          0%, 100% { transform: perspective(420px) rotateX(7deg) rotateY(-10deg) translateY(0); }
          50%      { transform: perspective(420px) rotateX(-7deg) rotateY(10deg) translateY(-5px); }
        }
        @keyframes aiAdvLabelIn {
          from { opacity: 0; transform: translateX(24px) scale(.7); }
          to   { opacity: 1; transform: translateX(0) scale(1); }
        }
        @keyframes aiAdvShine {
          to { background-position: 200% center; }
        }
        .ai-adv-btn { animation: aiAdvGlow 2.4s ease-in-out infinite, aiAdvBob 3.2s ease-in-out infinite; }
        .ai-adv-spark { position: absolute; color: #ffe9b3; pointer-events: none; animation: aiAdvTwinkle 1.8s ease-in-out infinite; text-shadow: 0 0 6px rgba(255,215,130,.9); }
        .ai-adv-label-wrap { animation: aiAdvLabelIn .5s ease-out both, aiAdvBob 3.2s ease-in-out infinite; }
        .ai-adv-label { animation: aiAdvLabel3d 4s ease-in-out infinite; transform-style: preserve-3d; }
        .ai-adv-label-text {
          background: linear-gradient(110deg, #f5d08c 0%, #fff7e6 25%, #f0a8c0 50%, #fff7e6 75%, #f5d08c 100%);
          background-size: 200% auto;
          -webkit-background-clip: text; background-clip: text; color: transparent;
          animation: aiAdvShine 2.8s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .ai-adv-btn, .ai-adv-spark, .ai-adv-label-wrap, .ai-adv-label, .ai-adv-label-text { animation: none !important; }
        }
      `}</style>

      {/* Nhãn 3D bay cạnh nút */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ai-adv-label-wrap fixed bottom-7 right-20 z-50 cursor-pointer"
          aria-hidden="true"
          tabIndex={-1}
        >
          <span className="ai-adv-label block px-3.5 py-2 rounded-2xl bg-neutral-900/95 border border-amber-200/40 shadow-[0_10px_30px_-8px_rgba(0,0,0,.55)]">
            <span className="ai-adv-label-text text-[13px] font-semibold tracking-wide whitespace-nowrap">
              ✨ Tìm kiếm trang phục thông minh
            </span>
          </span>
        </button>
      )}

      {/* Nút nổi */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label={open ? "Đóng tư vấn AI" : "Mở tư vấn AI"}
        className={cn(
          "fixed bottom-5 right-5 z-50 p-3.5 rounded-full transition-all",
          "bg-gradient-to-br from-neutral-900 via-neutral-800 to-rose-950 text-amber-100",
          "hover:scale-110 active:scale-95",
          !open && "ai-adv-btn",
          open && "shadow-lg",
        )}
      >
        {open ? <X className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
        {!open && (
          <>
            <span className="ai-adv-spark text-[10px]" style={{ top: "-4px", right: "2px", animationDelay: "0s" }}>✦</span>
            <span className="ai-adv-spark text-[8px]" style={{ bottom: "-2px", left: "-4px", animationDelay: ".6s" }}>✦</span>
            <span className="ai-adv-spark text-[12px]" style={{ top: "8px", left: "-9px", animationDelay: "1.2s" }}>✦</span>
            <span className="ai-adv-spark text-[9px]" style={{ bottom: "10px", right: "-8px", animationDelay: ".9s" }}>✦</span>
          </>
        )}
      </button>

      {/* Panel chat */}
      {open && (
        <div
          className={cn(
            "fixed z-50 bottom-20 right-5 w-[min(380px,calc(100vw-2.5rem))]",
            "h-[min(540px,calc(100dvh-7rem))] flex flex-col",
            "rounded-2xl border border-neutral-200 bg-white shadow-2xl overflow-hidden",
          )}
        >
          <div className="px-4 py-3 border-b border-neutral-100 bg-stone-50 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-neutral-700 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-neutral-900">Tư vấn hình ảnh</div>
              <div className="text-[11px] text-neutral-500 truncate">
                {module && !searchAll ? (
                  <>Đang tìm trong: <span className="font-medium text-neutral-800">{module.label}</span></>
                ) : (
                  "Tìm trong toàn bộ studio"
                )}
              </div>
            </div>
            {module && (
              <button
                type="button"
                role="switch"
                aria-checked={searchAll}
                onClick={() => setSearchAll(v => !v)}
                title="Bật để tìm khắp studio: váy, bộ ảnh mẫu, ý tưởng chụp, gói dịch vụ"
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11px] flex-shrink-0 transition-colors",
                  searchAll
                    ? "bg-neutral-900 text-amber-100 border-neutral-900"
                    : "bg-white text-neutral-500 border-neutral-200 hover:border-neutral-400",
                )}
              >
                <Globe className="w-3 h-3" />
                Toàn studio
                <span className={cn("relative w-6 h-3.5 rounded-full transition-colors", searchAll ? "bg-amber-300/90" : "bg-neutral-200")}>
                  <span className={cn(
                    "absolute top-[2px] w-2.5 h-2.5 rounded-full bg-white shadow transition-all",
                    searchAll ? "left-3" : "left-[2px]",
                  )} />
                </span>
              </button>
            )}
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {/* Thanh đổi tiêu chí — luôn nổi phía trên danh sách kết quả */}
            {messages.length > 0 && chipGroups.length > 0 && (
              <div className="sticky top-0 z-10 -mx-3 -mt-3 px-3 pt-2.5 pb-2 bg-white/95 backdrop-blur-sm border-b border-neutral-100 space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowFilters(v => !v)}
                    aria-expanded={showFilters}
                    className={cn(
                      "inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors",
                      showFilters
                        ? "bg-neutral-900 text-amber-100 border-neutral-900"
                        : "border-neutral-300 text-neutral-700 hover:border-neutral-900 hover:text-neutral-900",
                    )}
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    {showFilters ? "Ẩn tiêu chí" : `Đổi tiêu chí${picked.size > 0 ? ` (${picked.size})` : ""}`}
                  </button>
                  {!showFilters && picked.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setPicked(new Set())}
                      className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-neutral-200 text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors"
                    >
                      <Eraser className="w-3.5 h-3.5" />
                      Xoá lựa chọn
                    </button>
                  )}
                </div>
                {showFilters && (
                  <div className="space-y-2 max-h-56 overflow-y-auto pb-0.5">
                    {filterChipsPanel}
                  </div>
                )}
              </div>
            )}
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-sm text-neutral-600 px-1">
                  {module && !searchAll
                    ? <>Bạn đang ở mục <b>{module.label}</b> — mô tả điều bạn thích, mình tìm trong mục này nhé!</>
                    : "Bạn muốn tìm váy, bộ ảnh mẫu, ý tưởng chụp hay gói dịch vụ? Mô tả phong cách bạn thích nhé!"}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_PROMPTS[scopeKey].map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => void send(p)}
                      className="text-xs px-2.5 py-1.5 rounded-full border border-neutral-200 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900 transition-colors"
                    >
                      {p}
                    </button>
                  ))}
                </div>

                {/* Chip tiêu chí cho khách chưa quen mô tả — chọn nhiều rồi bấm tìm */}
                {chipGroups.length > 0 && (
                  <div className="pt-1.5 space-y-2 border-t border-dashed border-neutral-200">
                    <p className="text-[11px] text-neutral-400 px-1 pt-1">
                      Chưa biết tả sao? Chọn tiêu chí có sẵn rồi bấm tìm:
                    </p>
                    {filterChipsPanel}
                  </div>
                )}
              </div>
            )}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-neutral-900 text-white text-sm px-3.5 py-2">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="space-y-2">
                  {m.text && (
                    <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-stone-100 text-neutral-800 text-sm px-3.5 py-2 leading-relaxed">
                      {m.text}
                    </div>
                  )}
                  {!!m.items?.length && (
                    <div className="space-y-1.5">
                      {m.items.map(it => (
                        <ResultCard key={`${it.sourceType}-${it.id}`} item={it} onNavigate={() => setOpen(false)} />
                      ))}
                    </div>
                  )}
                  {m.ideasLocked && (
                    <Link
                      href={m.ideasLink || "/y-tuong-chup-anh"}
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-2 p-2.5 rounded-xl border border-amber-200 bg-amber-50/60 text-amber-800 text-xs hover:border-amber-400 transition-colors"
                    >
                      <Lock className="w-3.5 h-3.5 flex-shrink-0" />
                      Mở mục Ý tưởng chụp ảnh và nhập mật khẩu để xem chi tiết
                    </Link>
                  )}
                  {m.retryAllQuery && (
                    <button
                      type="button"
                      onClick={() => { setSearchAll(true); void send(m.retryAllQuery!, { forceAll: true }); }}
                      className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-neutral-300 text-neutral-700 hover:border-neutral-900 hover:text-neutral-900 transition-colors"
                    >
                      <Globe className="w-3.5 h-3.5" />
                      Tìm lại trong toàn bộ studio
                    </button>
                  )}
                </div>
              ),
            )}

            {loading && (
              <div className="flex items-center gap-2 text-neutral-500 text-sm px-1">
                <Loader2 className="w-4 h-4 animate-spin" />
                {module && !searchAll ? `Đang tìm trong ${module.label}…` : "Đang tìm khắp studio…"}
              </div>
            )}
          </div>

          <form
            className="border-t border-neutral-100 p-2.5 flex gap-2"
            onSubmit={e => { e.preventDefault(); void send(input); }}
          >
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={INPUT_PLACEHOLDER[scopeKey]}
              maxLength={500}
              className="flex-1 text-sm px-3 py-2 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-900 bg-white"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              aria-label="Gửi"
              className="px-3 rounded-xl bg-neutral-900 text-white disabled:opacity-40 hover:bg-neutral-700 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}
