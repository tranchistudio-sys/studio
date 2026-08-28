import { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  BadgeDollarSign,
  BellRing,
  BookOpen,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FilePenLine,
  FlaskConical,
  GitCompareArrows,
  GitFork,
  History,
  Image as ImageIcon,
  Layers3,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TableProperties,
  Tag,
  Target,
  Trash2,
  UserRoundCheck,
  X,
} from "lucide-react";
import { apiUrl } from "@/lib/api-base";

type ScriptNode = {
  nodeKey: string;
  scriptKey: string;
  version: number;
  stepNumber: number;
  stage: string;
  title: string;
  replyTemplate: string;
  requiredSlots: string[];
  dataSources: string[];
  validators: string[];
  status: "draft" | "active" | "locked";
  manual?: boolean;
  customerExamples?: string[];
  nextQuestion?: string | null;
};

type GroupSummary = {
  id: number;
  name: string;
  description: string | null;
  packageCount: number;
  activePackageCount: number;
  priceImageUrl: string | null;
  priceImagePublic: boolean;
  isActive: boolean;
  serviceKey: string;
  scriptKey: string;
  active: boolean;
  status: "chua_co" | "ban_nhap" | "dang_dung";
  activeVersion: number | null;
  draftVersion: number | null;
  nodeCount: number;
  stepCount: number;
  warnings: string[];
};

type Dashboard = {
  common: {
    scriptKey: string;
    activeVersion: number;
    draftVersion: number | null;
    nodes: ScriptNode[];
    questionAnswerRows: QuestionAnswerRow[];
    tables: CommonScriptTable[];
    serviceRoutes: ServiceRoute[];
    fallbackNode: ScriptNode | null;
  };
  groups: GroupSummary[];
  stats: {
    totalGroups: number;
    groupsWithScript: number;
    groupsWithoutScript: number;
    drafts: number;
    activeScripts: number;
    groupsMissingPrice: number;
    groupsMissingPriceImage: number;
  };
};

type Detail = {
  group: GroupSummary;
  script: {
    scriptKey: string;
    serviceKey: string;
    activeVersion: number;
    draftVersion: number | null;
    nodes: ScriptNode[];
    questionAnswerRows: QuestionAnswerRow[];
  };
  pricing: Array<{
    id: number;
    name: string;
    code: string | null;
    price: number;
    description: string | null;
    notes: string | null;
    isActive: boolean;
    audience: "retail" | "partner";
  }>;
  promotion: { configured: boolean; message: string };
  liveRepliesEnabled: boolean;
};

type SaveValue = {
  title: string;
  replyTemplate: string;
  customerExamples: string[];
  nextQuestion: string;
};

type QuestionAnswerRow = {
  id: string;
  stepId: number;
  question: string;
  answer: string;
  serviceKey?: string;
  routeKey?: string;
};

type CommonScriptTable = {
  key: "COMMON.GREETING" | "COMMON.SERVICE_ROUTING";
  title: string;
  shortTitle: string;
  description: string;
  nodeKeys: string[];
  questionAnswerRows: QuestionAnswerRow[];
  routeCount: number | null;
};

type ServiceRoute = {
  serviceKey: string;
  serviceType: string;
  label: string;
  routeKey: string;
};

type CommonTestResult = {
  message: string;
  intent: string;
  service: string | null;
  serviceLabel: string | null;
  serviceCandidates: string[];
  confidence: number;
  route: string | null;
  askServiceAgain: boolean;
  askReason: string | null;
  nodeKey: string;
  reply: string;
  stateBefore: Record<string, unknown>;
  stateAfter: Record<string, unknown>;
  decisionRule: string;
};

type Notice = { kind: "ok" | "error"; text: string } | null;
type EditorMode = "sheet" | "details";

const SALE_STEPS = [
  {
    id: 1,
    label: "Nhu cầu",
    title: "Tìm hiểu nhu cầu",
    objective:
      "Hiểu phong cách, số lượng cổng, trang phục, makeup và ngày dự kiến.",
    usage: "Khi khách mới hỏi dịch vụ hoặc thông tin nhu cầu còn thiếu.",
    completion:
      "Đủ thông tin tối thiểu hoặc khách muốn đi thẳng sang mẫu / giá.",
  },
  {
    id: 2,
    label: "Ảnh mẫu",
    title: "Gửi ảnh mẫu",
    objective:
      "Gửi ảnh sản phẩm thật đúng nhóm, đúng phong cách và không lặp ảnh.",
    usage: "Khi khách xin mẫu hoặc đã mô tả phong cách muốn xem.",
    completion: "Khách đã xem hoặc chọn được hướng mẫu.",
  },
  {
    id: 3,
    label: "Bảng giá",
    title: "Gửi bảng giá",
    objective:
      "Gửi ảnh bảng giá chính thức trước, sau đó tóm tắt gói khách lẻ.",
    usage: "Khi khách hỏi giá trực tiếp hoặc đã chọn được hướng mẫu.",
    completion: "Khách đã nhận bảng giá và biết gói muốn xem kỹ.",
  },
  {
    id: 4,
    label: "So sánh gói",
    title: "Tư vấn và so sánh các gói",
    objective: "Làm rõ quyền lợi và điểm khác nhau giữa các gói phù hợp.",
    usage: "Khi khách hỏi quyền lợi, khác biệt hoặc chưa biết chọn gói nào.",
    completion: "Khách hiểu sự khác nhau hoặc chọn được gói phù hợp.",
  },
  {
    id: 5,
    label: "Khuyến mãi",
    title: "Tư vấn khuyến mãi",
    objective: "Chỉ giới thiệu ưu đãi còn hiệu lực và đủ điều kiện áp dụng.",
    usage: "Khi khách hỏi ưu đãi hoặc chưa chốt sau khi đã được tư vấn gói.",
    completion: "Khách nhận được thông tin ưu đãi đã xác minh.",
  },
  {
    id: 6,
    label: "Phân vân",
    title: "Xử lý phân vân",
    objective:
      "Ghi nhận điều khách lo, đưa phương án phù hợp và không giảm giá vô điều kiện.",
    usage: "Khi khách nói giá cao, cần suy nghĩ hoặc đang tham khảo nơi khác.",
    completion: "Đã xác định lý do khách chưa chốt và hướng xử lý tiếp.",
  },
  {
    id: 7,
    label: "Quyết định",
    title: "Dẫn khách ra quyết định",
    objective:
      "Đề xuất một lựa chọn chính và hỏi bước tiếp theo một cách tự nhiên.",
    usage: "Khi khách đã xem mẫu và giá nhưng chưa nói rõ lựa chọn.",
    completion: "Khách đồng ý kiểm tra lịch hoặc cần quay lại so sánh.",
  },
  {
    id: 8,
    label: "Chốt khách",
    title: "Chốt khách và chuyển nhân viên",
    objective: "Lấy thông tin lần lượt rồi chuyển nhân viên phụ trách.",
    usage: "Khi khách muốn đặt lịch, kiểm tra lịch hoặc đã đồng ý chọn gói.",
    completion: "Đã có thông tin cần thiết và đã chuyển HUMAN_HANDOFF.",
  },
  {
    id: 9,
    label: "Follow-up",
    title: "Follow-up khách chưa chốt",
    objective:
      "Chăm lại theo lý do khách chưa chốt, không nhắn tự động ở giai đoạn này.",
    usage:
      "Khi khách chưa phản hồi và chưa chốt, từ chối hoặc được nhân viên tiếp quản.",
    completion: "Có nội dung chăm lại đúng tình trạng hoặc đã dừng follow-up.",
  },
];

const DEFAULT_QUESTIONS: Record<string, string> = {
  "COMMON.GREETING":
    "Khách mới nhắn tin nhưng chưa nói rõ cần dịch vụ nào.",
  "COMMON.SERVICE_ROUTING": "Bên mình có dịch vụ gì?",
  "COMMON.SERVICE_ROUTING.WEDDING_CLARIFY": "Em muốn chụp hình cưới.",
  "COMMON.SERVICE_ROUTING.MATCHED": "Cho em hỏi chụp cổng.",
  "COMMON.HANDOFF.UNMAPPED_REQUEST":
    "Khách hỏi nội dung chưa có trong kịch bản.",
  "WEDDING_GATE.DISCOVERY.CONFIRM_SERVICE": "Bên mình có chụp cổng không?",
  "WEDDING_GATE.DISCOVERY.EXPLAIN_PENDING": "Ý em hỏi là sao ạ?",
  "WEDDING_GATE.DISCOVERY.CAPTURE_STYLE":
    "Mình thích phong cách nhẹ nhàng, tinh tế.",
  "WEDDING_GATE.DISCOVERY.COLLECT_NEXT_SLOT":
    "Mình chưa biết chọn thế nào, em tư vấn giúp nhé.",
  "WEDDING_GATE.SAMPLE.SEND_MATCHED": "Cho mình xem vài mẫu chụp cổng.",
  "WEDDING_GATE.SAMPLE.ASK_CONFIRMATION": "Mình xem mẫu rồi.",
  "WEDDING_GATE.PRICING.SEND_RETAIL_PRICE":
    "Mình ưng mẫu này rồi, cho mình xem bảng giá.",
  "WEDDING_GATE.PROMOTION.CHECK_ELIGIBILITY":
    "Bên mình đang có khuyến mãi gì không?",
  "WEDDING_GATE.CLOSING.CONFIRM_PACKAGE": "Mình muốn đặt lịch chụp.",
  "WEDDING_GATE.CLOSING.COLLECT_PHONE": "Số điện thoại của mình là 0900000000.",
  "WEDDING_GATE.FOLLOW_UP.VIEWING_SAMPLES":
    "Mình đang xem lại các mẫu chụp cổng.",
  "WEDDING_GATE.FOLLOW_UP.COMPARE_PACKAGES": "Mình đang phân vân giữa các gói.",
  "WEDDING_GATE.FOLLOW_UP.ASK_FAMILY": "Mình cần hỏi thêm ý kiến gia đình.",
};

function tokenHeaders(): HeadersInit {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(
    apiUrl(`/api${path.startsWith("/") ? path : `/${path}`}`),
    { ...init, headers: { ...tokenHeaders(), ...(init?.headers ?? {}) } },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : "Không thể tải dữ liệu Kịch bản Sale",
    );
  return body as T;
}

function money(value: number): string {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value);
}

function questionFor(node: ScriptNode): string {
  return (
    node.customerExamples?.join("\n") || DEFAULT_QUESTIONS[node.nodeKey] || ""
  );
}

function StatusBadge({ status }: { status: GroupSummary["status"] }) {
  const config =
    status === "dang_dung"
      ? {
          label: "Đang dùng",
          className: "border-emerald-200 bg-emerald-50 text-emerald-700",
        }
      : status === "ban_nhap"
        ? {
            label: "Bản nháp",
            className: "border-amber-200 bg-amber-50 text-amber-700",
          }
        : {
            label: "Chưa có",
            className: "border-gray-200 bg-gray-50 text-gray-600",
          };
  return (
    <span
      className={`border px-2 py-0.5 text-xs font-semibold ${config.className}`}
    >
      {config.label}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="border border-dashed bg-white px-5 py-12 text-center text-sm text-gray-500">
      {message}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 bg-white px-2.5 py-2">
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: tone }}
      />
      <p className="shrink-0 text-lg font-bold tabular-nums leading-none text-gray-900">
        {value}
      </p>
      <p className="min-w-0 truncate text-[11px] font-medium text-gray-500">
        {label}
      </p>
    </div>
  );
}

function DashboardPage({
  dashboard,
  onOpenGroup,
  onOpenCommon,
}: {
  dashboard: Dashboard;
  onOpenGroup: (id: number) => void;
  onOpenCommon: (tableKey: CommonScriptTable["key"]) => void;
}) {
  // Keep the dashboard usable while a preview API is restarting on an older route shape.
  const stats = dashboard.stats ?? {
    totalGroups: dashboard.groups.length,
    groupsWithScript: dashboard.groups.filter((group) => group.active).length,
    groupsWithoutScript: dashboard.groups.filter((group) => !group.active)
      .length,
    drafts: 0,
    activeScripts: dashboard.groups.filter(
      (group) => group.status === "dang_dung",
    ).length,
    groupsMissingPrice: 0,
    groupsMissingPriceImage: 0,
  };
  const [groupQuery, setGroupQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState<
    "all" | "needs_work" | "active"
  >("all");
  const needsWorkCount = dashboard.groups.filter(
    (group) => group.status !== "dang_dung" || group.warnings.length > 0,
  ).length;
  const visibleGroups = useMemo(() => {
    const query = groupQuery.trim().toLocaleLowerCase("vi");
    return [...dashboard.groups]
      .filter((group) => {
        if (groupFilter === "active" && group.status !== "dang_dung")
          return false;
        if (
          groupFilter === "needs_work" &&
          group.status === "dang_dung" &&
          group.warnings.length === 0
        )
          return false;
        if (!query) return true;
        return [group.name, group.scriptKey, group.serviceKey].some((value) =>
          value.toLocaleLowerCase("vi").includes(query),
        );
      })
      .sort((left, right) => {
        const priority = { dang_dung: 0, ban_nhap: 1, chua_co: 2 } as const;
        return (
          priority[left.status] - priority[right.status] ||
          left.name.localeCompare(right.name, "vi")
        );
      });
  }, [dashboard.groups, groupFilter, groupQuery]);
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">
            Lulu Sale Bot
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">
            Kịch bản Sale
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Chọn nhóm bảng giá, chỉnh kịch bản rồi lưu và test bản nháp.
          </p>
        </div>
        <div className="flex items-center gap-2 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          <ShieldCheck className="h-4 w-4 shrink-0" /> Chế độ thử nghiệm · Chưa
          gửi Facebook thật
        </div>
      </header>

      <section className="grid grid-cols-2 gap-px overflow-hidden bg-gray-200 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Tổng bảng giá" value={stats.totalGroups} tone="#64748b" />
        <Stat label="Đang dùng" value={stats.activeScripts} tone="#0891b2" />
        <Stat
          label="Chưa có"
          value={stats.groupsWithoutScript}
          tone="#f59e0b"
        />
        <Stat label="Bản nháp" value={stats.drafts} tone="#8b5cf6" />
        <Stat
          label="Thiếu gói"
          value={stats.groupsMissingPrice}
          tone="#ef4444"
        />
        <Stat
          label="Thiếu ảnh"
          value={stats.groupsMissingPriceImage}
          tone="#e11d48"
        />
      </section>

      <section className="border-y border-slate-200 bg-slate-50 px-3 py-4 sm:px-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-white">
            <MessageSquareText className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-bold text-gray-900">Kịch bản chung của Lulu</h2>
            <p className="mt-1 text-sm text-gray-600">
              2 bước dùng chung · Chào hỏi và phân loại dịch vụ trước khi vào kịch bản riêng.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {dashboard.common.tables.map((table, index) => {
            const nodeCount = dashboard.common.nodes.filter((node) =>
              table.nodeKeys.includes(node.nodeKey),
            ).length;
            const count = table.questionAnswerRows.length + nodeCount;
            return (
              <article key={table.key} className="border bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center ${index === 0 ? "bg-rose-50 text-rose-700" : "bg-cyan-50 text-cyan-700"}`}>
                    {index === 0 ? <MessageSquareText className="h-5 w-5" /> : <GitFork className="h-5 w-5" />}
                  </div>
                  <span className="border bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-500">
                    {table.key}
                  </span>
                </div>
                <h3 className="mt-4 text-base font-bold text-slate-900">{table.shortTitle === "Chào hỏi" ? table.title : table.shortTitle}</h3>
                <p className="mt-1 min-h-10 text-sm leading-5 text-slate-600">{table.description}</p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  <span className="border border-slate-200 bg-slate-50 px-2 py-1 font-semibold text-slate-700">{count} câu đang có</span>
                  {table.routeCount !== null && (
                    <span className="border border-cyan-200 bg-cyan-50 px-2 py-1 font-semibold text-cyan-800">{table.routeCount} nhánh dịch vụ</span>
                  )}
                </div>
                <button
                  onClick={() => onOpenCommon(table.key)}
                  className="mt-4 inline-flex h-10 items-center gap-2 border border-slate-900 bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  <BookOpen className="h-4 w-4" /> Mở kịch bản
                </button>
              </article>
            );
          })}
        </div>
        {dashboard.common.fallbackNode && (
          <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="h-4 w-4 text-amber-600" /> Fallback chung vẫn giữ nguyên: {dashboard.common.fallbackNode.title}.
          </p>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-gray-900">Nhóm bảng giá</h2>
              <span className="text-xs font-medium text-gray-400">
                {visibleGroups.length}/{dashboard.groups.length}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-gray-500">
              Chọn một nhóm để mở quy trình 9 bước.
            </p>
          </div>
          <div className="w-full space-y-2 lg:max-w-xl">
            <label className="relative block">
              <span className="sr-only">Tìm nhóm bảng giá</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={groupQuery}
                onChange={(event) => setGroupQuery(event.target.value)}
                placeholder="Tìm nhóm bảng giá..."
                className="h-10 w-full border bg-white pl-9 pr-3 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
              />
            </label>
            <div
              className="grid grid-cols-3 gap-1.5"
              aria-label="Lọc nhóm bảng giá"
            >
              {(
                [
                  ["all", "Tất cả", dashboard.groups.length],
                  ["needs_work", "Cần làm", needsWorkCount],
                  ["active", "Đang dùng", stats.activeScripts],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={groupFilter === value}
                  onClick={() => setGroupFilter(value)}
                  className={`h-9 border px-2 text-xs font-semibold transition ${
                    groupFilter === value
                      ? "border-violet-600 bg-violet-600 text-white"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {label} · {count}
                </button>
              ))}
            </div>
          </div>
        </div>
        {visibleGroups.length === 0 ? (
          <EmptyState message="Không tìm thấy nhóm bảng giá phù hợp." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleGroups.map((group) => (
              <article
                key={group.id}
                className={`border bg-white p-3.5 ${
                  group.status === "dang_dung"
                    ? "border-emerald-200"
                    : "border-gray-200"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-bold text-gray-900">
                      {group.name}
                    </h3>
                    <p className="mt-1 hidden truncate font-mono text-[11px] text-gray-400 sm:block">
                      {group.scriptKey}
                    </p>
                  </div>
                  <StatusBadge status={group.status} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-y py-2 text-xs text-gray-500">
                  <span>
                    <b className="text-gray-800">{group.activePackageCount}</b>/
                    {group.packageCount} gói
                  </span>
                  <span>
                    <b className="text-gray-800">{group.nodeCount}</b> câu
                  </span>
                  <span>
                    <b className="text-gray-800">{group.stepCount || 9}</b> bước
                  </span>
                  <span>
                    {group.draftVersion
                      ? `Nháp v${group.draftVersion}`
                      : group.activeVersion
                        ? `Đang dùng v${group.activeVersion}`
                        : "Chưa có phiên bản"}
                  </span>
                </div>
                {group.warnings.length > 0 && (
                  <div className="mt-2 flex min-h-5 items-start gap-1.5 text-xs text-amber-700">
                    <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">
                      {group.warnings[0]}
                      {group.warnings.length > 1 &&
                        ` · +${group.warnings.length - 1}`}
                    </span>
                  </div>
                )}
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <button
                    onClick={() => onOpenGroup(group.id)}
                    className="inline-flex h-10 items-center justify-center gap-1.5 bg-violet-600 px-3 text-sm font-semibold text-white hover:bg-violet-700"
                  >
                    <FilePenLine className="h-4 w-4" /> Mở kịch bản
                  </button>
                  <button
                    onClick={() =>
                      window.location.assign(`/pricing?groupId=${group.id}`)
                    }
                    title="Mở nhóm bảng giá"
                    aria-label={`Mở bảng giá ${group.name}`}
                    className="inline-flex h-10 items-center justify-center gap-1.5 border px-3 text-sm font-medium text-gray-600 hover:bg-gray-50"
                  >
                    <Tag className="h-4 w-4" />
                    <span className="hidden sm:inline">Bảng giá</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function NodeEditor({
  node,
  onSave,
  onTest,
  saving,
}: {
  node: ScriptNode;
  onSave: (value: SaveValue) => Promise<void>;
  onTest: () => void;
  saving: boolean;
}) {
  const [title, setTitle] = useState(node.title);
  const [replyTemplate, setReplyTemplate] = useState(node.replyTemplate);
  const [examples, setExamples] = useState(questionFor(node));
  const [nextQuestion, setNextQuestion] = useState(node.nextQuestion ?? "");
  useEffect(() => {
    setTitle(node.title);
    setReplyTemplate(node.replyTemplate);
    setExamples(questionFor(node));
    setNextQuestion(node.nextQuestion ?? "");
  }, [node]);
  return (
    <div className="min-w-0 space-y-5 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-gray-900">{node.title}</h2>
            {node.manual && (
              <span className="border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                Sửa tay
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-xs text-gray-500">
            {node.nodeKey} · {node.stage} · v{node.version}
          </p>
        </div>
        <button
          onClick={onTest}
          className="inline-flex items-center gap-1.5 border px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50"
        >
          <FlaskConical className="h-4 w-4" /> Test câu này
        </button>
      </div>
      <label className="block text-sm font-semibold text-gray-800">
        Tên câu
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="mt-1.5 w-full border px-3 py-2 text-sm font-normal outline-none focus:border-violet-500"
        />
      </label>
      <label className="block text-sm font-semibold text-gray-800">
        Câu khách thường nói
        <textarea
          value={examples}
          onChange={(event) => setExamples(event.target.value)}
          rows={3}
          placeholder="Mỗi câu một dòng"
          className="mt-1.5 w-full resize-y border px-3 py-2 text-sm font-normal outline-none focus:border-violet-500"
        />
      </label>
      <label className="block text-sm font-semibold text-gray-800">
        Câu gốc của Lulu
        <textarea
          value={replyTemplate}
          onChange={(event) => setReplyTemplate(event.target.value)}
          rows={7}
          className="mt-1.5 w-full resize-y border px-3 py-2 text-sm font-normal leading-6 outline-none focus:border-violet-500"
        />
      </label>
      <label className="block text-sm font-semibold text-gray-800">
        Câu hỏi tiếp theo
        <input
          value={nextQuestion}
          onChange={(event) => setNextQuestion(event.target.value)}
          className="mt-1.5 w-full border px-3 py-2 text-sm font-normal outline-none focus:border-violet-500"
        />
      </label>
      <details className="border bg-gray-50">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-gray-700">
          Thiết lập nâng cao
        </summary>
        <div className="grid gap-3 border-t p-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs text-gray-500">Điều kiện</p>
            <p className="mt-1 font-mono text-xs">
              {node.validators.join(" · ") || "Không có"}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Thông tin cần thu thập</p>
            <p className="mt-1 font-mono text-xs">
              {node.requiredSlots.join(" · ") || "Không có"}
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs text-gray-500">Nguồn dữ liệu</p>
            <p className="mt-1 font-mono text-xs">
              {node.dataSources.join(" · ") || "Không có"}
            </p>
          </div>
        </div>
      </details>
      <div className="flex justify-end border-t pt-4">
        <button
          disabled={saving || !replyTemplate.trim()}
          onClick={() =>
            onSave({
              title,
              replyTemplate,
              customerExamples: examples
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
              nextQuestion,
            })
          }
          className="inline-flex items-center gap-1.5 bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}{" "}
          Lưu bản nháp
        </button>
      </div>
    </div>
  );
}

type SheetRow = {
  id: string;
  node?: ScriptNode;
  question: string;
  answer: string;
};

function saleStepForNode(node: ScriptNode): number {
  if (node.scriptKey === "SALE_COMMON") return 1;
  if (node.nodeKey === "WEDDING_GATE.COMPARE.PACKAGES") return 4;
  if (node.nodeKey === "WEDDING_GATE.OBJECTION.PRICE") return 6;
  if (node.nodeKey === "WEDDING_GATE.DECISION.PACKAGE_SELECTED") return 7;
  if (node.stepNumber === 2) return 1;
  if (node.stepNumber === 3) return 2;
  if (node.stepNumber === 4) return 3;
  if (node.stepNumber === 5) return 5;
  if (node.nodeKey === "WEDDING_GATE.CLOSING.CONFIRM_PACKAGE") return 7;
  if (node.stepNumber === 6) return 8;
  if (node.stepNumber === 7) return 9;
  return 1;
}

function stepIcon(stepId: number) {
  const Icon =
    stepId === 1
      ? Target
      : stepId === 2
        ? Camera
        : stepId === 3
          ? BadgeDollarSign
          : stepId === 4
            ? GitCompareArrows
            : stepId === 5
              ? Sparkles
              : stepId === 6
                ? CircleHelp
                : stepId === 7
                  ? CheckCircle2
                  : stepId === 8
                    ? UserRoundCheck
                    : BellRing;
  return <Icon className="h-4 w-4" />;
}

function rowsForStep(
  nodes: ScriptNode[],
  savedRows: QuestionAnswerRow[],
  stepId: number,
): SheetRow[] {
  const rows = [
    ...nodes
      .filter((node) => saleStepForNode(node) === stepId)
      .map((node) => ({
        id: `node-${node.nodeKey}`,
        node,
        question: questionFor(node),
        answer: node.replyTemplate,
      })),
    ...savedRows
      .filter((row) => row.stepId === stepId)
      .map((row) => ({
        id: row.id,
        question: row.question,
        answer: row.answer,
      })),
  ];
  const usedIds = new Set(rows.map((row) => row.id));
  const blankRows = Array.from(
    { length: Math.max(2, 6 - rows.length) },
    (_item, index) => {
      const baseId = `blank-${stepId}-${index + 1}`;
      let id = baseId;
      let duplicate = 1;
      while (usedIds.has(id)) {
        duplicate += 1;
        id = `${baseId}-${duplicate}`;
      }
      usedIds.add(id);
      return { id, question: "", answer: "" };
    },
  );
  return [
    ...rows,
    ...blankRows,
  ];
}

function StepQuestionAnswerSheet({
  step,
  nodes,
  questionAnswerRows,
  onSave,
  onSaveQuestionAnswerRows,
  onTest,
  onOpenAdvanced,
  saving,
}: {
  step: (typeof SALE_STEPS)[number];
  nodes: ScriptNode[];
  questionAnswerRows: QuestionAnswerRow[];
  onSave: (node: ScriptNode, value: SaveValue) => Promise<void>;
  onSaveQuestionAnswerRows: (rows: QuestionAnswerRow[]) => Promise<void>;
  onTest: (node?: ScriptNode) => void;
  onOpenAdvanced: (node: ScriptNode) => void;
  saving: boolean;
}) {
  const [rows, setRows] = useState<SheetRow[]>(() =>
    rowsForStep(nodes, questionAnswerRows, step.id),
  );
  const [lockedRows, setLockedRows] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setRows(rowsForStep(nodes, questionAnswerRows, step.id));
    setLockedRows(new Set());
  }, [nodes, questionAnswerRows, step.id]);

  const applyPaste = (
    plainText: string,
    rowIndex: number,
    field: "question" | "answer",
  ) => {
    if (!plainText.includes("\t")) return false;
    const pastedRows = plainText
      .replace(/\r/g, "")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split("\t"));
    const startColumn = field === "question" ? 0 : 1;
    setRows((current) => {
      const expanded = [...current];
      const requiredRowCount = rowIndex + pastedRows.length;
      while (expanded.length < requiredRowCount) {
        expanded.push({
          id: `paste-${step.id}-${Date.now()}-${expanded.length}`,
          question: "",
          answer: "",
        });
      }
      return expanded.map((row, index) => {
        const pasted = pastedRows[index - rowIndex];
        if (!pasted) return row;
        return {
          ...row,
          ...(pasted[startColumn] !== undefined
            ? { question: pasted[startColumn] }
            : {}),
          ...(pasted[startColumn + 1] !== undefined
            ? { answer: pasted[startColumn + 1] }
            : {}),
        };
      });
    });
    return true;
  };

  const changeCell = (
    rowIndex: number,
    field: "question" | "answer",
    value: string,
  ) =>
    setRows((current) =>
      current.map((row, index) =>
        index === rowIndex ? { ...row, [field]: value } : row,
      ),
    );
  const addRow = () => {
    const rowId = `new-${step.id}-${Date.now()}`;
    setRows((current) => {
      const next = [...current];
      const firstPlaceholder = next.findIndex((row) =>
        row.id.startsWith(`blank-${step.id}-`),
      );
      next.splice(firstPlaceholder < 0 ? next.length : firstPlaceholder, 0, {
        id: rowId,
        question: "",
        answer: "",
      });
      return next;
    });
  };
  const cloneRow = (row: SheetRow) => {
    const rowId = `copy-${step.id}-${Date.now()}`;
    setRows((current) => {
      const next = [...current];
      const firstPlaceholder = next.findIndex((item) =>
        item.id.startsWith(`blank-${step.id}-`),
      );
      next.splice(firstPlaceholder < 0 ? next.length : firstPlaceholder, 0, {
        id: rowId,
        question: row.question,
        answer: row.answer,
      });
      return next;
    });
  };
  const clearRow = (rowId: string) => {
    setRows((current) =>
      current.map((row) =>
        row.id === rowId && !row.node
          ? { ...row, question: "", answer: "" }
          : row,
      ),
    );
  };
  const moveRow = (rowIndex: number, delta: -1 | 1) =>
    setRows((current) => {
      const nextIndex = rowIndex + delta;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const copy = [...current];
      [copy[rowIndex], copy[nextIndex]] = [copy[nextIndex], copy[rowIndex]];
      return copy;
    });
  const toggleLock = (rowId: string) =>
    setLockedRows((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  const focusFirstQuestion = () => {
    const rowIndex = Math.max(
      0,
      rows.findIndex((row) => row.question.trim() || row.answer.trim()),
    );
    const surface =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches
        ? "mobile"
        : "desktop";
    document
      .getElementById(`question-${surface}-${step.id}-${rowIndex}`)
      ?.focus();
  };
  const saveStep = async () => {
    for (const row of rows) {
      if (!row.node || !row.answer.trim()) continue;
      await onSave(row.node, {
        title: row.node.title,
        replyTemplate: row.answer,
        customerExamples: row.question
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        nextQuestion: row.node.nextQuestion ?? "",
      });
    }
    const manualRows = rows
      .filter((row) => !row.node && row.question.trim() && row.answer.trim())
      .map((row) => ({
        id: row.id,
        stepId: step.id,
        question: row.question,
        answer: row.answer,
      }));
    await onSaveQuestionAnswerRows([
      ...questionAnswerRows.filter((row) => row.stepId !== step.id),
      ...manualRows,
    ]);
  };
  const firstNode = rows.find((row) => row.node)?.node;
  const filledRowCount = rows.filter(
    (row) => row.question.trim() && row.answer.trim(),
  ).length;
  const fitMobileTextarea = (element: HTMLTextAreaElement | null) => {
    if (!element) return;
    const currentHeight = Number.parseFloat(element.style.height) || 0;
    element.style.height = "auto";
    element.style.height = `${Math.max(112, currentHeight, element.scrollHeight)}px`;
  };

  return (
    <section className="border bg-white">
      <div className="border-b bg-slate-50 px-3 py-3 sm:px-4 sm:py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 gap-2.5 sm:gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-emerald-700 text-white sm:h-10 sm:w-10">
              {stepIcon(step.id)}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                Bảng {step.id}
              </p>
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-bold text-gray-900 sm:text-lg">
                  {step.title}
                </h2>
                <span className="shrink-0 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-gray-500">
                  {filledRowCount} câu
                </span>
              </div>
              <p className="mt-1 hidden max-w-3xl text-sm text-gray-600 sm:block">
                {step.objective}
              </p>
            </div>
          </div>
          <div className="grid w-full grid-cols-4 gap-1.5 sm:w-auto sm:flex sm:flex-wrap sm:gap-2">
            <button
              onClick={addRow}
              className="inline-flex h-9 items-center justify-center gap-1 border bg-white px-2 text-xs font-medium text-gray-700 hover:bg-gray-50 sm:h-10 sm:gap-1.5 sm:px-3 sm:text-sm"
            >
              <Plus className="h-4 w-4" />
              <span className="sm:hidden">Dòng</span>
              <span className="hidden sm:inline">Thêm câu</span>
            </button>
            <button
              onClick={focusFirstQuestion}
              className="inline-flex h-9 items-center justify-center gap-1 border bg-white px-2 text-xs font-medium text-gray-700 hover:bg-gray-50 sm:h-10 sm:gap-1.5 sm:px-3 sm:text-sm"
            >
              <ClipboardPaste className="h-4 w-4" />
              <span className="sm:hidden">Excel</span>
              <span className="hidden sm:inline">Dán từ Excel</span>
            </button>
            <button
              onClick={() => onTest(firstNode)}
              disabled={!firstNode}
              className="inline-flex h-9 items-center justify-center gap-1 border border-violet-200 bg-violet-50 px-2 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50 sm:h-10 sm:gap-1.5 sm:px-3 sm:text-sm"
            >
              <FlaskConical className="h-4 w-4" />
              <span>Test</span>
              <span className="hidden sm:inline"> bước</span>
            </button>
            <button
              id={`save-step-${step.id}`}
              disabled={saving}
              onClick={saveStep}
              className="inline-flex h-9 items-center justify-center gap-1 bg-emerald-700 px-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 sm:h-10 sm:gap-1.5 sm:px-3 sm:text-sm"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}{" "}
              <span>Lưu</span>
              <span className="hidden sm:inline"> bước</span>
            </button>
          </div>
        </div>
        <details className="mt-3 border-t pt-2 text-xs text-slate-600 sm:hidden">
          <summary className="cursor-pointer font-semibold text-slate-700">
            Hướng dẫn bước
          </summary>
          <div className="mt-2 space-y-1.5 leading-5">
            <p>
              <b>Điều kiện dùng:</b> {step.usage}
            </p>
            <p>
              <b>Hoàn thành khi:</b> {step.completion}
            </p>
            <p>
              <b>Trạng thái:</b>{" "}
              {questionAnswerRows.some((row) => row.stepId === step.id)
                ? "Bản nháp đã chỉnh"
                : "Dùng kịch bản gốc"}
            </p>
          </div>
        </details>
        <div className="mt-3 hidden gap-2 text-xs text-slate-600 sm:grid sm:grid-cols-2 xl:grid-cols-4">
          <p>
            <b>Điều kiện dùng:</b> {step.usage}
          </p>
          <p>
            <b>Hoàn thành khi:</b> {step.completion}
          </p>
          <p>
            <b>Câu đang có:</b> {filledRowCount}
          </p>
          <p>
            <b>Trạng thái:</b>{" "}
            {questionAnswerRows.some((row) => row.stepId === step.id)
              ? "Bản nháp đã chỉnh"
              : "Dùng kịch bản gốc"}
          </p>
        </div>
      </div>
      <div className="w-full max-w-full overflow-x-hidden md:hidden">
        <table className="w-full table-fixed border-collapse text-[13px]">
          <colgroup>
            <col className="w-1/2" />
            <col className="w-1/2" />
          </colgroup>
          <thead className="bg-emerald-50 text-left text-[11px] font-bold uppercase tracking-wide text-emerald-950">
            <tr>
              <th className="border-b border-r border-emerald-200 px-2 py-3">
                Khách có thể nói
              </th>
              <th className="border-b border-emerald-200 px-2 py-3">
                Lulu trả lời
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const locked = lockedRows.has(row.id);
              const showActions = Boolean(
                row.node || row.question.trim() || row.answer.trim(),
              );

              return (
                <Fragment key={row.id}>
                  <tr
                    className={
                      "align-top " + (locked ? "bg-slate-100" : "bg-white")
                    }
                  >
                    <td className="w-1/2 border-b border-r border-slate-200 p-0 align-top">
                      <textarea
                        ref={fitMobileTextarea}
                        id={"question-mobile-" + step.id + "-" + index}
                        aria-label={"Khách có thể nói " + (index + 1)}
                        value={row.question}
                        disabled={locked}
                        onInput={(event) =>
                          fitMobileTextarea(event.currentTarget)
                        }
                        onChange={(event) =>
                          changeCell(index, "question", event.target.value)
                        }
                        onPaste={(event) => {
                          if (
                            applyPaste(
                              event.clipboardData.getData("text/plain"),
                              index,
                              "question",
                            )
                          )
                            event.preventDefault();
                        }}
                        rows={4}
                        wrap="soft"
                        placeholder="Câu khách hỏi"
                        className="block min-h-28 w-full min-w-0 resize-y overflow-hidden whitespace-pre-wrap break-words bg-transparent px-2.5 py-3 leading-5 text-slate-900 outline-none [overflow-wrap:anywhere] focus:bg-white focus:ring-2 focus:ring-inset focus:ring-emerald-500 disabled:cursor-not-allowed disabled:text-slate-500"
                      />
                    </td>
                    <td className="w-1/2 border-b border-slate-200 bg-emerald-50/30 p-0 align-top">
                      <textarea
                        ref={fitMobileTextarea}
                        aria-label={"Lulu trả lời " + (index + 1)}
                        value={row.answer}
                        disabled={locked}
                        onInput={(event) =>
                          fitMobileTextarea(event.currentTarget)
                        }
                        onChange={(event) =>
                          changeCell(index, "answer", event.target.value)
                        }
                        onPaste={(event) => {
                          if (
                            applyPaste(
                              event.clipboardData.getData("text/plain"),
                              index,
                              "answer",
                            )
                          )
                            event.preventDefault();
                        }}
                        rows={4}
                        wrap="soft"
                        placeholder="Câu Lulu trả lời"
                        className="block min-h-28 w-full min-w-0 resize-y overflow-hidden whitespace-pre-wrap break-words bg-transparent px-2.5 py-3 leading-5 text-slate-900 outline-none [overflow-wrap:anywhere] focus:bg-white focus:ring-2 focus:ring-inset focus:ring-emerald-500 disabled:cursor-not-allowed disabled:text-slate-500"
                      />
                    </td>
                  </tr>
                  {showActions && (
                    <tr className="bg-slate-50">
                      <td
                        colSpan={2}
                        className="border-b border-slate-200 px-2 py-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-1">
                          {row.node && (
                            <button
                              type="button"
                              onClick={() => onTest(row.node)}
                              className="inline-flex items-center gap-1 border bg-white px-2 py-1 text-[11px] font-medium text-emerald-700"
                            >
                              <FlaskConical className="h-3.5 w-3.5" /> Test
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => cloneRow(row)}
                            aria-label="Nhân bản"
                            className="border bg-white p-1 text-slate-600"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveRow(index, -1)}
                            disabled={index === 0}
                            aria-label="Di chuyển lên"
                            className="border bg-white p-1 text-slate-600 disabled:opacity-30"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveRow(index, 1)}
                            disabled={index === rows.length - 1}
                            aria-label="Di chuyển xuống"
                            className="border bg-white p-1 text-slate-600 disabled:opacity-30"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleLock(row.id)}
                            aria-label={
                              locked ? "Mở khóa dòng" : "Tạm khóa dòng"
                            }
                            className={
                              "border p-1 " +
                              (locked
                                ? "border-slate-700 bg-slate-700 text-white"
                                : "bg-white text-slate-600")
                            }
                          >
                            <LockKeyhole className="h-3.5 w-3.5" />
                          </button>
                          {row.node && (
                            <button
                              type="button"
                              onClick={() => onOpenAdvanced(row.node!)}
                              className="ml-auto inline-flex items-center gap-1 border border-violet-200 bg-violet-50 px-2 py-1 text-[11px] font-medium text-violet-700"
                            >
                              <Settings2 className="h-3.5 w-3.5" /> Nâng cao
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => clearRow(row.id)}
                            disabled={Boolean(row.node)}
                            aria-label={
                              row.node ? "Node gốc không thể xóa" : "Xóa dòng"
                            }
                            className="border border-rose-100 bg-white p-1 text-rose-700 disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-[900px] w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-12" />
            <col className="w-[34%]" />
            <col />
            <col className="w-[210px]" />
          </colgroup>
          <thead className="bg-emerald-50 text-left text-xs font-bold uppercase tracking-wide text-emerald-950">
            <tr>
              <th className="border-b border-r px-1 py-3 text-center" aria-label="Số thứ tự" />
              <th className="border-b border-r px-3 py-3">Khách có thể nói</th>
              <th className="border-b border-r px-3 py-3">Lulu trả lời</th>
              <th className="border-b px-3 py-3 text-center">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const locked = lockedRows.has(row.id);
              return (
                <tr
                  key={row.id}
                  className={`align-top ${locked ? "bg-slate-50" : "hover:bg-emerald-50/40"}`}
                >
                  <td className="border-b border-r bg-slate-50 px-1 text-center align-middle font-semibold tabular-nums text-slate-500">
                    {index + 1}
                  </td>
                  <td className="border-b border-r p-0">
                    <textarea
                      id={`question-desktop-${step.id}-${index}`}
                      aria-label={`Khách có thể nói ${index + 1}`}
                      value={row.question}
                      disabled={locked}
                      onChange={(event) =>
                        changeCell(index, "question", event.target.value)
                      }
                      onPaste={(event) => {
                        if (
                          applyPaste(
                            event.clipboardData.getData("text/plain"),
                            index,
                            "question",
                          )
                        )
                          event.preventDefault();
                      }}
                      rows={3}
                      placeholder="Câu khách hỏi"
                      className="block min-h-20 w-full resize-y bg-transparent px-3 py-3 leading-5 outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-emerald-500 disabled:cursor-not-allowed disabled:text-slate-500"
                    />
                  </td>
                  <td className="border-b border-r p-0">
                    <textarea
                      aria-label={`Lulu trả lời ${index + 1}`}
                      value={row.answer}
                      disabled={locked}
                      onChange={(event) =>
                        changeCell(index, "answer", event.target.value)
                      }
                      onPaste={(event) => {
                        if (
                          applyPaste(
                            event.clipboardData.getData("text/plain"),
                            index,
                            "answer",
                          )
                        )
                          event.preventDefault();
                      }}
                      rows={3}
                      placeholder="Câu Lulu trả lời"
                      className="block min-h-20 w-full resize-y bg-transparent px-3 py-3 leading-5 outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-emerald-500 disabled:cursor-not-allowed disabled:text-slate-500"
                    />
                  </td>
                  <td className="border-b p-2">
                    <div className="flex flex-wrap justify-center gap-1">
                      {row.node && (
                        <button
                          onClick={() => onTest(row.node)}
                          title="Test câu"
                          className="border p-1.5 text-emerald-700 hover:bg-emerald-50"
                        >
                          <FlaskConical className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => cloneRow(row)}
                        title="Nhân bản"
                        className="border p-1.5 text-gray-600 hover:bg-gray-50"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => moveRow(index, -1)}
                        disabled={index === 0}
                        title="Di chuyển lên"
                        className="border p-1.5 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => moveRow(index, 1)}
                        disabled={index === rows.length - 1}
                        title="Di chuyển xuống"
                        className="border p-1.5 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => toggleLock(row.id)}
                        title={locked ? "Mở khóa dòng" : "Tạm khóa dòng"}
                        className={`border p-1.5 ${locked ? "bg-slate-700 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                      >
                        <LockKeyhole className="h-3.5 w-3.5" />
                      </button>
                      {row.node && (
                        <button
                          onClick={() => onOpenAdvanced(row.node!)}
                          title="Thiết lập nâng cao"
                          className="border p-1.5 text-violet-700 hover:bg-violet-50"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => clearRow(row.id)}
                        disabled={Boolean(row.node)}
                        title={row.node ? "Node gốc không thể xóa" : "Xóa dòng"}
                        className="border p-1.5 text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t bg-slate-50 px-4 py-2 text-xs text-slate-500">
        Dán hai cột từ Excel vào dòng đầu. Các dòng thêm chỉ được lưu khi có đủ
        câu khách nói và câu Lulu trả lời.
      </p>
    </section>
  );
}

function stepQuestionCount(detail: Detail, stepId: number): number {
  return (
    detail.script.nodes.filter((node) => saleStepForNode(node) === stepId)
      .length +
    detail.script.questionAnswerRows.filter((row) => row.stepId === stepId)
      .length
  );
}

function stepWarning(detail: Detail, stepId: number): string | null {
  const count = stepQuestionCount(detail, stepId);
  if (
    stepId === 2 &&
    detail.script.nodes.every((node) => saleStepForNode(node) !== 2)
  )
    return "Thiếu node kho ảnh";
  if (
    stepId === 3 &&
    (!detail.group.priceImageUrl || !detail.group.priceImagePublic)
  )
    return "Thiếu ảnh bảng giá";
  if (stepId === 3 && detail.group.activePackageCount === 0)
    return "Chưa có gói đang bán";
  if (
    stepId === 4 &&
    detail.pricing.filter((pkg) => pkg.audience === "retail" && pkg.isActive)
      .length < 2
  )
    return "Cần ít nhất 2 gói";
  if (stepId === 5 && !detail.promotion.configured) return "Chưa có khuyến mãi";
  if (count === 0) return "Chưa có câu hỏi - đáp";
  return null;
}

function SaleProcessStepper({
  detail,
  activeStep,
  onChange,
}: {
  detail: Detail;
  activeStep: number;
  onChange: (stepId: number) => void;
}) {
  const currentStep = SALE_STEPS.find((step) => step.id === activeStep)!;
  const currentCount = stepQuestionCount(detail, activeStep);
  const currentWarning = stepWarning(detail, activeStep);
  const currentHasDraft =
    detail.script.questionAnswerRows.some((row) => row.stepId === activeStep) ||
    detail.script.nodes.some(
      (node) => saleStepForNode(node) === activeStep && node.manual,
    );

  return (
    <>
      <section className="border bg-white md:hidden">
        <div className="flex items-center gap-2 p-2">
          <button
            type="button"
            onClick={() => onChange(activeStep - 1)}
            disabled={activeStep === 1}
            aria-label="Bảng trước"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center border text-slate-600 disabled:opacity-30"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <label className="min-w-0 flex-1">
            <span className="sr-only">Chọn bảng quy trình</span>
            <select
              aria-label="Chọn bảng quy trình"
              value={activeStep}
              onChange={(event) => onChange(Number(event.target.value))}
              className="h-11 w-full border border-emerald-200 bg-emerald-50 px-2 text-sm font-bold text-emerald-900 outline-none focus:border-emerald-600"
            >
              {SALE_STEPS.map((step) => (
                <option key={step.id} value={step.id}>
                  {step.id}/9 · {step.label} ·{" "}
                  {stepQuestionCount(detail, step.id)} câu
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => onChange(activeStep + 1)}
            disabled={activeStep === SALE_STEPS.length}
            aria-label="Bảng tiếp theo"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center border text-slate-600 disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
        <div className="flex min-h-9 items-center justify-between gap-2 border-t px-3 py-2 text-xs">
          <span className="min-w-0 truncate text-slate-500">
            {currentStep.title} · {currentCount} câu ·{" "}
            {currentHasDraft
              ? "Bản nháp"
              : currentCount > 0
                ? "Đang dùng"
                : "Khung trống"}
          </span>
          {currentWarning && (
            <span className="inline-flex shrink-0 items-center gap-1 font-medium text-amber-700">
              <CircleAlert className="h-3.5 w-3.5" /> Cần kiểm tra
            </span>
          )}
        </div>
      </section>

      <section className="hidden overflow-hidden border bg-slate-200 md:block">
        <div className="grid grid-cols-3 gap-px xl:grid-cols-5">
          {SALE_STEPS.map((step) => {
            const count = stepQuestionCount(detail, step.id);
            const warning = stepWarning(detail, step.id);
            const selected = activeStep === step.id;
            const hasDraft =
              detail.script.questionAnswerRows.some(
                (row) => row.stepId === step.id,
              ) ||
              detail.script.nodes.some(
                (node) => saleStepForNode(node) === step.id && node.manual,
              );
            return (
              <button
                key={step.id}
                onClick={() => onChange(step.id)}
                aria-pressed={selected}
                className={`group min-h-[92px] p-3 text-left transition ${selected ? "bg-emerald-700 text-white" : "bg-white text-slate-800 hover:bg-emerald-50"}`}
              >
                <span className="flex items-start gap-2.5">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center border text-xs font-bold ${selected ? "border-white/40 bg-white/15" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}
                  >
                    {step.id}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-bold">
                      {stepIcon(step.id)} {step.label}
                    </span>
                    <span
                      className={`mt-1 block text-xs ${selected ? "text-emerald-50" : "text-slate-500"}`}
                    >
                      {count} câu ·{" "}
                      {hasDraft
                        ? "Bản nháp"
                        : count > 0
                          ? "Đang dùng"
                          : "Khung trống"}
                    </span>
                    {warning && (
                      <span
                        className={`mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium ${selected ? "text-amber-100" : "text-amber-700"}`}
                      >
                        <CircleAlert className="h-3 w-3" /> {warning}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

function DataPanel({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-slate-100 text-slate-700">
          {icon}
        </div>
        <div>
          <h3 className="font-bold text-slate-900">{title}</h3>
          <p className="mt-0.5 text-xs leading-5 text-slate-500">
            {description}
          </p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function PackageComparisonPanel({ detail }: { detail: Detail }) {
  const packages = detail.pricing.filter(
    (pkg) => pkg.audience === "retail" && pkg.isActive,
  );
  const [leftId, setLeftId] = useState(String(packages[0]?.id ?? ""));
  const [rightId, setRightId] = useState(
    String(packages[1]?.id ?? packages[0]?.id ?? ""),
  );
  useEffect(() => {
    setLeftId(String(packages[0]?.id ?? ""));
    setRightId(String(packages[1]?.id ?? packages[0]?.id ?? ""));
  }, [detail.group.id, detail.pricing]);
  const selectedPackages = [
    packages.find((pkg) => String(pkg.id) === leftId),
    packages.find((pkg) => String(pkg.id) === rightId),
  ];
  return (
    <DataPanel
      icon={<GitCompareArrows className="h-4 w-4" />}
      title="So sánh gói"
      description="Chỉ dùng dữ liệu gói khách lẻ đang bán; không tự đoán quyền lợi còn thiếu."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {selectedPackages.map((pkg, index) => (
          <div key={index} className="border bg-slate-50 p-3">
            <label className="text-xs font-semibold text-slate-500">
              Gói {index === 0 ? "A" : "B"}
              <select
                value={index === 0 ? leftId : rightId}
                onChange={(event) =>
                  index === 0
                    ? setLeftId(event.target.value)
                    : setRightId(event.target.value)
                }
                className="mt-1.5 block w-full border bg-white px-2 py-2 text-sm font-medium text-slate-900"
              >
                {packages.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {pkg ? (
              <div className="mt-3 space-y-2 text-sm">
                <p className="flex justify-between gap-3">
                  <span className="text-slate-500">Giá</span>
                  <b>{money(pkg.price)}</b>
                </p>
                <p className="border-t pt-2 text-xs leading-5 text-slate-600">
                  {pkg.description ||
                    pkg.notes ||
                    "Chưa có mô tả quyền lợi để so sánh."}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-xs text-amber-700">
                Chưa có gói phù hợp.
              </p>
            )}
          </div>
        ))}
      </div>
    </DataPanel>
  );
}

function StepDataPanel({ stepId, detail }: { stepId: number; detail: Detail }) {
  if (stepId === 1)
    return (
      <DataPanel
        icon={<Target className="h-4 w-4" />}
        title="Thông tin cần tìm hiểu"
        description="Mỗi lượt chỉ hỏi một câu và không hỏi lại dữ liệu khách đã cung cấp."
      >
        <div className="flex flex-wrap gap-2">
          {[
            "Phong cách",
            "Một / hai cổng",
            "Trang phục",
            "Makeup",
            "Ngày dự kiến",
          ].map((item) => (
            <span
              key={item}
              className="border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs font-medium text-sky-800"
            >
              {item}
            </span>
          ))}
        </div>
      </DataPanel>
    );
  if (stepId === 2)
    return (
      <DataPanel
        icon={<Camera className="h-4 w-4" />}
        title="Kho ảnh mẫu đang liên kết"
        description="Ảnh được lấy đúng nhóm dịch vụ và loại khỏi danh sách khi đã có trong sent_assets."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="border-l-2 border-emerald-500 bg-emerald-50 p-3">
            <p className="text-xs text-emerald-700">Node liên kết</p>
            <p className="mt-1 text-xl font-bold">
              {
                detail.script.nodes.filter(
                  (node) => saleStepForNode(node) === 2,
                ).length
              }
            </p>
          </div>
          <div className="border-l-2 border-sky-500 bg-sky-50 p-3">
            <p className="text-xs text-sky-700">Nguồn ảnh</p>
            <p className="mt-1 font-mono text-xs font-bold">
              image_store:{detail.script.serviceKey}
            </p>
          </div>
          <div className="border-l-2 border-amber-500 bg-amber-50 p-3">
            <p className="text-xs text-amber-700">Quy tắc gửi</p>
            <p className="mt-1 text-xs font-semibold">
              Đúng nhóm · Không trùng · Không chen khi hỏi giá
            </p>
          </div>
        </div>
        <button
          onClick={() => window.location.assign("/cms/gallery")}
          className="mt-3 inline-flex items-center gap-1.5 border px-3 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-50"
        >
          <ImageIcon className="h-4 w-4" /> Mở kho ảnh
        </button>
      </DataPanel>
    );
  if (stepId === 3)
    return (
      <DataPanel
        icon={<BadgeDollarSign className="h-4 w-4" />}
        title="Nhóm bảng giá đang liên kết"
        description="Dữ liệu realtime từ Dịch vụ & Bảng giá; phần này chỉ hiển thị các gói khách lẻ."
      >
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {detail.pricing
            .filter((pkg) => pkg.audience === "retail")
            .map((pkg) => (
              <div key={pkg.id} className="border p-3">
                <div className="flex items-start justify-between gap-3">
                  <b className="text-sm">{pkg.name}</b>
                  <span
                    className={`shrink-0 px-2 py-0.5 text-[11px] font-semibold ${pkg.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}
                  >
                    {pkg.isActive ? "Đang bán" : "Tạm ẩn"}
                  </span>
                </div>
                <p className="mt-2 font-bold text-slate-900">
                  {money(pkg.price)}
                </p>
                <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                  {pkg.description || pkg.notes || "Chưa có mô tả chính."}
                </p>
              </div>
            ))}
        </div>
        <div
          className={`mt-3 flex items-center gap-2 border px-3 py-2 text-xs ${detail.group.priceImageUrl && detail.group.priceImagePublic ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}
        >
          {detail.group.priceImageUrl && detail.group.priceImagePublic ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <CircleAlert className="h-4 w-4" />
          )}
          {detail.group.priceImageUrl && detail.group.priceImagePublic
            ? "Ảnh bảng giá công khai đã liên kết. Gửi ảnh trước, chữ sau."
            : "Chưa có ảnh bảng giá công khai; không được gửi giá bằng chữ nếu ảnh thất bại."}
        </div>
      </DataPanel>
    );
  if (stepId === 4) return <PackageComparisonPanel detail={detail} />;
  if (stepId === 5)
    return (
      <DataPanel
        icon={<Sparkles className="h-4 w-4" />}
        title="Chương trình khuyến mãi"
        description="Chỉ giới thiệu chương trình còn hiệu lực và đã được duyệt."
      >
        <div
          className={`border-l-4 p-3 ${detail.promotion.configured ? "border-emerald-500 bg-emerald-50" : "border-amber-500 bg-amber-50"}`}
        >
          <p className="text-sm font-semibold">
            {detail.promotion.configured
              ? "Đã có chương trình đang áp dụng"
              : "Chưa có chương trình được kích hoạt"}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            {detail.promotion.message}
          </p>
        </div>
        <p className="mt-3 text-xs font-medium text-amber-700">
          Không tự tạo ưu đãi, không hứa quà khi chưa đủ điều kiện.
        </p>
      </DataPanel>
    );
  if (stepId === 6)
    return (
      <DataPanel
        icon={<CircleHelp className="h-4 w-4" />}
        title="Phân loại lý do phân vân"
        description="Ghi nhận điều khách lo, giải thích ngắn, đưa phương án rồi hỏi một câu dẫn tiếp."
      >
        <div className="flex flex-wrap gap-2">
          {[
            "Giá cao",
            "Cần suy nghĩ",
            "Hỏi người nhà",
            "So sánh nơi khác",
            "Chưa biết ngày",
            "Sợ ảnh không giống mẫu",
            "Không cần makeup",
            "Đã có trang phục",
            "Muốn gói rẻ hơn",
            "Muốn thêm mẫu",
            "Muốn chủ studio chụp",
          ].map((item) => (
            <span
              key={item}
              className="border bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700"
            >
              {item}
            </span>
          ))}
        </div>
      </DataPanel>
    );
  if (stepId === 7)
    return (
      <DataPanel
        icon={<CheckCircle2 className="h-4 w-4" />}
        title="Đường ra quyết định"
        description="Đưa một đề xuất chính, tạo lời kêu gọi hành động tự nhiên và không ép khách."
      >
        <div className="grid gap-2 md:grid-cols-3">
          <div className="border-l-4 border-emerald-500 bg-emerald-50 p-3">
            <b className="text-sm">Khách đồng ý</b>
            <p className="mt-1 text-xs text-slate-600">
              Chuyển sang Bảng 8 · Chốt khách
            </p>
          </div>
          <div className="border-l-4 border-amber-500 bg-amber-50 p-3">
            <b className="text-sm">Còn phân vân</b>
            <p className="mt-1 text-xs text-slate-600">
              Quay lại Bảng 6 · Phân vân
            </p>
          </div>
          <div className="border-l-4 border-sky-500 bg-sky-50 p-3">
            <b className="text-sm">Chưa phản hồi</b>
            <p className="mt-1 text-xs text-slate-600">
              Chuyển Bảng 9 · Follow-up
            </p>
          </div>
        </div>
      </DataPanel>
    );
  if (stepId === 8)
    return (
      <DataPanel
        icon={<UserRoundCheck className="h-4 w-4" />}
        title="Quy trình chốt và chuyển nhân viên"
        description="Thu thập lần lượt; không hỏi tất cả thông tin trong một tin nhắn."
      >
        <div className="grid gap-px overflow-hidden border bg-slate-200 sm:grid-cols-4">
          {["Gói khách chọn", "Ngày dự kiến", "Tên khách", "Số điện thoại"].map(
            (item, index) => (
              <div key={item} className="bg-white p-3">
                <span className="text-xs font-bold text-emerald-700">
                  0{index + 1}
                </span>
                <p className="mt-1 text-sm font-semibold">{item}</p>
              </div>
            ),
          )}
        </div>
        <div className="mt-3 flex items-center gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800">
          <ShieldCheck className="h-4 w-4" /> Có số điện thoại → lưu lead →
          thông báo nhân viên → HUMAN_HANDOFF → Lulu dừng trả lời.
        </div>
      </DataPanel>
    );
  return (
    <DataPanel
      icon={<BellRing className="h-4 w-4" />}
      title="Cài đặt follow-up"
      description="Giai đoạn này chỉ soạn và test nội dung; chưa tự động gửi Facebook thật."
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="border p-3">
          <p className="text-xs text-slate-500">Trạng thái khách</p>
          <p className="mt-1 text-sm font-semibold">
            Chưa chốt · Chưa phản hồi
          </p>
        </div>
        <div className="border p-3">
          <p className="text-xs text-slate-500">Số lần tối đa</p>
          <p className="mt-1 text-sm font-semibold">Chưa kích hoạt tự động</p>
        </div>
        <div className="border p-3">
          <p className="text-xs text-slate-500">Người phụ trách</p>
          <p className="mt-1 text-sm font-semibold">Nhân viên tiếp quản</p>
        </div>
        <div className="border p-3">
          <p className="text-xs text-slate-500">Điều kiện dừng</p>
          <p className="mt-1 text-sm font-semibold">
            Đã chốt · Từ chối · Ngừng nhận tin
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs font-semibold text-amber-700">
        Không follow-up khi đã có booking, đã HUMAN_HANDOFF hoặc nhân viên đang
        xử lý.
      </p>
    </DataPanel>
  );
}

function PricingSidebar({ detail }: { detail: Detail }) {
  return (
    <aside className="space-y-3">
      <section className="border bg-white p-3">
        <div className="flex items-center gap-2">
          <Tag className="h-4 w-4 text-rose-600" />
          <h2 className="font-bold">Bảng giá liên kết</h2>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Dữ liệu realtime từ nhóm hiện tại. Giá đối tác luôn tách riêng.
        </p>
        <div className="mt-3 space-y-2">
          {detail.pricing.map((pkg) => (
            <div
              key={pkg.id}
              className={`border-l-2 px-2 py-2 text-xs ${pkg.audience === "partner" ? "border-amber-400 bg-amber-50" : "border-emerald-400 bg-emerald-50"}`}
            >
              <div className="flex justify-between gap-2">
                <b className="line-clamp-2">{pkg.name}</b>
                <span className="shrink-0 font-semibold">
                  {money(pkg.price)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                {pkg.audience === "partner"
                  ? "Giá đối tác - không gửi khách lẻ"
                  : pkg.isActive
                    ? "Retail đang bán"
                    : "Đang tạm ẩn"}
              </p>
            </div>
          ))}
        </div>
        {detail.group.priceImageUrl ? (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-700">
            <ImageIcon className="h-3.5 w-3.5" /> Ảnh bảng giá đã liên kết
          </p>
        ) : (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-rose-700">
            <CircleAlert className="h-3.5 w-3.5" /> Chưa có ảnh bảng giá công
            khai
          </p>
        )}
      </section>
      <section className="border bg-white p-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <h2 className="font-bold">Khuyến mãi sau báo giá</h2>
        </div>
        <p className="mt-2 text-xs leading-5 text-gray-500">
          {detail.promotion.message}
        </p>
        <p className="mt-2 text-xs font-semibold text-amber-700">
          Không tự tạo ưu đãi hoặc gửi follow-up thật.
        </p>
      </section>
      <section className="border bg-white p-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-slate-600" />
          <h2 className="font-bold">Phiên bản</h2>
        </div>
        <p className="mt-2 text-sm">
          Đang dùng: <b>v{detail.script.activeVersion}</b>
        </p>
        <p className="mt-1 text-sm">
          Bản nháp:{" "}
          <b>
            {detail.script.draftVersion
              ? `v${detail.script.draftVersion}`
              : "chưa có"}
          </b>
        </p>
        <p className="mt-2 text-xs text-gray-500">
          Lưu node sẽ tạo hoặc cập nhật bản nháp. Bản đang dùng không bị sửa
          trực tiếp.
        </p>
      </section>
    </aside>
  );
}

function ModeSwitch({
  mode,
  onChange,
}: {
  mode: EditorMode;
  onChange: (mode: EditorMode) => void;
}) {
  return (
    <div className="inline-flex border bg-white p-0.5 text-sm">
      <button
        onClick={() => onChange("sheet")}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 font-medium ${mode === "sheet" ? "bg-emerald-700 text-white" : "text-gray-600 hover:bg-gray-50"}`}
      >
        <TableProperties className="h-4 w-4" /> Bảng hỏi - đáp
      </button>
      <button
        onClick={() => onChange("details")}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 font-medium ${mode === "details" ? "bg-violet-700 text-white" : "text-gray-600 hover:bg-gray-50"}`}
      >
        <BookOpen className="h-4 w-4" /> Sổ tay chi tiết
      </button>
    </div>
  );
}

const COMMON_GREETING_STEP = {
  ...SALE_STEPS[0],
  label: "Chào hỏi",
  title: "Chào hỏi khách hàng",
  objective: "Chào khách mới và xử lý các câu mở đầu.",
  usage: "Khi khách mới nhắn tin nhưng chưa nói rõ dịch vụ.",
  completion: "Khách đã được chào một lần và sẵn sàng chuyển sang bước phân loại.",
};

function ServiceRoutingSheet({
  table,
  routes,
  saving,
  onSave,
  onTest,
}: {
  table: CommonScriptTable;
  routes: ServiceRoute[];
  saving: boolean;
  onSave: (rows: QuestionAnswerRow[]) => Promise<void>;
  onTest: (message: string) => void;
}) {
  const blankRow = (suffix: string): QuestionAnswerRow => ({
    id: `routing-${suffix}`,
    stepId: 1,
    question: "",
    answer: "",
    serviceKey: "",
    routeKey: "",
  });
  const makeRows = () => {
    const usedIds = new Set(table.questionAnswerRows.map((row) => row.id));
    const blankRows = Array.from(
      { length: Math.max(2, 5 - table.questionAnswerRows.length) },
      (_item, index) => {
        const baseSuffix = `blank-${index + 1}`;
        let suffix = baseSuffix;
        let duplicate = 1;
        while (usedIds.has(`routing-${suffix}`)) {
          duplicate += 1;
          suffix = `${baseSuffix}-${duplicate}`;
        }
        const row = blankRow(suffix);
        usedIds.add(row.id);
        return row;
      },
    );
    return [...table.questionAnswerRows, ...blankRows];
  };
  const [rows, setRows] = useState<QuestionAnswerRow[]>(makeRows);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setRows(makeRows());
    setSelectedRowIds(new Set());
  }, [table.key, table.questionAnswerRows, routes]);

  const change = (index: number, patch: Partial<QuestionAnswerRow>) =>
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const chooseService = (index: number, serviceKey: string) => {
    const route = routes.find((item) => item.serviceKey === serviceKey);
    change(index, { serviceKey, routeKey: route?.routeKey ?? "" });
  };
  const addRow = () => setRows((current) => [...current, blankRow(`new-${Date.now()}`)]);
  const cloneRow = (row: QuestionAnswerRow) =>
    setRows((current) => [...current, { ...row, id: `routing-copy-${Date.now()}` }]);
  const removeRow = (id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
    setSelectedRowIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };
  const pasteRows = (text: string) => {
    const pasted = text.replace(/\r/g, "").split("\n").filter(Boolean).map((line, index) => {
      const [question = "", answer = "", serviceKey = ""] = line.split("\t");
      const route = routes.find((item) => item.serviceKey === serviceKey);
      return {
        id: `routing-paste-${Date.now()}-${index}`,
        stepId: 1,
        question,
        answer,
        serviceKey: route?.serviceKey ?? "",
        routeKey: route?.routeKey ?? "",
      };
    });
    if (pasted.length) setRows((current) => [...current.filter((row) => row.question.trim() || row.answer.trim()), ...pasted]);
  };
  const saveRows = async () => {
    await onSave(rows.filter((row) => row.question.trim() && row.answer.trim()));
  };
  const filledRows = rows.filter((row) => row.question.trim() && row.answer.trim());
  const inactiveRows = filledRows.filter((row) => !row.serviceKey || !row.routeKey);
  const filledRowIds = filledRows.map((row) => row.id);
  const allFilledRowsSelected = filledRowIds.length > 0 && filledRowIds.every((id) => selectedRowIds.has(id));
  const toggleRow = (id: string) => setSelectedRowIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleAllFilledRows = () => setSelectedRowIds(
    allFilledRowsSelected ? new Set() : new Set(filledRowIds),
  );
  const removeSelectedRows = () => {
    if (!selectedRowIds.size) return;
    setRows((current) => {
      const remaining = current.filter((row) => !selectedRowIds.has(row.id));
      if (remaining.length >= 2) return remaining;
      return [...remaining, ...Array.from({ length: 2 - remaining.length }, (_item, index) => blankRow(`after-delete-${Date.now()}-${index}`))];
    });
    setSelectedRowIds(new Set());
  };

  const fields = (row: QuestionAnswerRow, index: number) => [
      <label key="question" className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase text-slate-500 md:hidden">Khách có thể nói</span>
        <textarea
          id={index === 0 ? "routing-question-0" : undefined}
          aria-label={`Khách có thể nói ${index + 1}`}
          value={row.question}
          onChange={(event) => change(index, { question: event.target.value })}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text/plain");
            if (text.includes("\t")) {
              event.preventDefault();
              pasteRows(text);
            }
          }}
          rows={3}
          placeholder="Ví dụ: Cho em hỏi chụp cổng."
          className="min-h-24 w-full resize-y border-0 bg-transparent p-3 text-sm leading-5 outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500 md:min-h-28"
        />
      </label>,
      <label key="answer" className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase text-slate-500 md:hidden">Lulu trả lời</span>
        <textarea
          aria-label={`Lulu trả lời ${index + 1}`}
          value={row.answer}
          onChange={(event) => change(index, { answer: event.target.value })}
          rows={3}
          placeholder="Câu Lulu trả lời"
          className="min-h-24 w-full resize-y border-0 bg-cyan-50/40 p-3 text-sm leading-5 outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500 md:min-h-28"
        />
      </label>,
      <label key="service" className="block p-3">
        <span className="mb-1 block text-[11px] font-bold uppercase text-slate-500 md:hidden">Dịch vụ nhận diện</span>
        <select
          aria-label={`Dịch vụ nhận diện ${index + 1}`}
          value={row.serviceKey ?? ""}
          onChange={(event) => chooseService(index, event.target.value)}
          className="h-10 w-full border bg-white px-2 text-xs font-semibold text-slate-800 outline-none focus:border-cyan-600"
        >
          <option value="" disabled>Chọn dịch vụ</option>
          {routes.map((route) => <option key={route.serviceKey} value={route.serviceKey}>{route.label}</option>)}
        </select>
      </label>,
      <label key="route" className="block p-3">
        <span className="mb-1 block text-[11px] font-bold uppercase text-slate-500 md:hidden">Kịch bản chuyển đến</span>
        <select
          aria-label={`Kịch bản chuyển đến ${index + 1}`}
          value={row.routeKey ?? ""}
          onChange={(event) => {
            const route = routes.find((item) => item.routeKey === event.target.value);
            change(index, { routeKey: event.target.value, serviceKey: route?.serviceKey ?? row.serviceKey });
          }}
          className="h-10 w-full border bg-white px-2 font-mono text-xs text-slate-700 outline-none focus:border-cyan-600"
        >
          <option value="" disabled>Chọn kịch bản</option>
          {routes.map((route) => <option key={route.routeKey} value={route.routeKey}>{route.routeKey}</option>)}
        </select>
      </label>,
  ];

  return (
    <section className="border bg-white">
      <div className="border-b bg-slate-50 px-3 py-4 sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-cyan-700 text-white"><GitFork className="h-5 w-5" /></div>
            <div>
              <p className="text-xs font-semibold uppercase text-cyan-700">Bảng chung 2</p>
              <h2 className="mt-0.5 text-lg font-bold text-slate-900">Phân loại dịch vụ</h2>
              <p className="mt-1 text-sm text-slate-600">{table.description}</p>
              <p className="mt-2 text-xs font-medium text-slate-500">{filledRows.length} câu · {table.routeCount ?? routes.length} nhánh dịch vụ đã cấu hình</p>
            </div>
          </div>
          <div className="grid w-full grid-cols-3 gap-1.5 sm:w-auto sm:flex">
            <button aria-label="Chọn tất cả dòng có nội dung" title="Chọn tất cả dòng có nội dung" onClick={toggleAllFilledRows} disabled={!filledRows.length} className="inline-flex h-10 items-center justify-center gap-1 border bg-white px-2 text-xs font-semibold text-slate-700 disabled:opacity-40"><CheckCircle2 className="h-4 w-4" /><span className="hidden sm:inline">{allFilledRowsSelected ? "Bỏ chọn" : "Chọn tất cả"}</span></button>
            <button aria-label="Xóa các dòng đã chọn" title="Xóa các dòng đã chọn" onClick={removeSelectedRows} disabled={!selectedRowIds.size} className="inline-flex h-10 items-center justify-center gap-1 border border-rose-200 bg-rose-50 px-2 text-xs font-semibold text-rose-700 disabled:opacity-40"><Trash2 className="h-4 w-4" /><span className="hidden sm:inline">Xóa đã chọn ({selectedRowIds.size})</span></button>
            <button aria-label="Thêm câu" title="Thêm câu" onClick={addRow} className="inline-flex h-10 items-center justify-center gap-1 border bg-white px-2 text-xs font-semibold text-slate-700"><Plus className="h-4 w-4" /><span className="hidden sm:inline">Thêm câu</span></button>
            <button aria-label="Dán từ Excel" title="Dán từ Excel" onClick={() => document.getElementById("routing-question-0")?.focus()} className="inline-flex h-10 items-center justify-center gap-1 border bg-white px-2 text-xs font-semibold text-slate-700"><ClipboardPaste className="h-4 w-4" /><span className="hidden sm:inline">Dán từ Excel</span></button>
            <button aria-label="Test bước" title="Test bước" onClick={() => onTest(filledRows[0]?.question || "Cho em xin giá chụp cổng")} className="inline-flex h-10 items-center justify-center gap-1 border border-cyan-200 bg-cyan-50 px-2 text-xs font-semibold text-cyan-800"><FlaskConical className="h-4 w-4" /><span className="hidden sm:inline">Test bước</span></button>
            <button aria-label="Lưu bước" disabled={saving} title="Lưu bước" onClick={saveRows} className="inline-flex h-10 items-center justify-center gap-1 bg-cyan-700 px-2 text-xs font-semibold text-white disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}<span className="hidden sm:inline">Lưu bước</span></button>
          </div>
        </div>
      </div>
      <div className="space-y-3 p-3 md:hidden">
        {rows.map((row, index) => (
          <article key={row.id} className="border bg-white">
            <div className="grid gap-px bg-slate-200">{fields(row, index)}</div>
            <div className="flex items-center justify-end gap-1 border-t bg-slate-50 p-2">
              <label className="mr-auto inline-flex items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={selectedRowIds.has(row.id)} onChange={() => toggleRow(row.id)} className="h-4 w-4 accent-rose-600" />Chọn dòng</label>
              <button onClick={() => onTest(row.question)} disabled={!row.question.trim()} className="border bg-white p-2 text-cyan-700 disabled:opacity-30" aria-label="Test câu"><FlaskConical className="h-4 w-4" /></button>
              <button onClick={() => cloneRow(row)} className="border bg-white p-2 text-slate-600" aria-label="Nhân bản"><Copy className="h-4 w-4" /></button>
              <button onClick={() => removeRow(row.id)} className="border border-rose-100 bg-white p-2 text-rose-700" aria-label="Xóa dòng"><Trash2 className="h-4 w-4" /></button>
            </div>
          </article>
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-[960px] w-full table-fixed border-collapse text-sm">
          <colgroup><col className="w-[23%]" /><col className="w-[27%]" /><col className="w-[18%]" /><col className="w-[20%]" /><col className="w-[12%]" /></colgroup>
          <thead className="bg-cyan-50 text-left text-xs font-bold uppercase text-cyan-950"><tr><th className="border-b border-r p-3">Khách có thể nói</th><th className="border-b border-r p-3">Lulu trả lời</th><th className="border-b border-r p-3">Dịch vụ nhận diện</th><th className="border-b border-r p-3">Kịch bản chuyển đến</th><th className="border-b p-3 text-center">Thao tác</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={row.id} className={`align-top ${selectedRowIds.has(row.id) ? "bg-rose-50/50" : ""}`}><td className="border-b border-r p-0">{fields(row, index)[0]}</td><td className="border-b border-r p-0">{fields(row, index)[1]}</td><td className="border-b border-r p-0">{fields(row, index)[2]}</td><td className="border-b border-r p-0">{fields(row, index)[3]}</td><td className="border-b p-2"><div className="flex flex-wrap justify-center gap-1"><label className="inline-flex h-9 items-center border bg-white px-2" title="Chọn dòng"><input type="checkbox" aria-label={`Chọn dòng ${index + 1}`} checked={selectedRowIds.has(row.id)} onChange={() => toggleRow(row.id)} className="h-4 w-4 accent-rose-600" /></label><button onClick={() => onTest(row.question)} disabled={!row.question.trim()} className="border bg-white p-2 text-cyan-700 disabled:opacity-30" aria-label="Test câu"><FlaskConical className="h-4 w-4" /></button><button onClick={() => cloneRow(row)} className="border bg-white p-2 text-slate-600" aria-label="Nhân bản"><Copy className="h-4 w-4" /></button><button onClick={() => removeRow(row.id)} className="border border-rose-100 bg-white p-2 text-rose-700" aria-label="Xóa dòng"><Trash2 className="h-4 w-4" /></button></div></td></tr>)}</tbody>
        </table>
      </div>
      <p className={`border-t px-3 py-2 text-xs ${inactiveRows.length ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-500"}`}>{inactiveRows.length ? `${inactiveRows.length} câu chưa chọn dịch vụ vẫn được lưu, nhưng Lulu chưa sử dụng.` : "Dán từ Excel theo thứ tự: câu khách nói, câu Lulu trả lời, mã dịch vụ. Route luôn được đồng bộ từ danh mục."}</p>
    </section>
  );
}

function CommonTestDialog({ message, onClose }: { message: string | null; onClose: () => void }) {
  const [input, setInput] = useState(message ?? "");
  const [result, setResult] = useState<CommonTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  const runTest = async (value: string) => {
    if (!value.trim()) return;
    setTesting(true);
    setError("");
    try {
      setResult(await request<CommonTestResult>("/sale-scripts/common/test", { method: "POST", body: JSON.stringify({ message: value }) }));
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Không thể chạy test");
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (!message) return;
    setInput(message);
    setResult(null);
    void runTest(message);
  }, [message]);

  if (!message) return null;
  const items = result ? [
    ["Tin nhắn khách", result.message],
    ["Ý định nhận diện", result.intent],
    ["Dịch vụ nhận diện", result.serviceLabel ?? result.service ?? "Chưa rõ"],
    ["Độ tin cậy", `${Math.round(result.confidence * 100)}%`],
    ["Nhánh chuyển đến", result.route ?? "Chưa có route"],
    ["Có hỏi lại hay không", result.askServiceAgain ? "Có" : "Không"],
    ["Lý do hỏi lại", result.askReason ?? "Không cần hỏi lại"],
  ] : [];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 p-0 sm:items-center sm:p-4">
      <section className="max-h-[92vh] w-full max-w-4xl overflow-y-auto border bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-4 py-3"><div><p className="text-xs font-bold uppercase text-cyan-700">Test bước</p><h2 className="text-lg font-bold text-slate-900">Kiểm tra phân loại và rẽ nhánh</h2></div><button onClick={onClose} className="border p-2 text-slate-600" aria-label="Đóng"><X className="h-4 w-4" /></button></header>
        <div className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row"><input value={input} onChange={(event) => setInput(event.target.value)} className="h-11 flex-1 border px-3 text-sm outline-none focus:border-cyan-600" /><button onClick={() => runTest(input)} disabled={testing || !input.trim()} className="inline-flex h-11 items-center justify-center gap-2 bg-cyan-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />} Chạy test</button></div>
          {error && <p className="border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
          {result && <><div className="grid gap-px border bg-slate-200 sm:grid-cols-2">{items.map(([label, value]) => <div key={label} className="bg-white p-3"><p className="text-[11px] font-bold uppercase text-slate-500">{label}</p><p className="mt-1 break-words text-sm font-semibold text-slate-900">{value}</p></div>)}</div><div className="grid gap-3 lg:grid-cols-2"><div><h3 className="mb-2 text-sm font-bold text-slate-800">Trạng thái trước xử lý</h3><pre className="max-h-72 overflow-auto border bg-slate-950 p-3 text-xs leading-5 text-slate-100">{JSON.stringify(result.stateBefore, null, 2)}</pre></div><div><h3 className="mb-2 text-sm font-bold text-slate-800">Trạng thái sau xử lý</h3><pre className="max-h-72 overflow-auto border bg-slate-950 p-3 text-xs leading-5 text-slate-100">{JSON.stringify(result.stateAfter, null, 2)}</pre></div></div><div className="border-l-4 border-cyan-600 bg-cyan-50 p-3"><p className="text-xs font-bold uppercase text-cyan-800">Lulu trả lời</p><p className="mt-1 text-sm leading-6 text-slate-800">{result.reply}</p></div></>}
        </div>
      </section>
    </div>
  );
}

function CommonEditor({
  common,
  initialTable,
  onBack,
  onSave,
  onSaveQuestionAnswerRows,
  saving,
  onTest,
}: {
  common: Dashboard["common"];
  initialTable: CommonScriptTable["key"];
  onBack: () => void;
  onSave: (node: ScriptNode, value: SaveValue) => Promise<void>;
  onSaveQuestionAnswerRows: (rows: QuestionAnswerRow[], tableKey: CommonScriptTable["key"]) => Promise<void>;
  saving: boolean;
  onTest: (message: string) => void;
}) {
  const [mode, setMode] = useState<EditorMode>("sheet");
  const [selectedTableKey, setSelectedTableKey] = useState<CommonScriptTable["key"]>(initialTable);
  const table = common.tables.find((item) => item.key === selectedTableKey) ?? common.tables[0];
  const tableNodes = common.nodes.filter((item) => table?.nodeKeys.includes(item.nodeKey));
  const [selected, setSelected] = useState(tableNodes[0]?.nodeKey ?? "");
  const node = tableNodes.find((item) => item.nodeKey === selected) ?? tableNodes[0];

  useEffect(() => {
    setSelectedTableKey(initialTable);
  }, [initialTable]);
  useEffect(() => {
    if (tableNodes.length) setSelected(tableNodes[0].nodeKey);
  }, [selectedTableKey]);

  if (!table) return <EmptyState message="Chưa có bảng cho kịch bản chung." />;
  if (!node) return <EmptyState message="Chưa có node cho kịch bản chung." />;
  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-violet-700"
      >
        <ArrowLeft className="h-4 w-4" /> Về tổng quan
      </button>
      <header className="flex flex-wrap items-end justify-between gap-3 border-b pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-600">
            COMMON_SALE_SCRIPT
          </p>
          <h1 className="mt-1 text-2xl font-bold">Kịch bản chung của Lulu</h1>
          <p className="mt-1 text-sm text-gray-500">
            2 bước dùng chung · Chào hỏi và phân loại dịch vụ trước khi vào kịch bản riêng.
          </p>
        </div>
        <ModeSwitch mode={mode} onChange={setMode} />
      </header>
      <section className="grid gap-2 sm:grid-cols-2" aria-label="Chọn bảng kịch bản chung">
        {common.tables.map((item, index) => {
          const active = item.key === selectedTableKey;
          const count = item.questionAnswerRows.length;
          return (
            <button
              key={item.key}
              onClick={() => { setSelectedTableKey(item.key); setMode("sheet"); }}
              aria-pressed={active}
              className={`min-h-24 border p-3 text-left transition ${active ? index === 0 ? "border-rose-600 bg-rose-50" : "border-cyan-700 bg-cyan-50" : "bg-white hover:bg-slate-50"}`}
            >
              <span className="flex items-start gap-3">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center ${index === 0 ? "bg-rose-100 text-rose-700" : "bg-cyan-100 text-cyan-800"}`}>
                  {index === 0 ? <MessageSquareText className="h-4 w-4" /> : <GitFork className="h-4 w-4" />}
                </span>
                <span className="min-w-0">
                  <b className="block text-sm text-slate-900">{item.shortTitle === "Chào hỏi" ? item.title : item.shortTitle}</b>
                  <span className="mt-1 block text-xs leading-5 text-slate-600">{item.description}</span>
                  <span className="mt-1 block text-[11px] font-semibold text-slate-500">{count} câu{item.routeCount !== null ? ` · ${item.routeCount} nhánh` : ""}</span>
                </span>
              </span>
            </button>
          );
        })}
      </section>
      {mode === "sheet" ? (
        table.key === "COMMON.SERVICE_ROUTING" ? (
          <ServiceRoutingSheet
            table={table}
            routes={common.serviceRoutes}
            saving={saving}
            onSave={(rows) => onSaveQuestionAnswerRows(rows, table.key)}
            onTest={onTest}
          />
        ) : (
          <StepQuestionAnswerSheet
            step={COMMON_GREETING_STEP}
            nodes={tableNodes}
            questionAnswerRows={table.questionAnswerRows}
            onSave={onSave}
            onSaveQuestionAnswerRows={(rows) => onSaveQuestionAnswerRows(rows, table.key)}
            onTest={(selectedNode) => onTest(questionFor(selectedNode ?? node))}
            onOpenAdvanced={(selectedNode) => {
              setSelected(selectedNode.nodeKey);
              setMode("details");
            }}
            saving={saving}
          />
        )
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="border bg-white p-2">
            {tableNodes.map((item) => (
              <button
                key={item.nodeKey}
                onClick={() => setSelected(item.nodeKey)}
                className={`mb-1 w-full border-l-2 px-3 py-3 text-left text-sm ${selected === item.nodeKey ? "border-violet-600 bg-violet-50 text-violet-800" : "border-transparent hover:bg-gray-50"}`}
              >
                <b className="block">{item.title}</b>
                <span className="mt-1 block truncate font-mono text-[11px] text-gray-500">
                  {item.nodeKey}
                </span>
              </button>
            ))}
          </aside>
          <NodeEditor
            node={node}
            saving={saving}
            onSave={(value) => onSave(node, value)}
            onTest={() => onTest(questionFor(node))}
          />
        </div>
      )}
    </div>
  );
}

function GroupEditor({
  detail,
  onBack,
  onSave,
  onSaveQuestionAnswerRows,
  saving,
  onTest,
}: {
  detail: Detail;
  onBack: () => void;
  onSave: (node: ScriptNode, value: SaveValue) => Promise<void>;
  onSaveQuestionAnswerRows: (rows: QuestionAnswerRow[]) => Promise<void>;
  saving: boolean;
  onTest: (node: ScriptNode) => void;
}) {
  const [activeStep, setActiveStep] = useState(1);
  const [advancedNodeKey, setAdvancedNodeKey] = useState<string | null>(null);
  const nodesByStep = useMemo(
    () =>
      new Map(
        SALE_STEPS.map((step) => [
          step.id,
          detail.script.nodes.filter(
            (node) => saleStepForNode(node) === step.id,
          ),
        ]),
      ),
    [detail.script.nodes],
  );
  useEffect(() => {
    setActiveStep(1);
    setAdvancedNodeKey(null);
  }, [detail.group.id]);
  const currentStep =
    SALE_STEPS.find((step) => step.id === activeStep) ?? SALE_STEPS[0];
  const currentNodes = nodesByStep.get(currentStep.id) ?? [];
  const advancedNode = advancedNodeKey
    ? detail.script.nodes.find((item) => item.nodeKey === advancedNodeKey)
    : undefined;
  const testNode = currentNodes[0];
  const openStep = (stepId: number) => {
    setActiveStep(stepId);
    setAdvancedNodeKey(null);
  };

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-violet-700"
      >
        <ArrowLeft className="h-4 w-4" /> Về tổng quan
      </button>
      <header className="border-b pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="hidden font-mono text-xs text-violet-600 sm:block">
              {detail.script.scriptKey} · {detail.script.serviceKey}
            </p>
            <h1 className="text-xl font-bold text-gray-900 sm:mt-1 sm:text-2xl">
              {detail.group.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs sm:text-sm">
              <StatusBadge status={detail.group.status} />
              <span className="text-gray-500">
                Dùng v{detail.script.activeVersion}
              </span>
              {detail.script.draftVersion && (
                <span className="border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">
                  Nháp v{detail.script.draftVersion}
                </span>
              )}
              <span className="text-gray-500">
                {detail.group.activePackageCount} gói
              </span>
              <span className="text-gray-500">9 bước</span>
            </div>
          </div>
          <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:flex sm:max-w-2xl sm:flex-wrap sm:justify-end">
            <button
              onClick={() =>
                document.getElementById(`save-step-${activeStep}`)?.click()
              }
              disabled={saving}
              className="inline-flex h-10 items-center justify-center gap-1.5 bg-emerald-700 px-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 sm:px-3"
            >
              <Save className="h-4 w-4" />
              <span className="sm:hidden">Lưu</span>
              <span className="hidden sm:inline">Lưu bản nháp</span>
            </button>
            <button
              onClick={() => testNode && onTest(testNode)}
              disabled={!testNode}
              className="inline-flex h-10 items-center justify-center gap-1.5 border border-violet-200 bg-violet-50 px-2 text-sm font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-50 sm:px-3"
            >
              <FlaskConical className="h-4 w-4" />
              <span className="sm:hidden">Test</span>
              <span className="hidden sm:inline">Test Brain Lab</span>
            </button>
            <button
              onClick={() =>
                window.location.assign(`/pricing?groupId=${detail.group.id}`)
              }
              className="inline-flex h-10 items-center justify-center gap-1.5 border px-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:px-3"
            >
              <ExternalLink className="h-4 w-4" />
              <span className="sm:hidden">Giá</span>
              <span className="hidden sm:inline">Bảng giá</span>
            </button>
            <button
              disabled
              title="Bản nháp được tạo tự động khi lưu lần đầu"
              className="hidden h-10 items-center gap-1.5 border px-3 text-sm font-medium text-slate-400 lg:inline-flex"
            >
              <Plus className="h-4 w-4" /> Tạo version
            </button>
            <button
              disabled
              title="Chức năng so sánh version đang được chuẩn bị"
              className="hidden h-10 items-center gap-1.5 border px-3 text-sm font-medium text-slate-400 lg:inline-flex"
            >
              <GitCompareArrows className="h-4 w-4" /> So sánh version
            </button>
          </div>
        </div>
      </header>
      {!detail.liveRepliesEnabled && (
        <div className="flex gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:text-sm">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          <span>
            <b>Chế độ thử nghiệm</b> · Chưa gửi Facebook thật.
            <span className="hidden sm:inline">
              {" "}
              Bạn chỉ lưu bản nháp và test trong Brain Lab.
            </span>
          </span>
        </div>
      )}
      <SaleProcessStepper
        detail={detail}
        activeStep={activeStep}
        onChange={openStep}
      />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="order-1 xl:order-2">
          {advancedNode ? (
            <section className="border bg-white">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-violet-50 px-3 py-3 sm:px-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">
                    Thiết lập nâng cao · Bảng {activeStep}
                  </p>
                  <p className="mt-0.5 hidden text-sm text-slate-600 sm:block">
                    Thông tin kỹ thuật chỉ hiện khi bạn chủ động mở.
                  </p>
                </div>
                <button
                  onClick={() => setAdvancedNodeKey(null)}
                  className="inline-flex items-center gap-1.5 border bg-white px-3 py-2 text-sm font-medium text-slate-700"
                >
                  <ArrowLeft className="h-4 w-4" /> Về bảng hỏi - đáp
                </button>
              </div>
              <NodeEditor
                node={advancedNode}
                saving={saving}
                onSave={(value) => onSave(advancedNode, value)}
                onTest={() => onTest(advancedNode)}
              />
            </section>
          ) : (
            <StepQuestionAnswerSheet
              step={currentStep}
              nodes={currentNodes}
              questionAnswerRows={detail.script.questionAnswerRows}
              onSave={onSave}
              onSaveQuestionAnswerRows={onSaveQuestionAnswerRows}
              onTest={(candidate) => {
                if (candidate) onTest(candidate);
              }}
              onOpenAdvanced={(selectedNode) =>
                setAdvancedNodeKey(selectedNode.nodeKey)
              }
              saving={saving}
            />
          )}
        </div>
        <div className="order-2 xl:order-1 xl:col-span-2">
          <StepDataPanel stepId={activeStep} detail={detail} />
        </div>
        <div className="order-3">
          <PricingSidebar detail={detail} />
        </div>
      </div>
    </div>
  );
}

export default function SaleScriptsPage() {
  const [location, setLocation] = useLocation();
  const commonRoute = location.split("?")[0] === "/sale-scripts/common";
  const commonTableParam = new URLSearchParams(location.split("?")[1] ?? "").get("table");
  const commonTableKey: CommonScriptTable["key"] = commonTableParam === "COMMON.SERVICE_ROUTING"
    ? "COMMON.SERVICE_ROUTING"
    : "COMMON.GREETING";
  const groupId = /^\/sale-scripts\/(\d+)$/.exec(location)?.[1] ?? null;
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [commonTestMessage, setCommonTestMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotice(null);
    const path =
      commonRoute || !groupId ? "/sale-scripts" : `/sale-scripts/${groupId}`;
    request<Dashboard | Detail>(path)
      .then((data) => {
        if (cancelled) return;
        if (commonRoute || !groupId) {
          setDashboard(data as Dashboard);
          setDetail(null);
        } else {
          setDetail(data as Detail);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setNotice({ kind: "error", text: error.message });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [commonRoute, groupId]);

  const back = () => setLocation("/sale-scripts");
  const openTest = (node: ScriptNode | undefined) => {
    const query = new URLSearchParams({
      tab: "fixtest",
      scriptKey: node?.scriptKey ?? "COMMON_SALE_SCRIPT",
      nodeKey: node?.nodeKey ?? "",
    });
    setLocation(`/lulu-brain-lab?${query.toString()}`);
  };
  const save = async (node: ScriptNode, value: SaveValue) => {
    setSaving(true);
    setNotice(null);
    const path = commonRoute
      ? `/sale-scripts/common/nodes/${encodeURIComponent(node.nodeKey)}`
      : `/sale-scripts/${detail?.group.id}/nodes/${encodeURIComponent(node.nodeKey)}`;
    try {
      await request(path, { method: "PUT", body: JSON.stringify(value) });
      setNotice({
        kind: "ok",
        text: "Đã lưu vào bản nháp. Tải lại trang vẫn còn dữ liệu.",
      });
      const refreshPath = commonRoute
        ? "/sale-scripts"
        : `/sale-scripts/${detail?.group.id}`;
      const refreshed = await request<Dashboard | Detail>(refreshPath);
      if (commonRoute) setDashboard(refreshed as Dashboard);
      else setDetail(refreshed as Detail);
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Không thể lưu bản nháp",
      });
      throw error;
    } finally {
      setSaving(false);
    }
  };
  const saveQuestionAnswerRows = async (
    rows: QuestionAnswerRow[],
    tableKey?: CommonScriptTable["key"],
  ) => {
    setSaving(true);
    setNotice(null);
    const path = commonRoute
      ? `/sale-scripts/common/question-answer-sheet/${encodeURIComponent(tableKey ?? "COMMON.GREETING")}`
      : `/sale-scripts/${detail?.group.id}/question-answer-sheet`;
    try {
      await request(path, { method: "PUT", body: JSON.stringify({ rows }) });
      setNotice({
        kind: "ok",
        text: `Đã lưu ${rows.length} dòng hỏi - đáp vào bản nháp.`,
      });
      const refreshPath = commonRoute
        ? "/sale-scripts"
        : `/sale-scripts/${detail?.group.id}`;
      const refreshed = await request<Dashboard | Detail>(refreshPath);
      if (commonRoute) setDashboard(refreshed as Dashboard);
      else setDetail(refreshed as Detail);
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "Không thể lưu bảng hỏi - đáp",
      });
      throw error;
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="flex min-h-[320px] items-center justify-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Đang tải Kịch bản Sale...
      </div>
    );
  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-4 hidden items-center gap-2 text-sm text-gray-500 sm:flex">
        <Layers3 className="h-4 w-4" /> Facebook &amp; Sale{" "}
        <ChevronRight className="h-4 w-4" />{" "}
        <span className="font-medium text-gray-800">Kịch bản Sale</span>
      </div>
      {notice && (
        <div
          className={`mb-4 flex items-center gap-2 border px-3 py-2 text-sm ${notice.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}
        >
          {notice.kind === "ok" ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <CircleAlert className="h-4 w-4" />
          )}
          {notice.text}
        </div>
      )}
      {commonRoute && dashboard ? (
        <CommonEditor
          common={dashboard.common}
          initialTable={commonTableKey}
          onBack={back}
          onSave={save}
          onSaveQuestionAnswerRows={saveQuestionAnswerRows}
          saving={saving}
          onTest={setCommonTestMessage}
        />
      ) : detail ? (
        <GroupEditor
          detail={detail}
          onBack={back}
          onSave={save}
          onSaveQuestionAnswerRows={saveQuestionAnswerRows}
          saving={saving}
          onTest={openTest}
        />
      ) : dashboard ? (
        <DashboardPage
          dashboard={dashboard}
          onOpenGroup={(id) => setLocation(`/sale-scripts/${id}`)}
          onOpenCommon={(tableKey) => setLocation(`/sale-scripts/common?table=${encodeURIComponent(tableKey)}`)}
        />
      ) : (
        <EmptyState message="Không tìm thấy dữ liệu Kịch bản Sale." />
      )}
      <CommonTestDialog message={commonTestMessage} onClose={() => setCommonTestMessage(null)} />
    </div>
  );
}
