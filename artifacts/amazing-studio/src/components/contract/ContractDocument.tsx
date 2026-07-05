/**
 * ContractDocument — bản hợp đồng/hóa đơn thống nhất, dùng chung cho:
 *  - trang nội bộ /contracts/:id  (mode="internal")
 *  - trang public  /contract/:token (mode="public")
 *
 * Component CHỈ hiển thị + gọi callback ký; KHÔNG tự gọi API.
 * Public mode: payload đã được backend lọc sạch (không ghi chú nội bộ, không người
 * thu tiền, không tên ekip, không lịch sử chỉnh sửa) — component không tự bù gì thêm.
 * Cấu trúc port từ generateContractHTML (calendar.tsx) sang JSX/Tailwind.
 */
import { useState } from "react";
import { formatVND } from "@/lib/utils";
import { parseDescriptionBlocks } from "@/lib/package-description";
import SignaturePad from "./SignaturePad";
import type { ContractPayload } from "./contract-types";

type ContractDocumentProps = {
  payload: ContractPayload;
  mode: "internal" | "public";
  /** internal: ký Bên A (chỉ hiện pad khi chưa có chữ ký studio) */
  onSignStudio?: (dataUrl: string) => void;
  signingStudio?: boolean;
  /** public: ký Bên B — chỉ hiện pad khi CHƯA ký, hoặc admin đã bật yêu cầu ký lại */
  onSignCustomer?: (dataUrl: string, name: string, phone: string) => void;
  signingCustomer?: boolean;
  /**
   * internal: Bên B ký qua link public /contract/<token> HOẶC ký tại tiệm (dialog ký sạch
   * trên máy nhân viên). Truyền các callback này để ô Bên B (khi chưa ký) hiện hướng dẫn
   * + nút copy/mở link khách ký + nút ký tại tiệm.
   */
  onCopyCustomerLink?: () => void;
  onOpenCustomerLink?: () => void;
  onSignCustomerInPerson?: () => void;
  customerLinkCopied?: boolean;
  customerLinkBusy?: boolean;
};

function fmtDate(d: string | null | undefined, fallback = "—"): string {
  if (!d) return fallback;
  const t = new Date(d);
  if (isNaN(t.getTime())) return fallback;
  return t.toLocaleDateString("vi-VN");
}

function methodLabel(m: string): string {
  return m === "bank_transfer" ? "Chuyển khoản" : "Tiền mặt";
}

function typeLabel(t: string): string {
  return t === "deposit" ? "Cọc" : "Thanh toán";
}

export default function ContractDocument({
  payload,
  mode,
  onSignStudio,
  signingStudio = false,
  onSignCustomer,
  signingCustomer = false,
  onCopyCustomerLink,
  onOpenCustomerLink,
  onSignCustomerInPerson,
  customerLinkCopied = false,
  customerLinkBusy = false,
}: ContractDocumentProps) {
  const { contract, studio, customer, services, money, payments, signatures } = payload;
  const isMulti = services.length > 1;
  const contractCode = contract.contractCode || `HD-${String(contract.id).padStart(4, "0")}`;

  // Form tên/SĐT cho khách ký Bên B (public)
  const [signerName, setSignerName] = useState(signatures.customer.name ?? customer.name ?? "");
  const [signerPhone, setSignerPhone] = useState(signatures.customer.phone ?? customer.phone ?? "");
  const [signerErr, setSignerErr] = useState<string | null>(null);

  const customerCanSign =
    mode === "public" && !!onSignCustomer && (payload.signState === "unsigned" || payload.resignRequested);
  const studioCanSign = mode === "internal" && !!onSignStudio && !signatures.studio.imageUrl;

  const handleCustomerConfirm = (dataUrl: string) => {
    const name = signerName.trim();
    const phone = signerPhone.trim();
    if (!name) { setSignerErr("Vui lòng nhập họ tên người ký."); return; }
    if (!phone) { setSignerErr("Vui lòng nhập số điện thoại."); return; }
    setSignerErr(null);
    onSignCustomer?.(dataUrl, name, phone);
  };

  const allProofImages = payments.flatMap((p) => p.proofImages);

  return (
    <div className="mx-auto max-w-[860px] bg-white text-[#2c2c2c] rounded-xl print:rounded-none p-6 sm:p-10 print:p-0 text-sm leading-relaxed">
      {/* Trạng thái */}
      <div className="mb-5 print:hidden">
        {payload.signState === "signed" ? (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 px-4 py-2.5 text-sm font-semibold">
            ✅ Đã ký xác nhận{signatures.customer.signedAt ? ` · ${fmtDate(signatures.customer.signedAt)}` : ""}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-800 px-4 py-2.5 text-sm font-semibold">
            ✍️ Hợp đồng chưa được ký
          </div>
        )}
        {mode === "public" && payload.resignRequested && payload.signState === "signed" ? (
          <div className="mt-2 rounded-lg border border-blue-300 bg-blue-50 text-blue-800 px-4 py-2.5 text-sm font-semibold">
            🔄 Studio đề nghị bạn ký xác nhận lại ở cuối trang.
          </div>
        ) : null}
        {mode === "internal" && payload.internal?.updatedAfterSign ? (
          <div className="mt-2 rounded-lg border border-orange-300 bg-orange-50 text-orange-800 px-4 py-2.5 text-sm font-semibold">
            ⚠️ Hợp đồng đã được cập nhật sau lần ký gần nhất (cảnh báo nội bộ — khách không thấy dòng này).
          </div>
        ) : null}
      </div>

      {/* Header studio */}
      <div className="flex items-start justify-between gap-4 pb-5 mb-7 border-b-2 border-[#222]">
        <div>
          <div className="text-2xl font-extrabold text-[#111] tracking-tight">✨ {studio.name}</div>
          <div className="text-xs text-[#555] mt-1">{studio.desc}</div>
          <div className="text-xs text-[#444] mt-1">📍 {studio.address}</div>
          <div className="text-xs text-[#444] mt-0.5">📞 {studio.phone}</div>
        </div>
        <div className="text-right min-w-[170px]">
          <div className="text-lg font-extrabold text-[#111] uppercase">Hóa Đơn Dịch Vụ</div>
          <div className="text-[13px] text-[#444] mt-2">
            Số HĐ: <strong className="text-[#111]">{contractCode}</strong>
          </div>
          <div className="text-[13px] text-[#444] mt-0.5">
            Ngày lập: <strong className="text-[#111]">{fmtDate(contract.createdAt)}</strong>
          </div>
        </div>
      </div>

      {/* 2 bên */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="border rounded-xl p-4">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#111] mb-2.5">
            🏢 Bên A — Cung cấp dịch vụ
          </div>
          <div className="font-bold text-[#111]">{studio.name}</div>
          <div className="text-xs text-[#444] mt-1">📍 {studio.address}</div>
          <div className="text-xs text-[#444] mt-0.5">📞 {studio.phone}</div>
        </div>
        <div className="border rounded-xl p-4">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#111] mb-2.5">
            👤 Bên B — Khách hàng
          </div>
          <div className="font-bold text-[#111]">{customer.name}</div>
          <div className="text-xs text-[#444] mt-1">📞 {customer.phone || "—"}</div>
        </div>
      </div>

      {/* Dịch vụ */}
      <div className="mb-6">
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#111] mb-3">💰 Dịch vụ đã đặt</div>
        {services.length === 0 ? (
          <div className="border rounded-xl p-4">
            <div className="flex justify-between items-start gap-4">
              <div className="font-bold text-[#111]">{contract.title || "—"}</div>
              <div className="font-extrabold text-[#111] whitespace-nowrap">{formatVND(contract.totalValue)}</div>
            </div>
          </div>
        ) : (
          services.map((svc, idx) => (
            <div key={svc.bookingId} className={isMulti ? "border rounded-xl p-4 mb-4" : ""}>
              {isMulti ? (
                <div className="border-l-4 border-[#222] pl-4 py-2 mb-3">
                  <div className="font-bold text-[#111]">
                    📋 {svc.serviceLabel || `Dịch vụ ${idx + 1}`}
                  </div>
                  {/* Ngày giờ chụp nổi bật — khách nhìn là thấy, không lộn ngày */}
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    {svc.shootTime ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-[#111] px-2 py-0.5 text-[13px] font-extrabold text-white tabular-nums">
                        🕐 {svc.shootTime.slice(0, 5)}
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1 rounded-md border border-[#111] bg-[#f7f7f7] px-2 py-0.5 text-[13px] font-extrabold text-[#111] tabular-nums">
                      📅 {fmtDate(svc.shootDate)}
                    </span>
                    {svc.location ? <span className="text-xs text-[#888]">📍 {svc.location}</span> : null}
                  </div>
                </div>
              ) : (
                // Ngày giờ chụp nổi bật — khách nhìn là thấy, không lộn ngày
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  {svc.shootTime ? (
                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-[#111] px-3 py-1.5 text-[15px] font-extrabold text-white tabular-nums">
                      🕐 {svc.shootTime.slice(0, 5)}
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-[#111] bg-[#f7f7f7] px-3 py-1.5 text-[15px] font-extrabold text-[#111] tabular-nums">
                    📅 Ngày chụp: {fmtDate(svc.shootDate)}
                  </span>
                  {svc.location ? <span className="text-xs text-[#666]">📍 {svc.location}</span> : null}
                </div>
              )}

              {svc.items.length === 0 ? (
                <div className="text-[13px] text-[#888] italic py-2">(Chưa có dịch vụ cụ thể)</div>
              ) : (
                svc.items.map((item, i) => (
                  <div key={i} className="border rounded-lg p-4 mb-3 bg-white">
                    <div className="flex justify-between items-start gap-4">
                      <div className="flex-1">
                        <div className="font-bold text-[15px] text-[#111]">{item.name}</div>
                        {item.description ? (
                          // Trình bày lại nội dung gói cho dễ đọc — GIỮ NGUYÊN từng chữ,
                          // chỉ nhấn đậm tiêu đề, canh gạch đầu dòng, nối câu bị bẻ dòng cứng.
                          <div className="text-xs text-[#444] mt-1.5 space-y-0.5">
                            {parseDescriptionBlocks(item.description).map((b, bi) =>
                              b.type === "divider" ? (
                                <div key={bi} className="border-t border-[#ddd] my-2" aria-hidden />
                              ) : b.type === "heading" ? (
                                <div key={bi} className="font-bold text-[#111] pt-1.5 first:pt-0">{b.text}</div>
                              ) : b.type === "bullet" ? (
                                <div key={bi} className="pl-4 -indent-4 leading-relaxed">{b.text}</div>
                              ) : (
                                <div key={bi} className="leading-relaxed pt-0.5 first:pt-0">{b.text}</div>
                              ),
                            )}
                          </div>
                        ) : null}
                      </div>
                      <div className="font-extrabold text-[#111] whitespace-nowrap">{formatVND(item.price)}</div>
                    </div>
                    {mode === "internal" && (item.photoName || item.makeupName) ? (
                      <div className="mt-2 rounded-md bg-blue-50 px-2.5 py-1.5 text-xs text-[#555]">
                        {item.photoName ? <>📷 Nhiếp ảnh: <strong>{item.photoName}</strong></> : null}
                        {item.photoName && item.makeupName ? "  |  " : null}
                        {item.makeupName ? <>💄 Makeup: <strong>{item.makeupName}</strong></> : null}
                      </div>
                    ) : null}
                    {item.deductions.length > 0 ? (
                      <div className="mt-2.5 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
                        <div className="text-[10.5px] font-bold uppercase tracking-wider text-red-700 mb-1">
                          ⬇ Giảm trừ dịch vụ:
                        </div>
                        {item.deductions.map((d, di) => (
                          <div key={di} className="flex justify-between text-[13px] text-red-700 py-0.5">
                            <span>− {d.label}</span>
                            <span className="font-semibold">−{formatVND(d.amount)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {item.surcharges.length > 0 ? (
                      <div className="mt-2">
                        {item.surcharges.map((s, si) => (
                          <div key={si} className="flex justify-between text-[13px] text-red-700 bg-red-50 rounded-md px-2.5 py-1 mb-1">
                            <span>+ {s.name}</span>
                            <span className="font-semibold">{formatVND(s.amount)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}

              {svc.surcharges.length > 0 ? (
                <div className="mt-1">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-red-700 mb-1.5">
                    Phụ thu / Phát sinh:
                  </div>
                  {svc.surcharges.map((s, si) => (
                    <div key={si} className="flex justify-between text-[13px] text-red-700 bg-red-50 rounded-md px-2.5 py-1.5 mb-1">
                      <span>+ {s.name}</span>
                      <span className="font-semibold">{formatVND(s.amount)}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {isMulti ? (
                <div className="flex justify-end mt-2">
                  <div className="bg-muted rounded-lg px-4 py-2 text-[13px]">
                    Thành tiền: <strong className="text-[#111] text-[15px]">{formatVND(svc.totalAmount)}</strong>
                  </div>
                </div>
              ) : null}
            </div>
          ))
        )}

        {/* Card tổng tiền */}
        <div
          className="rounded-xl px-5 py-4 text-white"
          style={{ background: "#111", WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}
        >
          <div className="flex justify-between items-center mb-2">
            <span>Tổng tiền các dịch vụ</span>
            <span className="text-xl font-extrabold">{formatVND(money.totalAmount)}</span>
          </div>
          {money.discountAmount > 0 ? (
            <>
              <div className="flex justify-between text-[13px] mb-1.5">
                <span className="opacity-90">🎁 Giảm giá chung hợp đồng</span>
                <span className="font-semibold">-{formatVND(money.discountAmount)}</span>
              </div>
              <div className="h-px bg-white/25 my-1.5" />
              <div className="flex justify-between text-[13.5px] mb-1.5">
                <span className="opacity-90">Tổng sau giảm</span>
                <span className="font-bold">{formatVND(Math.max(0, money.totalAmount - money.discountAmount))}</span>
              </div>
            </>
          ) : null}
          <div className="flex justify-between text-[13.5px] mb-1.5">
            <span className="opacity-90">✅ Đã cọc / Đã thu</span>
            <span className="font-semibold">{formatVND(money.paidAmount)}</span>
          </div>
          <div className="h-px bg-white/25 my-1.5" />
          <div className="flex justify-between items-center">
            <span className="opacity-90">💰 Còn lại cần thanh toán</span>
            <span className="font-extrabold text-[17px]">{formatVND(money.remainingAmount)}</span>
          </div>
        </div>
      </div>

      {/* Lịch sử thanh toán */}
      {payments.length > 0 ? (
        <div className="mb-6" style={{ breakInside: "avoid" }}>
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#111] mb-2.5">
            🧾 Lịch sử thanh toán
          </div>
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-muted">
                <th className="px-3 py-2 text-left font-bold border-b-2 border-[#999]">Ngày</th>
                <th className="px-3 py-2 text-left font-bold border-b-2 border-[#999]">Loại</th>
                <th className="px-3 py-2 text-left font-bold border-b-2 border-[#999]">Hình thức</th>
                {mode === "internal" ? (
                  <th className="px-3 py-2 text-left font-bold border-b-2 border-[#999]">Người thu</th>
                ) : null}
                <th className="px-3 py-2 text-right font-bold border-b-2 border-[#999]">Số tiền</th>
                <th className="px-3 py-2 text-right font-bold border-b-2 border-[#999]">Còn lại</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                let running = 0;
                return payments.map((p, idx) => {
                  running += p.amount;
                  const rowRemaining = Math.max(0, money.totalAmount - money.discountAmount - running);
                  return (
                    <tr key={idx} className={idx % 2 === 1 ? "bg-muted/40" : ""}>
                      <td className="px-3 py-1.5 border-b">{fmtDate(p.paidDate || p.paidAt)}</td>
                      <td className="px-3 py-1.5 border-b">{typeLabel(p.paymentType)}</td>
                      <td className="px-3 py-1.5 border-b">{methodLabel(p.paymentMethod)}</td>
                      {mode === "internal" ? (
                        <td className="px-3 py-1.5 border-b text-[#444]">{p.collectorName || "—"}</td>
                      ) : null}
                      <td className="px-3 py-1.5 border-b text-right font-bold text-emerald-700">
                        +{formatVND(p.amount)}
                      </td>
                      <td className="px-3 py-1.5 border-b text-right font-bold text-[#111]">
                        {formatVND(rowRemaining)}
                      </td>
                    </tr>
                  );
                });
              })()}
              <tr className="bg-emerald-50">
                <td colSpan={mode === "internal" ? 5 : 4} className="px-3 py-2 font-bold text-emerald-700">
                  Tổng đã thu
                </td>
                <td className="px-3 py-2 text-right font-extrabold text-emerald-700">
                  {formatVND(money.paidAmount)}
                </td>
              </tr>
            </tbody>
          </table>

          {/* Ảnh xác nhận thanh toán (ảnh cọc / chuyển khoản) — minh bạch cho khách đối chiếu */}
          {allProofImages.length > 0 ? (
            <div className="mt-3">
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#111] mb-2">
                📸 Ảnh xác nhận thanh toán
              </div>
              <div className="flex flex-wrap gap-2">
                {allProofImages.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noreferrer" className="block">
                    {/* Không lazy: ảnh cọc là bằng chứng thanh toán, phải chắc chắn hiển thị cho khách */}
                    <img
                      src={url}
                      alt={`Ảnh xác nhận thanh toán ${i + 1}`}
                      className="h-24 w-24 object-cover rounded-lg border hover:opacity-85"
                    />
                  </a>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Ghi chú nội bộ — CHỈ internal */}
      {mode === "internal" && payload.internal?.notes ? (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 print:hidden">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-amber-700 mb-1.5">
            📝 Ghi chú nội bộ (khách không thấy)
          </div>
          <div className="text-[13px] text-[#555] whitespace-pre-wrap">{payload.internal.notes}</div>
        </div>
      ) : null}

      {/* Điều khoản */}
      <div className="mb-8" style={{ breakInside: "avoid" }}>
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#111] mb-2.5">
          📋 Điều khoản &amp; cam kết
        </div>
        <div className="rounded-xl border bg-muted/30 px-5 py-4 text-[12.5px] text-[#444] leading-[1.85]">
          {contract.content ? (
            <div className="whitespace-pre-wrap">{contract.content}</div>
          ) : (
            <>
              <p className="mb-1.5">✅ Bên A cam kết thực hiện đầy đủ dịch vụ theo nội dung đã thống nhất.</p>
              <p className="mb-1.5">✅ Khách thanh toán 100% chi phí còn lại ngay sau buổi chụp để nhận file.</p>
              <p className="mb-2.5">✅ Chưa thanh toán đủ, studio có quyền giữ sản phẩm.</p>
              <p className="font-bold text-[#333] mb-1">📅 Dời / hủy lịch:</p>
              <ul className="list-disc ml-5 mb-2.5">
                <li>Dời 1 lần miễn phí nếu báo trước ≥ 3 ngày.</li>
                <li>Báo trễ / dời nhiều lần: có thể phát sinh phí.</li>
                <li>Hủy lịch: <strong>không hoàn cọc.</strong></li>
              </ul>
              <p className="font-bold text-[#333] mb-1">👗 Trang phục:</p>
              <ul className="list-disc ml-5 mb-2.5">
                <li>Khách giữ gìn váy, vest, phụ kiện trong suốt buổi chụp.</li>
                <li>Hư hỏng / dơ nặng → đền bù theo thực tế.</li>
              </ul>
              <p className="font-bold text-[#333] mb-1">📦 Giao sản phẩm:</p>
              <ul className="list-disc ml-5 mb-2.5">
                <li>Studio giao đúng thời gian cam kết.</li>
                <li>Yêu cầu gấp → có thể tính phí.</li>
              </ul>
              <p className="font-bold text-[#333] mb-1">⚡ Phát sinh:</p>
              <ul className="list-disc ml-5 mb-2.5">
                <li>Các yêu cầu ngoài gói sẽ tính phí riêng.</li>
              </ul>
              <p className="italic text-[#666] mt-1.5">Hai bên xác nhận và đồng ý toàn bộ nội dung hóa đơn dịch vụ này.</p>
            </>
          )}
        </div>
      </div>

      {/* Chữ ký */}
      <div style={{ breakInside: "avoid" }}>
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#111] mb-3.5">
          ✍️ Xác nhận &amp; ký tên
        </div>

        {/* Form tên/SĐT khi khách được ký */}
        {customerCanSign ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4 print:hidden">
            <div>
              <label className="block text-xs font-bold text-[#444] mb-1.5">Họ và tên người ký *</label>
              <input
                type="text"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="Nhập họ và tên đầy đủ"
                autoComplete="name"
                className="w-full rounded-lg border px-3.5 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[#444] mb-1.5">Số điện thoại *</label>
              <input
                type="tel"
                value={signerPhone}
                onChange={(e) => setSignerPhone(e.target.value)}
                placeholder="Nhập số điện thoại"
                autoComplete="tel"
                className="w-full rounded-lg border px-3.5 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            {signerErr ? (
              <div className="sm:col-span-2 text-xs font-semibold text-destructive">{signerErr}</div>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-10">
          {/* Bên A */}
          {studioCanSign ? (
            <SignaturePad
              value={null}
              label="Bên A – Amazing Studio"
              signerLine="Đại diện ký tên"
              onConfirm={(dataUrl) => onSignStudio?.(dataUrl)}
              confirming={signingStudio}
            />
          ) : (
            <div className="rounded-xl border border-dashed p-5 text-center">
              <div className="text-[13px] font-bold text-[#111]">Bên A – Amazing Studio</div>
              <div className="text-[11.5px] text-[#888] mt-0.5">
                {mode === "internal" && signatures.studio.signedByName
                  ? `Đại diện: ${signatures.studio.signedByName}`
                  : "Đại diện ký tên"}
              </div>
              {signatures.studio.imageUrl ? (
                <>
                  <img
                    src={signatures.studio.imageUrl}
                    alt="Chữ ký Bên A"
                    className="mx-auto mt-3 max-h-[100px] max-w-full object-contain rounded-lg bg-white p-1.5 border"
                  />
                  <div className="text-[11.5px] font-bold italic text-emerald-700 mt-1.5">✅ Đã ký xác nhận</div>
                  <div className="text-xs text-[#666] mt-2">
                    {signatures.studio.signedAt ? `Ngày ${fmtDate(signatures.studio.signedAt)}` : ""}
                  </div>
                </>
              ) : (
                <>
                  <div className="h-[70px] border-b mx-6 mt-3 mb-2" />
                  <div className="text-[11.5px] italic text-[#888]">(Ký, ghi rõ họ tên)</div>
                  <div className="text-xs text-[#666] mt-2.5">Ngày ___/___/______</div>
                </>
              )}
            </div>
          )}

          {/* Bên B */}
          {customerCanSign ? (
            <SignaturePad
              value={null}
              label="Bên B – Khách hàng"
              signerLine={signerName || customer.name}
              onConfirm={handleCustomerConfirm}
              confirming={signingCustomer}
            />
          ) : (
            <div
              className={`rounded-xl p-5 text-center ${
                signatures.customer.imageUrl
                  ? "border border-emerald-300 bg-emerald-50/50"
                  : "border border-dashed"
              }`}
            >
              <div className="text-[13px] font-bold text-[#111]">Bên B – Khách hàng</div>
              <div className="text-[11.5px] text-[#888] mt-0.5">{signatures.customer.name || customer.name}</div>
              {signatures.customer.phone ? (
                <div className="text-[11px] text-[#aaa]">{signatures.customer.phone}</div>
              ) : null}
              {signatures.customer.imageUrl ? (
                <>
                  <img
                    src={signatures.customer.imageUrl}
                    alt="Chữ ký Bên B"
                    className="mx-auto mt-2 max-h-[100px] max-w-full object-contain rounded-lg bg-white p-1.5 border"
                  />
                  <div className="text-[11.5px] font-bold italic text-emerald-700 mt-1.5">✅ Đã ký xác nhận</div>
                  <div className="text-xs text-[#666] mt-2">
                    {signatures.customer.signedAt ? `Ngày ${fmtDate(signatures.customer.signedAt)}` : ""}
                  </div>
                </>
              ) : (
                <>
                  <div className="h-[70px] border-b mx-6 mt-3 mb-2" />
                  <div className="text-[11.5px] italic text-[#888]">(Ký, ghi rõ họ tên)</div>
                  <div className="text-xs text-[#666] mt-2.5">Ngày ___/___/______</div>
                  {mode === "internal" && (onCopyCustomerLink || onOpenCustomerLink || onSignCustomerInPerson) ? (
                    <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 print:hidden">
                      <div className="text-[11.5px] font-bold text-blue-800">
                        💡 Khách ký qua link hợp đồng online
                      </div>
                      <div className="text-[11px] text-blue-700/80 mt-0.5">
                        Gửi link cho khách — khách mở link, kéo xuống cuối và ký phần Bên B.
                        {onSignCustomerInPerson ? " Khách đang ở tiệm? Bấm “Khách ký tại tiệm” để khách ký ngay trên máy này." : ""}
                      </div>
                      <div className="mt-2 flex items-center justify-center gap-2 flex-wrap">
                        {onCopyCustomerLink ? (
                          <button
                            type="button"
                            onClick={onCopyCustomerLink}
                            disabled={customerLinkBusy}
                            className="rounded-md border border-blue-300 bg-white px-2.5 py-1.5 text-[11.5px] font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-60"
                            data-testid="btn-copy-customer-link"
                          >
                            {customerLinkCopied ? "✅ Đã sao chép!" : "🔗 Sao chép link khách ký"}
                          </button>
                        ) : null}
                        {onOpenCustomerLink ? (
                          <button
                            type="button"
                            onClick={onOpenCustomerLink}
                            disabled={customerLinkBusy}
                            className="rounded-md border border-blue-300 bg-white px-2.5 py-1.5 text-[11.5px] font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-60"
                            data-testid="btn-open-customer-link"
                          >
                            ↗️ Mở trang khách ký
                          </button>
                        ) : null}
                        {onSignCustomerInPerson ? (
                          <button
                            type="button"
                            onClick={onSignCustomerInPerson}
                            disabled={customerLinkBusy}
                            className="rounded-md border border-emerald-400 bg-emerald-600 px-2.5 py-1.5 text-[11.5px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                            data-testid="btn-sign-customer-in-person"
                          >
                            ✍️ Khách ký tại tiệm
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="text-center mt-9 pt-4 border-t text-[11px] text-[#999]">
        Hóa đơn được tạo bởi {studio.name} · {fmtDate(contract.createdAt)}
      </div>
    </div>
  );
}
