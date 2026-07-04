/**
 * contract-sign.tsx — trang hợp đồng PUBLIC cho khách (/contract/:token).
 * Khách mở link KHÔNG cần đăng nhập: xem hợp đồng mới nhất + thanh toán + ảnh cọc
 * + chữ ký 2 bên, và ký Bên B nếu chưa ký (hoặc studio chủ động yêu cầu ký lại).
 * Payload đã được backend lọc sạch — không lịch sử chỉnh sửa / ghi chú / dữ liệu nội bộ.
 * Trang standalone: không header/footer marketing, in ra sạch.
 */
import { useState } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ContractDocument from "@/components/contract/ContractDocument";
import type { ContractPayload } from "@/components/contract/contract-types";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function PublicContractSignPage() {
  const [, params] = useRoute("/contract/:token");
  const token = params?.token ?? "";
  const qc = useQueryClient();
  const [signError, setSignError] = useState<string | null>(null);
  const [justSigned, setJustSigned] = useState(false);

  const { data: payload, isLoading, error } = useQuery<ContractPayload>({
    queryKey: ["public-contract", token],
    queryFn: async () => {
      // Fetch thường, KHÔNG kèm token đăng nhập — trang dành cho khách.
      const r = await fetch(`${BASE}/api/public/contracts/by-token/${encodeURIComponent(token)}`);
      if (!r.ok) throw new Error(r.status === 404 ? "notfound" : `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!token,
    retry: false,
  });

  const signMutation = useMutation({
    mutationFn: async (v: { dataUrl: string; name: string; phone: string }) => {
      const r = await fetch(`${BASE}/api/public/contracts/by-token/${encodeURIComponent(token)}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signerName: v.name, signerPhone: v.phone, signatureData: v.dataUrl }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.error ?? "Không lưu được chữ ký. Vui lòng thử lại.");
      }
    },
    onSuccess: () => {
      setSignError(null);
      setJustSigned(true);
      qc.invalidateQueries({ queryKey: ["public-contract", token] });
    },
    onError: (e: Error) => setSignError(e.message),
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#faf7fb] flex items-center justify-center p-6">
        <div className="text-neutral-500">Đang tải hợp đồng...</div>
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div className="min-h-screen bg-[#faf7fb] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border p-8 text-center">
          <div className="text-4xl mb-3">📄</div>
          <div className="font-bold text-lg mb-1.5">Không tìm thấy hợp đồng</div>
          <div className="text-sm text-neutral-500">
            Link không đúng hoặc hợp đồng đã bị xóa. Vui lòng liên hệ Amazing Studio để nhận link mới.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf7fb] print:bg-white">
      {/* Header gọn cho khách — ẩn khi in */}
      <div className="print:hidden bg-white border-b">
        <div className="max-w-[900px] mx-auto px-4 py-3.5 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="font-extrabold text-[#8B1A6B]">✨ {payload.studio.name}</div>
            <div className="text-xs text-neutral-500">
              Hợp đồng <strong>{payload.contract.contractCode}</strong> · {payload.customer.name}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {payload.signState === "signed" ? (
              <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-700">
                ✅ Đã ký
              </span>
            ) : (
              <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-amber-100 text-amber-700">
                Chưa ký
              </span>
            )}
            <button
              onClick={() => window.print()}
              className="text-xs font-bold px-3 py-1.5 rounded-full border hover:bg-neutral-50"
            >
              🖨️ In / Lưu PDF
            </button>
          </div>
        </div>
      </div>

      {/* Thông báo sau khi ký thành công */}
      {justSigned ? (
        <div className="max-w-[900px] mx-auto px-4 pt-4 print:hidden">
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-800 px-4 py-3 text-sm font-semibold">
            ✅ Cảm ơn bạn! Chữ ký đã được lưu thành công. Hợp đồng đã có hiệu lực.
          </div>
        </div>
      ) : null}
      {signError ? (
        <div className="max-w-[900px] mx-auto px-4 pt-4 print:hidden">
          <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 px-4 py-3 text-sm font-semibold">
            ⚠️ {signError}
          </div>
        </div>
      ) : null}

      <div className="max-w-[900px] mx-auto p-3 sm:p-6 print:p-0 print:max-w-none">
        <div className="rounded-2xl border bg-white overflow-hidden print:border-0 print:rounded-none">
          <ContractDocument
            payload={payload}
            mode="public"
            onSignCustomer={(dataUrl, name, phone) => signMutation.mutate({ dataUrl, name, phone })}
            signingCustomer={signMutation.isPending}
          />
        </div>
      </div>

      <div className="print:hidden text-center text-[11px] text-neutral-400 pb-8">
        {payload.studio.name} · {payload.studio.phone} · Hệ thống hợp đồng online
      </div>
    </div>
  );
}
