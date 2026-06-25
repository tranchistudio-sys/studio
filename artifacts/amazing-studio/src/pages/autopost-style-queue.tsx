import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, ImagePlus, Loader2, CheckCircle2, XCircle, Clock, RotateCcw, X, AlertTriangle } from "lucide-react";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type JobImage = { dataBase64: string; mediaType: string };
type StyleJob = {
  id: number; status: "pending" | "processing" | "done" | "failed"; title: string;
  contentType: string | null; tone: string | null; priority: number; styleTopicLabel: string | null;
  imageCount: number; error: string | null; attempts: number; resultSampleId: number | null;
  createdAt: string; updatedAt: string;
};

const STATUS_META: Record<StyleJob["status"], { label: string; cls: string; Icon: typeof Clock }> = {
  pending:    { label: "Đang chờ",   cls: "bg-amber-100 text-amber-700",  Icon: Clock },
  processing: { label: "Đang xử lý", cls: "bg-sky-100 text-sky-700",      Icon: Loader2 },
  done:       { label: "Xong",       cls: "bg-emerald-100 text-emerald-700", Icon: CheckCircle2 },
  failed:     { label: "Lỗi",        cls: "bg-rose-100 text-rose-700",    Icon: XCircle },
};

function fileToBase64(file: File): Promise<JobImage> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ dataBase64: String(fr.result).replace(/^data:[^;]+;base64,/, ""), mediaType: file.type || "image/jpeg" });
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

export default function AutopostStyleQueuePage() {
  const qc = useQueryClient();
  const { effectiveIsAdmin } = useStaffAuth();
  const token = localStorage.getItem("amazingStudioToken_v2");
  const authHeaders = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const fileRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [images, setImages] = useState<JobImage[]>([]);
  const [contentType, setContentType] = useState("other");
  const [err, setErr] = useState<string | null>(null);

  // Poll danh sách job mỗi 3s để cập nhật trạng thái pending → processing → done/failed.
  const { data: jobs = [] } = useQuery<StyleJob[]>({
    queryKey: ["autopost-style-jobs"],
    queryFn: () => fetch(`${BASE}/api/autopost/style-samples/jobs`, { headers: authHeaders }).then(r => r.ok ? r.json() : { jobs: [] }).then(d => d.jobs ?? []),
    refetchInterval: 3000,
    enabled: effectiveIsAdmin,
  });

  const createJob = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetch(`${BASE}/api/autopost/style-samples/jobs`, { method: "POST", headers: authHeaders, body: JSON.stringify(body) })
        .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Lỗi ${r.status}`); return r.json(); }),
    onSuccess: () => {
      // Reset form để admin thêm bài tiếp theo NGAY (không chờ AI).
      setTitle(""); setPastedText(""); setImages([]); setErr(null);
      qc.invalidateQueries({ queryKey: ["autopost-style-jobs"] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const retryJob = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/autopost/style-samples/jobs/${id}/retry`, { method: "POST", headers: authHeaders, body: "{}" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost-style-jobs"] }),
  });

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files).slice(0, 10 - images.length);
    const converted = await Promise.all(arr.map(fileToBase64));
    setImages(prev => [...prev, ...converted].slice(0, 10));
  };

  const submit = () => {
    setErr(null);
    if (!title.trim()) { setErr("Cần nhập tiêu đề"); return; }
    if (!pastedText.trim() && images.length === 0) { setErr("Cần ít nhất 1 ảnh để đọc, hoặc nội dung dán sẵn"); return; }
    createJob.mutate({ title: title.trim(), contentType, pastedText: pastedText.trim() || undefined, images });
  };

  if (!effectiveIsAdmin) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4" /> Chỉ admin được dùng Văn phong mẫu.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-violet-500" /> Học Văn phong mẫu (hàng chờ)
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Thêm bài mẫu / đọc từ ảnh <b>không phải chờ AI</b> — tạo job vào hàng chờ, worker nền tự xử lý. Thêm liên tục bao nhiêu bài cũng được.
        </p>
      </div>

      {/* Form thêm bài mẫu */}
      <div className="bg-card border rounded-2xl p-4 space-y-3">
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Tiêu đề bài mẫu *"
          className="w-full px-3 py-2 border rounded-xl bg-background text-sm" />
        <textarea value={pastedText} onChange={e => setPastedText(e.target.value)} rows={3}
          placeholder="Dán nội dung bài mẫu (nếu có). Hoặc tải ảnh chụp bài để AI đọc chữ."
          className="w-full px-3 py-2 border rounded-xl bg-background text-sm resize-none" />
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { onPickFiles(e.target.files); e.target.value = ""; }} />
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((_, i) => (
              <span key={i} className="text-xs bg-muted px-2 py-1 rounded-lg flex items-center gap-1">
                Ảnh {i + 1}
                <button onClick={() => setImages(prev => prev.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-rose-500"><X className="w-3 h-3" /></button>
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => fileRef.current?.click()} disabled={images.length >= 10}
            className="flex items-center gap-1.5 text-sm border px-3 py-2 rounded-xl hover:bg-muted disabled:opacity-50">
            <ImagePlus className="w-4 h-4" /> Thêm ảnh ({images.length}/10)
          </button>
          <button onClick={submit} disabled={createJob.isPending}
            className="flex items-center gap-1.5 text-sm bg-violet-600 text-white px-4 py-2 rounded-xl hover:bg-violet-700 disabled:opacity-50 ml-auto">
            {createJob.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Học bài mẫu này
          </button>
        </div>
        {err && <p className="text-xs text-rose-600">{err}</p>}
      </div>

      {/* Hàng chờ job */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-2">Hàng chờ xử lý ({jobs.length})</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có job nào.</p>
        ) : (
          <div className="space-y-2">
            {jobs.map(j => {
              const m = STATUS_META[j.status];
              return (
                <div key={j.id} className="flex items-center gap-3 p-3 border rounded-xl bg-card">
                  <span className={`text-[11px] font-bold px-2 py-1 rounded-full flex items-center gap-1 ${m.cls}`}>
                    <m.Icon className={`w-3.5 h-3.5 ${j.status === "processing" ? "animate-spin" : ""}`} /> {m.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{j.title}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {j.imageCount > 0 ? `${j.imageCount} ảnh · ` : ""}{j.contentType || "—"}
                      {j.status === "done" && j.resultSampleId ? ` · đã lưu vào kho (#${j.resultSampleId})` : ""}
                      {j.status === "failed" && j.error ? ` · ${j.error}` : ""}
                    </p>
                  </div>
                  {j.status === "failed" && (
                    <button onClick={() => retryJob.mutate(j.id)} disabled={retryJob.isPending}
                      className="flex items-center gap-1 text-xs text-rose-600 border border-rose-200 px-2.5 py-1.5 rounded-lg hover:bg-rose-50 disabled:opacity-50 shrink-0">
                      <RotateCcw className="w-3.5 h-3.5" /> Thử lại
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
