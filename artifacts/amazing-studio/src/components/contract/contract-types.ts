/**
 * contract-types.ts — types payload hợp đồng online, mirror đúng shape trả về từ
 * api-server/src/lib/contractPayload.ts (buildContractPayload).
 *
 * mode "public": các field nội bộ (photoName/makeupName, collectorName, notes,
 * internal) LUÔN là null — backend đã lọc, frontend không được tự bù.
 */

export type ContractServiceItem = {
  name: string;
  description: string | null;
  price: number;
  deductions: { label: string; amount: number }[];
  surcharges: { name: string; amount: number }[];
  /** internal only — public luôn null */
  photoName: string | null;
  /** internal only — public luôn null */
  makeupName: string | null;
};

export type ContractService = {
  bookingId: number;
  orderCode: string | null;
  serviceLabel: string | null;
  shootDate: string | null;
  shootTime: string | null;
  location: string | null;
  totalAmount: number;
  surcharges: { name: string; amount: number }[];
  items: ContractServiceItem[];
  /** Ngày thực hiện PHỤ của dịch vụ này (ngày 2..n) — chip đầu HĐ hiện đủ các ngày.
   *  Optional để tương thích payload cũ/bản ký đóng băng (thiếu ⇒ chỉ chip ngày chính). */
  occurrences?: {
    date: string;
    time: string | null;
    label: string | null;
    /** Ngày studio thêm SAU khi khách ký — vẫn hiện, nhưng ghi chú rõ là bổ sung. */
    addedAfterSign?: boolean;
  }[];
};

export type ContractPaymentRow = {
  paidAt: string | null;
  paidDate: string | null;
  amount: number;
  paymentMethod: string;
  paymentType: string;
  /** Ảnh cọc / chuyển khoản — bằng chứng thanh toán, khách được xem */
  proofImages: string[];
  /** internal only — public luôn null */
  collectorName: string | null;
  /** internal only — public luôn null */
  notes: string | null;
};

export type ContractPayload = {
  contract: {
    id: number;
    contractCode: string | null;
    title: string;
    content: string;
    status: string;
    createdAt: string;
    signedAt: string | null;
    expiresAt: string | null;
    totalValue: number;
  };
  studio: { name: string; desc: string; address: string; phone: string };
  customer: { name: string; phone: string | null };
  services: ContractService[];
  // Lịch thực hiện: ngày chính + ngày phụ (booking_occurrences). Chỉ hiển thị, không tiền.
  schedule?: { date: string; time: string | null; label: string | null }[];
  money: {
    totalAmount: number;
    discountAmount: number;
    paidAmount: number;
    remainingAmount: number;
  };
  payments: ContractPaymentRow[];
  signatures: {
    customer: {
      imageUrl: string | null;
      name: string | null;
      phone: string | null;
      signedAt: string | null;
    };
    studio: {
      imageUrl: string | null;
      signedAt: string | null;
      /** internal only — public luôn null */
      signedByName: string | null;
    };
  };
  signState: "unsigned" | "signed";
  /** Admin chủ động bật "Yêu cầu khách ký lại" — public dùng để mở lại ô ký Bên B */
  resignRequested: boolean;
  /** CHỈ có ở internal mode; public luôn null */
  internal: {
    notes: string | null;
    bookingId: number | null;
    customerId: number;
    publicToken: string | null;
    updatedAfterSign: boolean;
  } | null;
};

export type ContractChangeLogRow = {
  id: number;
  fieldChanged: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  changedByName: string | null;
  createdAt: string;
};
