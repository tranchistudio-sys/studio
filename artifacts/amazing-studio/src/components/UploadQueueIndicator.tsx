import { useState, useRef, useEffect } from "react";
import { CloudUpload, Loader2, CheckCircle2, AlertCircle, RotateCcw, X } from "lucide-react";
import { useUploadQueue, uploadQueueStore } from "@/contexts/UploadQueueContext";
import { cn } from "@/lib/utils";

export function UploadQueueIndicator() {
  const jobs = useUploadQueue();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const active = jobs.filter(j => j.status === "pending" || j.status === "uploading");
  const failed = jobs.filter(j => j.status === "failed");
  const recent = jobs.slice(0, 12);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!jobs.length) return null;

  const label = active.length
    ? `Đang tải ${active.length} ảnh…`
    : failed.length
      ? `${failed.length} ảnh lỗi`
      : "Upload xong";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border transition-colors",
          active.length ? "border-primary/40 bg-primary/10 text-primary" : failed.length ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-muted text-muted-foreground",
        )}
        title={label}
      >
        {active.length ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
        <span className="hidden sm:inline max-w-[120px] truncate">{label}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-80 sm:w-96 bg-popover border rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 border-b bg-muted/40 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ảnh đang tải</span>
            <span className="text-[10px] text-muted-foreground">{active.length} đang chạy · {failed.length} lỗi</span>
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-border">
            {recent.map(job => (
              <div key={job.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                <div className="w-10 h-10 rounded-md overflow-hidden bg-muted flex-shrink-0">
                  {job.previewUrl && <img src={job.previewUrl} alt="" className="w-full h-full object-cover" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{job.fileName}</p>
                  <p className="text-muted-foreground truncate">
                    {job.status === "uploading" && `${job.progress}% · đang tải…`}
                    {job.status === "pending" && "Chờ tải…"}
                    {job.status === "uploaded" && "Đã xong"}
                    {job.status === "failed" && (job.error ?? "Lỗi")}
                  </p>
                </div>
                {job.status === "uploaded" && <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />}
                {job.status === "failed" && (
                  <button type="button" onClick={() => uploadQueueStore.retryJob(job.id)} className="p-1 hover:bg-muted rounded" title="Thử lại">
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
                {(job.status === "uploaded" || job.status === "failed") && (
                  <button type="button" onClick={() => uploadQueueStore.removeJob(job.id)} className="p-1 hover:bg-muted rounded" title="Xoá">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
                {job.status === "failed" && <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
