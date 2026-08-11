import { useState } from "react";

type Props = { open: boolean; onClose: () => void };
export default function X20SettingsDrawer({ open, onClose }: Props) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState("CHƯA KIỂM TRA");
  const [detail, setDetail] = useState("");
  if (!open) return null;
  const close = () => { setKey(""); onClose(); };
  async function test() {
    if (!key) { setStatus("KẾT NỐI THẤT BẠI"); setDetail("Vui lòng nhập API key mới."); return; }
    setStatus("ĐANG KIỂM TRA");
    try {
      const r = await fetch("/api/x20/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: key, model: "gpt-5.6-sol", reasoningEffort: "xhigh" }) });
      const d = await r.json(); setKey("");
      setStatus(d.ok ? "KẾT NỐI THÀNH CÔNG" : (d.inference === "OUTPUT EMPTY" ? "OUTPUT EMPTY" : "KẾT NỐI THẤT BẠI"));
      setDetail(`Authentication: ${d.authentication || "FAIL"}\nModel: ${d.model || "gpt-5.6-sol"}\nLatency: ${d.latency ?? "-"} ms\nOutput: ${d.output || "(trống)"}`);
    } catch { setKey(""); setStatus("KẾT NỐI THẤT BẠI"); setDetail("Không thể kết nối preview endpoint."); }
  }
  return <div className="fixed inset-0 z-50 bg-black/40" role="dialog" aria-label="Cài đặt X20"><aside className="absolute right-0 top-0 h-full w-full max-w-md overflow-auto bg-background p-6 shadow-xl sm:rounded-l-2xl"><button onClick={close} className="rounded border px-3 py-2">Đóng</button><h2 className="mt-5 text-2xl font-bold">Cài đặt X20</h2><p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm">Giao diện X20 đang ở chế độ thử nghiệm. API key thật chưa được lưu.</p><label className="mt-4 block text-sm font-semibold">Provider</label><input className="mt-1 w-full rounded border bg-muted p-2" value="AMAZINGSTUDIO / X20" readOnly/><label className="mt-4 block text-sm font-semibold">API Base URL</label><input className="mt-1 w-full rounded border bg-muted p-2" value="https://llm.14k7-homelab.io.vn/v1" readOnly/><label className="mt-4 block text-sm font-semibold">Model</label><input className="mt-1 w-full rounded border bg-muted p-2" value="gpt-5.6-sol" readOnly/><label className="mt-4 block text-sm font-semibold">Reasoning effort</label><input className="mt-1 w-full rounded border bg-muted p-2" value="xhigh" readOnly/><label className="mt-4 block text-sm font-semibold">API Key</label><div className="mt-1 flex gap-2"><input className="w-full rounded border bg-background p-2" type={show ? "text" : "password"} value={key} onChange={e=>setKey(e.target.value)} autoComplete="new-password"/><button onClick={()=>setShow(!show)} className="rounded border px-3">{show ? "Ẩn" : "Hiện"}</button></div><div className="mt-5 flex gap-2"><button onClick={test} className="rounded bg-primary px-4 py-2 font-semibold text-primary-foreground">Kiểm tra kết nối</button><button onClick={()=>{setKey("");setStatus("CHƯA KIỂM TRA");setDetail("")}} className="rounded border px-4 py-2">Xóa key</button></div><p className="mt-4 rounded-full bg-muted px-3 py-2 text-sm font-semibold">{status}</p>{detail&&<pre className="mt-3 whitespace-pre-wrap rounded bg-muted p-3 text-sm">{detail}</pre>}<p className="mt-4 text-xs text-muted-foreground">Key chỉ ở trong bộ nhớ request, không lưu localStorage, database, task JSON hoặc log.</p></aside></div>;
}
