/**
 * Helper THUẦN cho trang "Kịch bản tư vấn Lulu" — tách khỏi component để unit-test được.
 * Nhãn tiếng Việt lấy từ API /lulu-scenarios/status (1 nguồn sự thật ở backend).
 */

export type ScenarioConditions = {
  serviceIntent: "known" | "unknown" | "any";
  dateStatus: "known" | "not_decided" | "unset" | "any";
  quoted: "yes" | "no" | "any";
  firstContact: "yes" | "no" | "any";
};

export type ScenarioCard = {
  name: string;
  description: string;
  triggers: string[];
  conditions: ScenarioConditions;
  requiredSlots: Array<"service_intent" | "event_date">;
  primaryAction: string;
  guidance: string;
  forbiddenExtra: string[];
  knowledge: string[];
  closingLine: string;
  exitConditions: string[];
  nextScenarios: Array<{ whenVn: string; scenarioKey: string }>;
};

export type ScenarioRecord = {
  id: number;
  scenarioKey: string;
  sortOrder: number;
  status: "draft" | "active" | "archived";
  enabled: boolean;
  isCore: boolean;
  version: number;
  card: ScenarioCard | null;
  draftCard: ScenarioCard | null;
  runCount: number;
  lastRunAt: string | null;
  lastTestResult: string | null;
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioLabels = {
  triggers: Record<string, string>;
  conditions: {
    serviceIntent: Record<string, string>;
    dateStatus: Record<string, string>;
    quoted: Record<string, string>;
    firstContact: Record<string, string>;
  };
  actions: Record<string, string>;
  forbidden: Record<string, string>;
  knowledge: Record<string, string>;
  loserReasons: Record<string, string>;
  coreForbidden: string[];
};

/** Thẻ trống để tạo mới (điều kiện đều "không bắt buộc"). */
export function emptyCard(): ScenarioCard {
  return {
    name: "", description: "", triggers: [],
    conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "any" },
    requiredSlots: [], primaryAction: "theo_he_thong", guidance: "",
    forbiddenExtra: [], knowledge: [], closingLine: "", exitConditions: [], nextScenarios: [],
  };
}

/** Thẻ đang hiển thị/sửa = nháp nếu có, không thì bản active. */
export function displayCard(rec: ScenarioRecord): ScenarioCard | null {
  return rec.draftCard ?? rec.card;
}

/** Tóm tắt "KHI KHÁCH..." bằng tiếng Việt cho thẻ ở màn danh sách. */
export function summarizeWhen(card: ScenarioCard, labels: ScenarioLabels): string {
  const parts: string[] = [];
  for (const t of card.triggers ?? []) {
    const l = labels.triggers[t];
    if (l && t !== "bat_ky") parts.push(l);
  }
  const c = card.conditions;
  if (c?.serviceIntent && c.serviceIntent !== "any") parts.push(labels.conditions.serviceIntent[c.serviceIntent] ?? "");
  if (c?.dateStatus && c.dateStatus !== "any") parts.push(labels.conditions.dateStatus[c.dateStatus] ?? "");
  if (c?.quoted && c.quoted !== "any") parts.push(labels.conditions.quoted[c.quoted] ?? "");
  if (c?.firstContact && c.firstContact !== "any") parts.push(labels.conditions.firstContact[c.firstContact] ?? "");
  const clean = parts.filter(Boolean);
  if (clean.length === 0) return (card.triggers ?? []).includes("bat_ky") ? "bất kỳ tin nào" : "(chưa đặt điều kiện)";
  return clean.join(" · ");
}

/** Tóm tắt "ĐỪNG BAO GIỜ..." (chỉ phần chủ thêm — core hiển thị riêng dạng khoá). */
export function summarizeNever(card: ScenarioCard, labels: ScenarioLabels): string {
  const parts = (card.forbiddenExtra ?? []).map((k) => labels.forbidden[k]).filter(Boolean);
  return parts.length ? parts.join(", ") : "";
}

/** Kết quả test → nhãn + màu hiển thị. */
export function verdictInfo(verdict: string | null | undefined): { label: string; tone: "ok" | "warn" | "block" | "none" } {
  if (verdict === "PASS") return { label: "Đạt", tone: "ok" };
  if (verdict === "WARN") return { label: "Cảnh báo", tone: "warn" };
  if (verdict === "BLOCK") return { label: "Bị chặn", tone: "block" };
  return { label: "—", tone: "none" };
}

/** Đổi vị trí phần tử trong mảng (kéo thả / nút lên xuống) — trả mảng MỚI. */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return arr;
  const next = arr.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/** Trạng thái hiển thị VN của 1 thẻ. */
export function statusLabel(rec: ScenarioRecord): { label: string; tone: "active" | "draft" | "archived" } {
  if (rec.status === "archived") return { label: "Đã lưu trữ", tone: "archived" };
  if (rec.draftCard) return { label: "Có bản nháp", tone: "draft" };
  if (rec.status === "draft") return { label: "Bản nháp", tone: "draft" };
  return { label: "Đang dùng", tone: "active" };
}
