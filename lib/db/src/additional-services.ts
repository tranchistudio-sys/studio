/** Types for bookings.additional_services JSONB field */

export type AdditionalServiceStaff = {
  staffId: number;
  staffName: string;
  role: string;
  allocatedQty: number;
  castPerUnit?: number;
  castAmount: number;
};

export type AdditionalServiceLine = {
  id: string;
  title: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  unitLabel?: string;
  notes?: string;
  taskKey?: string;
  staffAssignments: AdditionalServiceStaff[];
};

export function calcAdditionalServicesTotal(lines: AdditionalServiceLine[]): number {
  return lines.reduce((sum, line) => sum + (line.totalPrice || 0), 0);
}

export function calcLineTotalPrice(qty: number, unitPrice: number): number {
  return Math.max(0, Math.round(qty * unitPrice));
}

export function calcStaffAllocatedTotal(staff: AdditionalServiceStaff[]): number {
  return staff.reduce((sum, s) => sum + (s.allocatedQty || 0), 0);
}

export function validateAdditionalServices(lines: AdditionalServiceLine[]): {
  ok: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const line of lines) {
    const title = (line.title || "").trim();
    if (!title) {
      errors.push("Vui lòng nhập tên dịch vụ cộng thêm");
      continue;
    }
    const qty = Number(line.qty);
    const unitPrice = Number(line.unitPrice);
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`${title}: Số lượng phải lớn hơn 0`);
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      errors.push(`${title}: Đơn giá không hợp lệ`);
    }
    const allocated = calcStaffAllocatedTotal(line.staffAssignments || []);
    if (allocated > qty) {
      errors.push(`${title}: Vượt quá số lượng đã bán (${allocated}/${qty})`);
    } else if (allocated < qty) {
      warnings.push(`${title}: Còn ${qty - allocated} chưa phân công`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function sanitizeAdditionalServices(raw: unknown): AdditionalServiceLine[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((item) => {
    const row = item as Record<string, unknown>;
    const qty = Math.max(0, Math.round(Number(row.qty) || 0));
    const unitPrice = Math.max(0, Math.round(Number(row.unitPrice) || 0));
    const staffRaw = Array.isArray(row.staffAssignments) ? row.staffAssignments : [];

    const staffAssignments: AdditionalServiceStaff[] = staffRaw.map((s) => {
      const st = s as Record<string, unknown>;
      const allocatedQty = Math.max(0, Math.round(Number(st.allocatedQty) || 0));
      const castPerUnit = st.castPerUnit != null ? Math.round(Number(st.castPerUnit) || 0) : undefined;
      const castAmount = Math.round(Number(st.castAmount) || (castPerUnit != null ? castPerUnit * allocatedQty : 0));
      return {
        staffId: Math.round(Number(st.staffId) || 0),
        staffName: String(st.staffName || ""),
        role: String(st.role || "makeup"),
        allocatedQty,
        castPerUnit,
        castAmount,
      };
    }).filter((s) => s.staffId > 0 && s.allocatedQty > 0);

    return {
      id: String(row.id || cryptoRandomId()),
      title: String(row.title || "").trim(),
      qty: qty || 1,
      unitPrice,
      totalPrice: calcLineTotalPrice(qty || 1, unitPrice),
      unitLabel: row.unitLabel ? String(row.unitLabel) : "người",
      notes: row.notes ? String(row.notes) : undefined,
      taskKey: row.taskKey ? String(row.taskKey) : undefined,
      staffAssignments,
    };
  }).filter((line) => line.title);
}

function cryptoRandomId(): string {
  return `as-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
