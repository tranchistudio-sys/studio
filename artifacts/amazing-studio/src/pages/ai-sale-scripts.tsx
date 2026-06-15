import { useRef, useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Bot, Save, Loader2, ChevronDown, ImagePlus, X, FileText, ShieldCheck, AlertCircle, CheckCircle2, Settings2, MessageSquare, Zap, Bug, ShoppingBag, MessagesSquare, UserRound, Star, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("amazingStudioToken_v2");
  const headers = {
    ...(opts.headers as Record<string, string> ?? {}),
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return fetch(url, { ...opts, headers });
}

function sanitizeNumber(value: string, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (isNaN(n) || value.trim() === "") return fallback;
  return Math.min(max, Math.max(min, n));
}

const STEP_LABELS: Record<number, string> = {
  1: "Bước 1 – Chào hỏi",
  2: "Bước 2 – Khai thác nhu cầu",
  3: "Bước 3 – Xác nhận nhóm DV",
  4: "Bước 4 – Báo giá",
  5: "Bước 5 – Chốt mềm",
  6: "Bước 6 – Xử lý từ chối",
  7: "Bước 7 – Follow-up",
};

const STEP_IS_COMMON: Record<number, boolean> = {
  1: true, 2: true, 3: true,
  4: false, 5: false, 6: false, 7: false,
};

type AiSettings = {
  minDelayMs: number;
  maxDelayMs: number;
  typingIndicator: boolean;
  chunkMessages: boolean;
  maxSentencesPerBubble: number;
  pronounStyle: "em_ban" | "minh_ban" | "custom";
  customPronounSelf: string;
  customPronounCustomer: string;
  useEmoji: boolean;
  bannedKeywords: string[];
  autoPriceQuote: boolean;
  maxDiscountPercent: number;
  priceImageSteps: number[];
  autoSendPriceImage: boolean;
  priceImageSendSteps: number[];
  sendPriceTextAfterImage: boolean;
  fallbackMessages: string[];
  gptErrorMessages: string[];
  saveUnknownQuestions: boolean;
  logDecisions: boolean;
  forceQaOnly: boolean;
  forceGptOnly: boolean;
};

function defaultAiSettings(): AiSettings {
  return {
    minDelayMs: 800,
    maxDelayMs: 2500,
    typingIndicator: true,
    chunkMessages: true,
    maxSentencesPerBubble: 3,
    pronounStyle: "em_ban",
    customPronounSelf: "em",
    customPronounCustomer: "bạn",
    useEmoji: false,
    bannedKeywords: ["trợ lý AI", "ChatGPT", "OpenAI"],
    autoPriceQuote: true,
    maxDiscountPercent: 10,
    priceImageSteps: [4],
    autoSendPriceImage: false,
    priceImageSendSteps: [4],
    sendPriceTextAfterImage: true,
    fallbackMessages: [
      "Dạ bạn chờ em xíu nha, em kiểm tra lại cho mình ạ",
      "Dạ để em xem lại thông tin chính xác rồi báo mình liền nha",
    ],
    gptErrorMessages: [
      "Dạ bạn chờ em xíu nha, em kiểm tra lại cho mình ạ",
      "Dạ để em xem lại thông tin chính xác rồi báo mình liền nha",
    ],
    saveUnknownQuestions: true,
    logDecisions: true,
    forceQaOnly: false,
    forceGptOnly: false,
  };
}

type ConversationMessage = { role: "user" | "assistant"; content: string };
type ConversationExample = ConversationMessage[];

type FollowUpSlot = { delayHours: number; messages: string[] };

const SERVICE_GROUPS: { value: string; label: string }[] = [
  { value: "chup_cong", label: "Chụp cổng" },
  { value: "ngoai_canh", label: "Ngoại cảnh" },
  { value: "chup_tiec", label: "Chụp tiệc" },
  { value: "beauty", label: "Beauty" },
  { value: "gia_dinh", label: "Gia đình" },
  { value: "album_studio", label: "Album Studio" },
];

function serviceGroupLabel(value: string | null | undefined): string {
  if (!value) return "";
  return SERVICE_GROUPS.find((g) => g.value === value)?.label ?? value;
}

type Script = {
  id: number;
  name: string;
  service_group: string | null;
  price_content: string | null;
  price_images: string | null;
  ai_rules: string | null;
  conversation_examples: ConversationExample[] | null;
  follow_up_message: string | null;
  step_follow_up_messages: Record<string, string> | null;
  step_follow_up_slots: Record<string, FollowUpSlot[]> | null;
  ai_settings: AiSettings | null;
  is_active: boolean;
  filled_steps?: number | string;
};

type QaRow = {
  localId: string;
  id?: number;
  step: number;
  question: string;
  answer: string;
  sort_order: number;
};

type UnknownQuestion = {
  id: number;
  script_id: number | null;
  step: number | null;
  question_text: string;
  suggested_answer: string | null;
  psid: string | null;
  status: string;
  created_at: string;
};

function makeLocalId() {
  return Math.random().toString(36).slice(2);
}

function makeEmptyRow(sortOrder: number, step = 1): QaRow {
  return { localId: makeLocalId(), step, question: "", answer: "", sort_order: sortOrder };
}

function imageUrlFromPath(objectPath: string): string {
  const clean = objectPath.replace(/^\/objects\//, "");
  return `${BASE}/api/storage/objects/${clean}`;
}

const EMPTY_SCRIPTS: Script[] = [];

function delayToDisplay(dh: number): { value: number; unit: "phút" | "giờ" } {
  if (dh < 1) {
    return { value: Math.round(dh * 60) || 1, unit: "phút" };
  }
  return { value: dh, unit: "giờ" };
}

function displayToDelayHours(value: number, unit: "phút" | "giờ"): number {
  return unit === "phút" ? value / 60 : value;
}

function StepFollowUpSlotEditor({
  slots,
  onChange,
}: {
  slots: FollowUpSlot[];
  onChange: (updater: (prev: FollowUpSlot[]) => FollowUpSlot[]) => void;
}) {
  const addSlot = () => {
    const lastDelay = slots.length > 0 ? slots[slots.length - 1].delayHours : 0;
    onChange(prev => [...prev, { delayHours: lastDelay + 24, messages: [""] }]);
  };

  const removeSlot = (idx: number) =>
    onChange(prev => prev.filter((_, i) => i !== idx));

  const updateDelayValue = (idx: number, rawVal: string, unit: "phút" | "giờ") => {
    const parsed = unit === "phút" ? (parseInt(rawVal) || 1) : (parseFloat(rawVal) || 1);
    const v = Math.max(1, parsed);
    onChange(prev => prev.map((s, i) => i === idx
      ? { ...s, delayHours: displayToDelayHours(v, unit) }
      : s));
  };

  const updateDelayUnit = (idx: number, unit: "phút" | "giờ") => {
    const currentDisplay = delayToDisplay(slots[idx]?.delayHours ?? 24);
    onChange(prev => prev.map((s, i) => i === idx
      ? { ...s, delayHours: displayToDelayHours(currentDisplay.value, unit) }
      : s));
  };

  const addMessage = (slotIdx: number) =>
    onChange(prev => prev.map((s, i) => i === slotIdx ? { ...s, messages: [...s.messages, ""] } : s));

  const removeMessage = (slotIdx: number, msgIdx: number) =>
    onChange(prev => prev.map((s, i) => i === slotIdx
      ? { ...s, messages: s.messages.filter((_, j) => j !== msgIdx) }
      : s));

  const updateMessage = (slotIdx: number, msgIdx: number, val: string) =>
    onChange(prev => prev.map((s, i) => i === slotIdx
      ? { ...s, messages: s.messages.map((m, j) => j === msgIdx ? val : m) }
      : s));

  return (
    <div className="rounded-lg border bg-background p-3 mt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <Bot className="w-3.5 h-3.5" />
          Tin follow-up khi khách im lặng ở bước này
        </div>
        <button
          type="button"
          onClick={addSlot}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium px-2 py-1 rounded-md hover:bg-primary/10 transition-colors"
        >
          <Plus size={12} /> Thêm slot
        </button>
      </div>

      {slots.length === 0 && (
        <p className="text-[11px] text-muted-foreground italic py-2 text-center">
          Chưa có slot nào. Nhấn "Thêm slot" để tạo lịch gửi.
        </p>
      )}

      <div className="space-y-2">
        {slots.map((slot, slotIdx) => {
          const display = delayToDisplay(slot.delayHours);
          return (
            <div key={slotIdx} className="border border-amber-200 dark:border-amber-800 rounded-lg p-2.5 bg-amber-50/40 dark:bg-amber-900/10">
              <div className="flex items-center gap-1.5 mb-2">
                <Clock size={12} className="text-amber-600 shrink-0" />
                <span className="text-xs text-muted-foreground">Sau</span>
                <input
                  type="number"
                  min="1"
                  value={display.value}
                  onChange={e => updateDelayValue(slotIdx, e.target.value, display.unit)}
                  className="w-16 text-xs border border-border rounded px-1.5 py-0.5 bg-background text-center font-semibold focus:outline-none focus:ring-1 focus:ring-amber-400"
                />
                <select
                  value={display.unit}
                  onChange={e => updateDelayUnit(slotIdx, e.target.value as "phút" | "giờ")}
                  className="text-xs border border-border rounded px-1.5 py-0.5 bg-background font-semibold focus:outline-none focus:ring-1 focus:ring-amber-400 cursor-pointer"
                >
                  <option value="phút">phút</option>
                  <option value="giờ">giờ</option>
                </select>
                <span className="text-xs text-muted-foreground">im lặng</span>
                <span className="text-[10px] text-muted-foreground ml-1 opacity-60">
                  ({slot.messages.filter(Boolean).length} câu)
                </span>
                <button
                  type="button"
                  onClick={() => removeSlot(slotIdx)}
                  className="ml-auto p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-400 hover:text-red-600 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </div>

              <div className="space-y-1.5">
                {slot.messages.map((msg, msgIdx) => (
                  <div key={msgIdx} className="flex items-start gap-1.5">
                    <input
                      type="text"
                      value={msg}
                      onChange={e => updateMessage(slotIdx, msgIdx, e.target.value)}
                      placeholder={`Câu ${msgIdx + 1}...`}
                      className="flex-1 text-sm border border-border rounded px-2 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-amber-400 leading-snug"
                    />
                    <button
                      type="button"
                      onClick={() => removeMessage(slotIdx, msgIdx)}
                      className="mt-1 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => addMessage(slotIdx)}
                className="mt-1.5 flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
              >
                <Plus size={11} /> Thêm câu
              </button>
            </div>
          );
        })}
      </div>

      {slots.length > 0 && (
        <p className="text-[10px] text-muted-foreground mt-2">
          Hệ thống tự random 1 câu trong pool mỗi lần gửi. Slot gửi theo thứ tự từ trên xuống.
        </p>
      )}
    </div>
  );
}


export default function AiSaleScriptsPage() {
  const queryClient = useQueryClient();

  const [viewMode, setViewMode] = useState<"script" | "shared">("script");
  const [selectedScriptId, setSelectedScriptId] = useState<number | null>(null);
  const [rows, setRows] = useState<QaRow[]>([makeEmptyRow(0)]);
  const [filterStep, setFilterStep] = useState<number | "all">("all");
  const [sharedRows, setSharedRows] = useState<QaRow[]>([makeEmptyRow(0, 1)]);
  const [sharedFilterStep, setSharedFilterStep] = useState<number | "all">("all");
  const [sharedSaveStatus, setSharedSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createServiceGroup, setCreateServiceGroup] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [serviceGroup, setServiceGroup] = useState<string>("");

  const [priceImages, setPriceImages] = useState<string[]>([]);
  const [priceContent, setPriceContent] = useState("");
  const [aiRules, setAiRules] = useState("");
  const [followUpMsg, setFollowUpMsg] = useState("");
  const [stepFollowUps, setStepFollowUps] = useState<Record<number, string>>({});
  const [stepFollowUpSlots, setStepFollowUpSlots] = useState<Record<number, FollowUpSlot[]>>({});
  const [uploadingImages, setUploadingImages] = useState(false);
  const [unknownAnswers, setUnknownAnswers] = useState<Record<number, string>>({});
  const [savingUnknown, setSavingUnknown] = useState<Record<number, boolean>>({});
  const [savedUnknown, setSavedUnknown] = useState<Record<number, boolean>>({});
  const [aiSettings, setAiSettings] = useState<AiSettings>(defaultAiSettings());
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [openSettingsSection, setOpenSettingsSection] = useState<string | null>(null);
  const [rawFallback, setRawFallback] = useState<string>("");
  const [rawGptError, setRawGptError] = useState<string>("");

  const [conversationExamples, setConversationExamples] = useState<ConversationExample[]>([]);
  const [showExampleModal, setShowExampleModal] = useState(false);
  const [editingExampleIdx, setEditingExampleIdx] = useState<number | null>(null);
  const [draftMessages, setDraftMessages] = useState<ConversationMessage[]>([
    { role: "user", content: "" },
    { role: "assistant", content: "" },
  ]);
  const [rawMinDelay, setRawMinDelay] = useState("800");
  const [rawMaxDelay, setRawMaxDelay] = useState("2500");
  const [rawMaxSentences, setRawMaxSentences] = useState("3");
  const [rawMaxDiscount, setRawMaxDiscount] = useState("10");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cellRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  const priceImagesLocalRef = useRef(false);
  const prevScriptIdRef = useRef<number | null | undefined>(undefined);

  const { data: scripts = EMPTY_SCRIPTS, isLoading: loadingScripts } = useQuery<Script[]>({
    queryKey: ["ai-scripts"],
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/ai-scripts`);
      if (!r.ok) throw new Error("Lỗi tải danh sách");
      return r.json();
    },
  });

  const { isLoading: loadingRows, data: qaRowsData } = useQuery<Array<{ id: number; step: number; question: string | null; answer: string | null; sort_order: number }>>({
    queryKey: ["qa-rows", selectedScriptId],
    enabled: selectedScriptId !== null,
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/ai-scripts/${selectedScriptId}/qa-rows`);
      if (!r.ok) throw new Error("Lỗi tải Q&A rows");
      return r.json();
    },
  });

  const { isLoading: loadingSharedRows, data: sharedQaRowsData } = useQuery<Array<{ id: number; step: number; question: string | null; answer: string | null; sort_order: number }>>({
    queryKey: ["shared-qa-rows"],
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/ai-scripts/shared-qa-rows`);
      if (!r.ok) throw new Error("Lỗi tải Q&A chung");
      return r.json();
    },
  });

  const { data: unknownQData, refetch: refetchUnknownQ } = useQuery<{ rows: UnknownQuestion[]; pending: number }>({
    queryKey: ["unknown-questions"],
    enabled: selectedScriptId !== null,
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/ai-scripts/unknown-questions`);
      if (!r.ok) return { rows: [], pending: 0 };
      return r.json();
    },
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const unknownQuestions = unknownQData?.rows ?? [];

  const filteredUnknownRows = unknownQuestions.filter(q => {
    if (q.status === "answered") return false;
    if (q.script_id !== null && q.script_id !== selectedScriptId) return false;
    if (filterStep === "all") return q.step === null || q.step >= 4;
    return q.step === filterStep;
  });

  async function saveUnknownAnswer(qId: number) {
    const answer = (unknownAnswers[qId] ?? "").trim();
    if (!answer) return;
    setSavingUnknown(prev => ({ ...prev, [qId]: true }));
    try {
      const r = await authFetch(`${BASE}/api/ai-scripts/unknown-questions/${qId}`, {
        method: "PATCH",
        body: JSON.stringify({ suggestedAnswer: answer }),
      });
      if (r.ok) {
        setSavedUnknown(prev => ({ ...prev, [qId]: true }));
        setTimeout(() => setSavedUnknown(prev => ({ ...prev, [qId]: false })), 2000);
        await refetchUnknownQ();
        queryClient.invalidateQueries({ queryKey: ["unknown-questions-count"] });
        queryClient.invalidateQueries({ queryKey: ["qa-rows", selectedScriptId] });
        queryClient.invalidateQueries({ queryKey: ["ai-scripts"] });
      }
    } finally {
      setSavingUnknown(prev => ({ ...prev, [qId]: false }));
    }
  }

  useEffect(() => {
    if (qaRowsData === undefined) return;
    const scriptRows = qaRowsData.filter((d) => d.step >= 4);
    if (scriptRows.length === 0) {
      setRows([makeEmptyRow(0, 4)]);
    } else {
      setRows(
        scriptRows.map((d, i) => ({
          localId: makeLocalId(),
          id: d.id,
          step: d.step,
          question: d.question ?? "",
          answer: d.answer ?? "",
          sort_order: d.sort_order ?? i,
        })),
      );
    }
  }, [qaRowsData]);

  useEffect(() => {
    if (sharedQaRowsData === undefined) return;
    if (sharedQaRowsData.length === 0) {
      setSharedRows([makeEmptyRow(0, 1)]);
    } else {
      setSharedRows(
        sharedQaRowsData.map((d, i) => ({
          localId: makeLocalId(),
          id: d.id,
          step: d.step,
          question: d.question ?? "",
          answer: d.answer ?? "",
          sort_order: d.sort_order ?? i,
        })),
      );
    }
  }, [sharedQaRowsData]);

  useEffect(() => {
    if (scripts.length > 0 && selectedScriptId === null) {
      setSelectedScriptId(scripts[0].id);
    }
  }, [scripts, selectedScriptId]);

  useEffect(() => {
    if (openSettingsSection === "fallback") {
      setRawFallback(Array.isArray(aiSettings.fallbackMessages) ? aiSettings.fallbackMessages.join("\n") : "");
      setRawGptError(Array.isArray(aiSettings.gptErrorMessages) ? aiSettings.gptErrorMessages.join("\n") : "");
    }
  }, [openSettingsSection]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const scriptSwitched = selectedScriptId !== prevScriptIdRef.current;
    if (scriptSwitched) {
      priceImagesLocalRef.current = false;
      prevScriptIdRef.current = selectedScriptId;
    }
    const script = scripts.find((s) => s.id === selectedScriptId);
    if (!script) {
      setServiceGroup("");
      setPriceImages([]);
      setPriceContent("");
      setAiRules("");
      setFollowUpMsg("");
      setStepFollowUps({});
      const d = defaultAiSettings();
      setAiSettings(d);
      setRawMinDelay(String(d.minDelayMs));
      setRawMaxDelay(String(d.maxDelayMs));
      setRawMaxSentences(String(d.maxSentencesPerBubble));
      setRawMaxDiscount(String(d.maxDiscountPercent));
      setRawFallback("");
      setRawGptError("");
      return;
    }
    setServiceGroup(script.service_group ?? "");
    setPriceContent(script.price_content ?? "");
    setAiRules(script.ai_rules ?? "");
    setFollowUpMsg(script.follow_up_message ?? "");
    setStepFollowUps(
      script.step_follow_up_messages
        ? Object.fromEntries(Object.entries(script.step_follow_up_messages).map(([k, v]) => [Number(k), v ?? ""]))
        : {},
    );
    setStepFollowUpSlots(
      script.step_follow_up_slots
        ? Object.fromEntries(
            Object.entries(script.step_follow_up_slots)
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => [
                Number(k),
                (v as FollowUpSlot[]),
              ])
          )
        : {},
    );
    if (!priceImagesLocalRef.current) {
      try {
        const imgs = script.price_images ? JSON.parse(script.price_images) : [];
        setPriceImages(Array.isArray(imgs) ? imgs : []);
      } catch {
        setPriceImages([]);
      }
    }
    setConversationExamples(Array.isArray(script.conversation_examples) ? script.conversation_examples : []);
    // Sync AI settings
    const def = defaultAiSettings();
    const saved = script.ai_settings;
    const newSettings: AiSettings = saved ? {
      ...def,
      ...saved,
      fallbackMessages: Array.isArray(saved.fallbackMessages) ? saved.fallbackMessages : def.fallbackMessages,
      gptErrorMessages: Array.isArray(saved.gptErrorMessages) ? saved.gptErrorMessages : def.gptErrorMessages,
      bannedKeywords: Array.isArray(saved.bannedKeywords) ? saved.bannedKeywords : def.bannedKeywords,
      priceImageSteps: Array.isArray(saved.priceImageSteps) ? saved.priceImageSteps : def.priceImageSteps,
      priceImageSendSteps: Array.isArray(saved.priceImageSendSteps) ? saved.priceImageSendSteps : def.priceImageSendSteps,
    } : def;
    setAiSettings(newSettings);
    setRawMinDelay(String(newSettings.minDelayMs));
    setRawMaxDelay(String(newSettings.maxDelayMs));
    setRawMaxSentences(String(newSettings.maxSentencesPerBubble));
    setRawMaxDiscount(String(newSettings.maxDiscountPercent));
    setRawFallback(newSettings.fallbackMessages.join("\n"));
    setRawGptError(newSettings.gptErrorMessages.join("\n"));
    setSettingsSaveStatus("idle");
  }, [selectedScriptId, scripts]);

  const createMutation = useMutation({
    mutationFn: async ({ name, sg }: { name: string; sg: string }) => {
      const r = await authFetch(`${BASE}/api/ai-scripts`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), serviceGroup: sg || null, isActive: true }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? "Lỗi tạo kịch bản");
      }
      return r.json() as Promise<Script & { id: number }>;
    },
    onSuccess: (script) => {
      queryClient.invalidateQueries({ queryKey: ["ai-scripts"] });
      setSelectedScriptId(script.id);
      setServiceGroup(script.service_group ?? "");
      setRows([makeEmptyRow(0, 4)]);
      setPriceImages([]);
      setPriceContent("");
      setAiRules("");
      setFollowUpMsg("");
      setStepFollowUps({});
      setStepFollowUpSlots({});
      setConversationExamples([]);
      setShowCreate(false);
      setCreateName("");
      setCreateServiceGroup("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await authFetch(`${BASE}/api/ai-scripts/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Lỗi xóa");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-scripts"] });
      setSelectedScriptId(null);
      setRows([makeEmptyRow(0, 4)]);
      setPriceImages([]);
      setPriceContent("");
      setAiRules("");
      setFollowUpMsg("");
      setStepFollowUps({});
      setStepFollowUpSlots({});
      setConversationExamples([]);
      setDeleteConfirm(false);
    },
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async (settings: AiSettings) => {
      if (!selectedScriptId) throw new Error("Chưa chọn kịch bản");
      const r = await authFetch(`${BASE}/api/ai-scripts/${selectedScriptId}/settings`, {
        method: "PATCH",
        body: JSON.stringify(settings),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Lỗi lưu cài đặt");
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-scripts"] });
      setSettingsSaveStatus("saved");
      setTimeout(() => setSettingsSaveStatus("idle"), 2500);
    },
    onError: () => {
      setSettingsSaveStatus("error");
      setTimeout(() => setSettingsSaveStatus("idle"), 3000);
    },
  });

  async function handleImageUpload(files: FileList) {
    if (!selectedScriptId || files.length === 0) return;
    setUploadingImages(true);
    const newPaths: string[] = [];
    try {
      for (const file of Array.from(files)) {
        const reqRes = await authFetch(`${BASE}/api/storage/uploads/request-url`, {
          method: "POST",
          body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
        });
        if (!reqRes.ok) continue;
        const { uploadURL, objectPath } = await reqRes.json() as { uploadURL: string; objectPath: string };
        const putRes = await fetch(uploadURL, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });
        if (putRes.ok) newPaths.push(objectPath);
      }
      if (newPaths.length > 0) {
        priceImagesLocalRef.current = true;
        setPriceImages((prev) => [...prev, ...newPaths]);
      }
    } finally {
      setUploadingImages(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const saveRows = useCallback(async () => {
    if (!selectedScriptId) return;
    setSaveStatus("saving");
    try {
      const currentScript = scripts.find((s) => s.id === selectedScriptId);
      const scriptName = currentScript?.name ?? "";

      const [qaRes, priceRes] = await Promise.all([
        authFetch(`${BASE}/api/ai-scripts/${selectedScriptId}/qa-rows/bulk`, {
          method: "POST",
          body: JSON.stringify(rows.map((r, i) => ({
            step: r.step,
            question: r.question,
            answer: r.answer,
            sort_order: i,
          }))),
        }),
        authFetch(`${BASE}/api/ai-scripts/${selectedScriptId}`, {
          method: "PUT",
          body: JSON.stringify({
            name: scriptName,
            serviceGroup: serviceGroup || null,
            priceContent: priceContent || null,
            priceImages: priceImages.length > 0 ? JSON.stringify(priceImages) : null,
            aiRules: aiRules || null,
            conversationExamples: conversationExamples.length > 0 ? conversationExamples : null,
            followUpMessage: followUpMsg || null,
            stepFollowUpMessages: stepFollowUps,
            stepFollowUpSlots: stepFollowUpSlots,
            isActive: currentScript?.is_active !== false,
          }),
        }),
      ]);

      if (!qaRes.ok || !priceRes.ok) throw new Error("Lỗi lưu");
      queryClient.invalidateQueries({ queryKey: ["qa-rows", selectedScriptId] });
      queryClient.invalidateQueries({ queryKey: ["ai-scripts"] });
      priceImagesLocalRef.current = false;
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2500);
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  }, [selectedScriptId, rows, serviceGroup, priceContent, priceImages, aiRules, conversationExamples, followUpMsg, stepFollowUps, stepFollowUpSlots, queryClient, scripts]);

  const saveSharedRows = useCallback(async () => {
    setSharedSaveStatus("saving");
    try {
      const r = await authFetch(`${BASE}/api/ai-scripts/shared-qa-rows/bulk`, {
        method: "POST",
        body: JSON.stringify(sharedRows.map((row, i) => ({
          step: row.step,
          question: row.question,
          answer: row.answer,
          sort_order: i,
        }))),
      });
      if (!r.ok) throw new Error("Lỗi lưu");
      queryClient.invalidateQueries({ queryKey: ["shared-qa-rows"] });
      setSharedSaveStatus("saved");
      setTimeout(() => setSharedSaveStatus("idle"), 2500);
    } catch {
      setSharedSaveStatus("error");
      setTimeout(() => setSharedSaveStatus("idle"), 3000);
    }
  }, [sharedRows, queryClient]);

  function updateSharedRow(localId: string, field: keyof QaRow, value: string | number) {
    setSharedRows((prev) =>
      prev.map((r) => (r.localId === localId ? { ...r, [field]: value } : r)),
    );
  }

  function deleteSharedRow(localId: string) {
    setSharedRows((prev) => {
      const next = prev.filter((r) => r.localId !== localId);
      if (next.length === 0) return [makeEmptyRow(0, 1)];
      return next.map((r, i) => ({ ...r, sort_order: i }));
    });
  }

  function updateRow(localId: string, field: keyof QaRow, value: string | number) {
    setRows((prev) =>
      prev.map((r) => (r.localId === localId ? { ...r, [field]: value } : r)),
    );
  }

  function addRowAfter(afterLocalId: string) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.localId === afterLocalId);
      const inheritStep = prev[idx]?.step ?? 4;
      const newRow = makeEmptyRow(idx + 1, inheritStep < 4 ? 4 : inheritStep);
      const next = [...prev];
      next.splice(idx + 1, 0, newRow);
      return next.map((r, i) => ({ ...r, sort_order: i }));
    });
    return makeLocalId();
  }

  function deleteRow(localId: string) {
    setRows((prev) => {
      const next = prev.filter((r) => r.localId !== localId);
      if (next.length === 0) return [makeEmptyRow(0, 4)];
      return next.map((r, i) => ({ ...r, sort_order: i }));
    });
  }

  function focusCell(localId: string, col: "question" | "answer") {
    setTimeout(() => {
      const el = cellRefs.current[`${localId}-${col}`];
      if (el) el.focus();
    }, 30);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    e.preventDefault();

    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return;

    const currentStep = filterStep === "all" ? null : filterStep;

    const parsed: Array<{ step: number; question: string; answer: string }> = lines.map((line) => {
      const parts = line.split("\t");
      if (currentStep !== null) {
        if (parts.length >= 2) {
          return { step: currentStep, question: parts[0].trim(), answer: parts[1].trim() };
        }
        return { step: currentStep, question: parts[0].trim(), answer: "" };
      }
      if (parts.length >= 3) {
        const stepRaw = parseInt(parts[0]);
        const step = isNaN(stepRaw) || stepRaw < 4 || stepRaw > 7 ? 4 : stepRaw;
        return { step, question: parts[1].trim(), answer: parts[2].trim() };
      } else if (parts.length === 2) {
        return { step: 4, question: parts[0].trim(), answer: parts[1].trim() };
      }
      return { step: 4, question: parts[0].trim(), answer: "" };
    });

    setRows((prev) => {
      const existingNonEmpty = prev.filter((r) => r.question.trim() || r.answer.trim());
      const newRows = parsed.map((p, i) => ({
        localId: makeLocalId(),
        step: p.step,
        question: p.question,
        answer: p.answer,
        sort_order: existingNonEmpty.length + i,
      }));
      const combined = [...existingNonEmpty, ...newRows];
      return combined.length > 0 ? combined : [makeEmptyRow(0, 4)];
    });
  }

  const filteredRows = filterStep === "all" ? rows : rows.filter((r) => r.step === filterStep);
  const filteredSharedRows = sharedFilterStep === "all" ? sharedRows : sharedRows.filter((r) => r.step === sharedFilterStep);
  const selectedScript = scripts.find((s) => s.id === selectedScriptId);

  return (
    <div className="flex flex-col h-full min-h-screen bg-background">
      <div className="border-b bg-card px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-bold">Kịch bản Sale AI</h1>
            <div className="flex items-center gap-0.5 ml-2 p-0.5 rounded-lg bg-muted border">
              <button
                onClick={() => { setViewMode("script"); setFilterStep("all"); }}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${viewMode === "script" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Kịch bản riêng
              </button>
              <button
                onClick={() => { setViewMode("shared"); setSharedFilterStep("all"); }}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${viewMode === "shared" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Star className="w-3 h-3" />
                Bước chung B1–B3
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {viewMode === "script" && loadingScripts ? (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            ) : viewMode === "script" ? (
              <div className="relative">
                <select
                  className="appearance-none pl-3 pr-8 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 min-w-[180px]"
                  value={selectedScriptId ?? ""}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (!isNaN(v)) {
                      setSelectedScriptId(v);
                      setFilterStep("all");
                    }
                  }}
                >
                  {(() => {
                    const grouped = SERVICE_GROUPS
                      .map((g) => ({
                        label: g.label,
                        scripts: scripts.filter((s) => s.service_group === g.value),
                      }))
                      .filter((g) => g.scripts.length > 0);
                    const ungrouped = scripts.filter((s) => !s.service_group || !SERVICE_GROUPS.some((g) => g.value === s.service_group));
                    return (
                      <>
                        {grouped.map((g) => (
                          <optgroup key={g.label} label={g.label}>
                            {g.scripts.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </optgroup>
                        ))}
                        {ungrouped.length > 0 && (
                          <optgroup label="Khác">
                            {ungrouped.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </optgroup>
                        )}
                      </>
                    );
                  })()}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              </div>
            ) : null}

            {viewMode === "script" && (!showCreate ? (
              <Button size="sm" variant="outline" className="gap-1" onClick={() => setShowCreate(true)}>
                <Plus className="w-3.5 h-3.5" /> Kịch bản mới
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  autoFocus
                  className="border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  placeholder="Tên kịch bản..."
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && createName.trim()) createMutation.mutate({ name: createName, sg: createServiceGroup });
                    if (e.key === "Escape") { setShowCreate(false); setCreateName(""); setCreateServiceGroup(""); }
                  }}
                />
                <select
                  className="border rounded-md px-2 py-1 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={createServiceGroup}
                  onChange={(e) => setCreateServiceGroup(e.target.value)}
                >
                  <option value="">— Nhóm DV —</option>
                  {SERVICE_GROUPS.map((g) => (
                    <option key={g.value} value={g.value}>{g.label}</option>
                  ))}
                </select>
                <Button
                  size="sm"
                  disabled={!createName.trim() || createMutation.isPending}
                  onClick={() => createMutation.mutate({ name: createName, sg: createServiceGroup })}
                >
                  {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Tạo"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowCreate(false); setCreateName(""); setCreateServiceGroup(""); }}>
                  Hủy
                </Button>
              </div>
            ))}

            {viewMode === "script" && selectedScriptId && !deleteConfirm && (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-red-500 gap-1"
                onClick={() => setDeleteConfirm(true)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
            {viewMode === "script" && deleteConfirm && (
              <div className="flex items-center gap-1.5 text-sm">
                <span className="text-red-500 font-medium">Xóa kịch bản này?</span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deleteMutation.isPending}
                  onClick={() => selectedScriptId && deleteMutation.mutate(selectedScriptId)}
                >
                  {deleteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Xóa"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(false)}>Hủy</Button>
              </div>
            )}

            {viewMode === "script" && (
              <Button
                size="sm"
                disabled={!selectedScriptId || saveStatus === "saving"}
                onClick={saveRows}
                className="gap-1.5"
              >
                {saveStatus === "saving" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                {saveStatus === "saving" ? "Đang lưu..." : saveStatus === "saved" ? "Đã lưu ✓" : saveStatus === "error" ? "Lỗi lưu" : "Lưu kịch bản"}
              </Button>
            )}

            {viewMode === "shared" && (
              <Button
                size="sm"
                disabled={sharedSaveStatus === "saving"}
                onClick={saveSharedRows}
                className="gap-1.5"
              >
                {sharedSaveStatus === "saving" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                {sharedSaveStatus === "saving" ? "Đang lưu..." : sharedSaveStatus === "saved" ? "Đã lưu ✓" : sharedSaveStatus === "error" ? "Lỗi lưu" : "Lưu bước chung"}
              </Button>
            )}
          </div>
        </div>

        {viewMode === "shared" && (
          <div className="space-y-2 pt-1">
            <div className="flex items-start gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mr-1 mt-1.5 shrink-0">Bước chung:</span>
              <div className="flex gap-1 flex-wrap">
                {(["all", 1, 2, 3] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setSharedFilterStep(v)}
                    className={`flex flex-col items-center px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                      sharedFilterStep === v
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    <span>{v === "all" ? "Tất cả" : `Bước ${v}`}</span>
                    <span className={`text-[9px] leading-tight font-normal ${sharedFilterStep === v ? "text-primary-foreground/70" : "text-slate-400"}`}>
                      {v === "all" ? "B1-B3" : v === 1 ? "chào hỏi" : v === 2 ? "khai thác" : "xác nhận"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {viewMode === "script" && selectedScriptId && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2 px-1">
              <ShoppingBag className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground font-medium">Nhóm dịch vụ:</span>
              <div className="relative">
                <select
                  className="appearance-none pl-2 pr-7 py-1 text-xs border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary/40 min-w-[130px]"
                  value={serviceGroup}
                  onChange={(e) => setServiceGroup(e.target.value)}
                >
                  <option value="">— Chưa phân nhóm —</option>
                  {SERVICE_GROUPS.map((g) => (
                    <option key={g.value} value={g.value}>{g.label}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
              </div>
              {serviceGroup && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                  {serviceGroupLabel(serviceGroup)}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground italic">(lưu khi nhấn "Lưu kịch bản")</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border bg-background p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  <ImagePlus className="w-3.5 h-3.5" />
                  Hình ảnh báo giá
                </div>
                {priceImages.length > 0 && (
                  <div className="grid grid-cols-3 gap-1.5">
                    {priceImages.map((path, idx) => (
                      <div key={idx} className="relative group aspect-square rounded overflow-hidden border bg-muted">
                        <img
                          src={imageUrlFromPath(path)}
                          alt={`Ảnh ${idx + 1}`}
                          className="w-full h-full object-cover"
                        />
                        <button
                          onClick={() => { priceImagesLocalRef.current = true; setPriceImages((prev) => prev.filter((_, i) => i !== idx)); }}
                          className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Xóa ảnh"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => e.target.files && handleImageUpload(e.target.files)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full gap-1.5 text-xs"
                  disabled={uploadingImages}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadingImages ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang tải ảnh...</>
                  ) : (
                    <><ImagePlus className="w-3.5 h-3.5" /> Thêm ảnh</>
                  )}
                </Button>
                <p className="text-[10px] text-muted-foreground">
                  {priceImages.length > 0 ? `${priceImages.length} ảnh • ` : ""}AI sẽ thông báo có ảnh báo giá ở bước 4
                </p>
              </div>

              <div className="rounded-lg border bg-background p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  <FileText className="w-3.5 h-3.5" />
                  Text báo giá
                </div>
                <textarea
                  className="w-full text-sm border rounded-md px-2.5 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40 bg-muted/30 leading-relaxed"
                  rows={6}
                  placeholder="Nhập bảng giá dịch vụ, gói chụp, chi phí...&#10;AI sẽ dùng nội dung này khi báo giá ở bước 4."
                  value={priceContent}
                  onChange={(e) => setPriceContent(e.target.value)}
                />
              </div>
            </div>

            <div className="rounded-lg border bg-background p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                <ShieldCheck className="w-3.5 h-3.5" />
                Quy định AI
              </div>
              <textarea
                className="w-full text-sm border rounded-md px-2.5 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40 bg-muted/30 leading-relaxed"
                rows={4}
                placeholder="Nhập quy định AI phải tuân theo, ví dụ:&#10;- Chỉ dùng đúng giá trong bảng giá, không tự giảm giá&#10;- Không tự thêm quyền lợi chưa được phép&#10;- Được đổi câu chữ nhưng không đổi nội dung&#10;- Nếu không chắc thì hỏi lại hoặc nhờ chuyển người thật"
                value={aiRules}
                onChange={(e) => setAiRules(e.target.value)}
              />
            </div>

            {/* ═══ HỘI THOẠI MẪU ═══ */}
            <div className="rounded-lg border bg-background p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  <MessagesSquare className="w-3.5 h-3.5" />
                  Hội thoại mẫu
                  <span className="text-[10px] font-normal normal-case text-muted-foreground/70">(few-shot examples)</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[11px] gap-1"
                  onClick={() => {
                    setEditingExampleIdx(null);
                    setDraftMessages([
                      { role: "user", content: "" },
                      { role: "assistant", content: "" },
                    ]);
                    setShowExampleModal(true);
                  }}
                >
                  <Plus className="w-3 h-3" />
                  Thêm hội thoại mẫu
                </Button>
              </div>

              {conversationExamples.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">
                  Chưa có hội thoại mẫu. Thêm ví dụ để AI học cách trả lời tự nhiên hơn.
                </p>
              ) : (
                <div className="space-y-2">
                  {conversationExamples.filter(Array.isArray).map((ex, exIdx) => (
                    <div key={exIdx} className="border rounded-lg p-2 bg-muted/20 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                          <Star className="w-3 h-3" />
                          Ví dụ {exIdx + 1}
                        </span>
                        <div className="flex gap-1">
                          <button
                            className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-transparent hover:border-border transition"
                            onClick={() => {
                              setEditingExampleIdx(exIdx);
                              setDraftMessages(ex.map((m) => ({ ...m })));
                              setShowExampleModal(true);
                            }}
                          >
                            Sửa
                          </button>
                          <button
                            className="text-[10px] text-destructive hover:text-destructive/80 px-1.5 py-0.5 rounded border border-transparent hover:border-destructive/40 transition"
                            onClick={() => setConversationExamples((prev) => prev.filter((_, i) => i !== exIdx))}
                          >
                            Xóa
                          </button>
                        </div>
                      </div>
                      <div className="space-y-1">
                        {ex.map((msg, mIdx) => (
                          <div key={mIdx} className={`flex gap-1.5 items-start text-[11px] ${msg.role === "assistant" ? "flex-row-reverse" : ""}`}>
                            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${msg.role === "user" ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}>
                              {msg.role === "user" ? "Khách" : "Studio"}
                            </span>
                            <span className={`px-2 py-1 rounded-md text-[11px] leading-snug max-w-[85%] whitespace-pre-wrap ${msg.role === "user" ? "bg-muted/60" : "bg-primary/10"}`}>
                              {msg.content}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Modal thêm/sửa hội thoại mẫu */}
            {showExampleModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="bg-background rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
                  <div className="flex items-center justify-between px-4 py-3 border-b">
                    <span className="font-semibold text-sm">
                      {editingExampleIdx !== null ? `Sửa hội thoại mẫu ${editingExampleIdx + 1}` : "Thêm hội thoại mẫu mới"}
                    </span>
                    <button onClick={() => setShowExampleModal(false)} className="text-muted-foreground hover:text-foreground">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="overflow-y-auto flex-1 p-4 space-y-2">
                    {draftMessages.map((msg, mIdx) => (
                      <div key={mIdx} className="flex gap-2 items-start">
                        <div className="flex flex-col gap-1 pt-1">
                          <button
                            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border transition ${msg.role === "user" ? "border-border bg-muted text-muted-foreground" : "border-primary/40 bg-primary/10 text-primary"}`}
                            onClick={() => setDraftMessages((prev) => prev.map((m, i) => i === mIdx ? { ...m, role: m.role === "user" ? "assistant" : "user" } : m))}
                            title="Đổi vai"
                          >
                            {msg.role === "user" ? <UserRound className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
                          </button>
                          <span className="text-[9px] text-center text-muted-foreground">{msg.role === "user" ? "Khách" : "Studio"}</span>
                        </div>
                        <textarea
                          className="flex-1 text-sm border rounded-md px-2.5 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40 bg-muted/30 leading-relaxed"
                          rows={2}
                          placeholder={msg.role === "user" ? "Câu hỏi của khách..." : "Câu trả lời của studio..."}
                          value={msg.content}
                          onChange={(e) => setDraftMessages((prev) => prev.map((m, i) => i === mIdx ? { ...m, content: e.target.value } : m))}
                        />
                        {draftMessages.length > 2 && (
                          <button
                            className="pt-1 text-muted-foreground hover:text-destructive"
                            onClick={() => setDraftMessages((prev) => prev.filter((_, i) => i !== mIdx))}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      className="w-full text-[11px] text-muted-foreground border border-dashed rounded-md py-1.5 hover:border-primary/40 hover:text-primary transition"
                      onClick={() => {
                        const lastRole = draftMessages[draftMessages.length - 1]?.role ?? "user";
                        setDraftMessages((prev) => [...prev, { role: lastRole === "user" ? "assistant" : "user", content: "" }]);
                      }}
                    >
                      + Thêm tin nhắn
                    </button>
                  </div>
                  <div className="flex gap-2 justify-end px-4 py-3 border-t">
                    <Button variant="outline" size="sm" onClick={() => setShowExampleModal(false)}>Hủy</Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        const valid = draftMessages.filter((m) => m.content.trim());
                        if (valid.length < 2) return;
                        if (editingExampleIdx !== null) {
                          setConversationExamples((prev) => prev.map((ex, i) => i === editingExampleIdx ? valid : ex));
                        } else {
                          setConversationExamples((prev) => [...prev, valid]);
                        }
                        setShowExampleModal(false);
                      }}
                    >
                      Lưu hội thoại
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-lg border bg-background p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  <Bot className="w-3.5 h-3.5" />
                  Tin follow-up mặc định
                </div>
                <span className="text-[10px] text-muted-foreground">Gửi sau 24h/48h/72h im lặng (tối đa 3 lần)</span>
              </div>
              <textarea
                className="w-full text-sm border rounded-md px-2.5 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40 bg-muted/30 leading-relaxed"
                rows={3}
                placeholder="Tin follow-up mặc định (dùng khi bước không có tin riêng)"
                value={followUpMsg}
                onChange={(e) => setFollowUpMsg(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">
                {followUpMsg ? "✓ Dùng tin nhắn này khi bước không có tin riêng" : "Để trống: AI sẽ dùng tin theo bước hoặc tin mặc định"}
              </p>
            </div>
          </div>
        )}

        {/* ═══ CÀI ĐẶT AI ═══ */}
        {selectedScriptId && (
          <div className="rounded-lg border bg-background overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2.5 border-b bg-muted/40">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold">Cài đặt AI</span>
                <span className="text-[10px] text-muted-foreground">(áp dụng cho kịch bản này)</span>
              </div>
              <Button
                size="sm"
                disabled={!selectedScriptId || saveSettingsMutation.isPending}
                onClick={() => {
                  const flushed = {
                    ...aiSettings,
                    minDelayMs: sanitizeNumber(rawMinDelay, aiSettings.minDelayMs, 0, 10000),
                    maxDelayMs: sanitizeNumber(rawMaxDelay, aiSettings.maxDelayMs, 0, 20000),
                    maxSentencesPerBubble: sanitizeNumber(rawMaxSentences, aiSettings.maxSentencesPerBubble, 1, 10),
                    maxDiscountPercent: sanitizeNumber(rawMaxDiscount, aiSettings.maxDiscountPercent, 0, 100),
                  };
                  setAiSettings(flushed);
                  setSettingsSaveStatus("saving");
                  saveSettingsMutation.mutate(flushed);
                }}
                className="gap-1.5 h-7 text-xs"
              >
                {saveSettingsMutation.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : settingsSaveStatus === "saved" ? (
                  <CheckCircle2 className="w-3 h-3" />
                ) : (
                  <Save className="w-3 h-3" />
                )}
                {settingsSaveStatus === "saving" ? "Đang lưu..." : settingsSaveStatus === "saved" ? "Đã lưu ✓" : settingsSaveStatus === "error" ? "Lỗi!" : "Lưu cài đặt"}
              </Button>
            </div>

            {/* --- 1. Hành vi --- */}
            <div className="border-b">
              <button
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                onClick={() => setOpenSettingsSection(prev => prev === "behavior" ? null : "behavior")}
              >
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-amber-500" />
                  <span className="text-sm font-medium">Hành vi</span>
                  <span className="text-[10px] text-muted-foreground">Delay, typing, chia tin...</span>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${openSettingsSection === "behavior" ? "rotate-180" : ""}`} />
              </button>
              {openSettingsSection === "behavior" && (
                <div className="px-3 pb-3 space-y-3 bg-muted/10">
                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Delay tối thiểu (ms)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background"
                        value={rawMinDelay}
                        onChange={e => setRawMinDelay(e.target.value)}
                        onBlur={() => {
                          const v = sanitizeNumber(rawMinDelay, aiSettings.minDelayMs, 0, 10000);
                          setAiSettings(prev => ({ ...prev, minDelayMs: v }));
                          setRawMinDelay(String(v));
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Delay tối đa (ms)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background"
                        value={rawMaxDelay}
                        onChange={e => setRawMaxDelay(e.target.value)}
                        onBlur={() => {
                          const v = sanitizeNumber(rawMaxDelay, aiSettings.maxDelayMs, 0, 20000);
                          setAiSettings(prev => ({ ...prev, maxDelayMs: v }));
                          setRawMaxDelay(String(v));
                        }}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Max câu/bubble</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="w-36 border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background"
                      value={rawMaxSentences}
                      onChange={e => setRawMaxSentences(e.target.value)}
                      onBlur={() => {
                        const v = sanitizeNumber(rawMaxSentences, aiSettings.maxSentencesPerBubble, 1, 10);
                        setAiSettings(prev => ({ ...prev, maxSentencesPerBubble: v }));
                        setRawMaxSentences(String(v));
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-4">
                    {[
                      { key: "typingIndicator" as const, label: "Hiển thị đang gõ..." },
                      { key: "chunkMessages" as const, label: "Chia nhỏ tin nhắn" },
                    ].map(({ key, label }) => (
                      <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          className="w-4 h-4 rounded accent-primary"
                          checked={aiSettings[key]}
                          onChange={e => setAiSettings(prev => ({ ...prev, [key]: e.target.checked }))}
                        />
                        <span className="text-sm">{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* --- 2. Giọng điệu --- */}
            <div className="border-b">
              <button
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                onClick={() => setOpenSettingsSection(prev => prev === "tone" ? null : "tone")}
              >
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-3.5 h-3.5 text-blue-500" />
                  <span className="text-sm font-medium">Giọng điệu & Xưng hô</span>
                  <span className="text-[10px] text-muted-foreground">Emoji, cấm từ...</span>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${openSettingsSection === "tone" ? "rotate-180" : ""}`} />
              </button>
              {openSettingsSection === "tone" && (
                <div className="px-3 pb-3 space-y-3 bg-muted/10 pt-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Xưng hô</label>
                    <select
                      className="border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background"
                      value={aiSettings.pronounStyle}
                      onChange={e => setAiSettings(prev => ({ ...prev, pronounStyle: e.target.value as AiSettings["pronounStyle"] }))}
                    >
                      <option value="em_ban">Em – Bạn (mặc định)</option>
                      <option value="minh_ban">Mình – Bạn</option>
                      <option value="custom">Tùy chỉnh</option>
                    </select>
                  </div>
                  {aiSettings.pronounStyle === "custom" && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">AI tự xưng là</label>
                        <input
                          type="text"
                          className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background"
                          value={aiSettings.customPronounSelf}
                          placeholder="em"
                          onChange={e => setAiSettings(prev => ({ ...prev, customPronounSelf: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Gọi khách là</label>
                        <input
                          type="text"
                          className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background"
                          value={aiSettings.customPronounCustomer}
                          placeholder="bạn"
                          onChange={e => setAiSettings(prev => ({ ...prev, customPronounCustomer: e.target.value }))}
                        />
                      </div>
                    </div>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded accent-primary"
                      checked={aiSettings.useEmoji}
                      onChange={e => setAiSettings(prev => ({ ...prev, useEmoji: e.target.checked }))}
                    />
                    <span className="text-sm">Dùng emoji trong tin nhắn</span>
                  </label>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Từ khóa bị cấm (cách nhau bởi dấu phẩy)</label>
                    <input
                      type="text"
                      className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background"
                      value={aiSettings.bannedKeywords.join(", ")}
                      placeholder="trợ lý AI, ChatGPT, OpenAI"
                      onChange={e => setAiSettings(prev => ({
                        ...prev,
                        bannedKeywords: e.target.value.split(",").map(s => s.trim()).filter(Boolean),
                      }))}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* --- 3. Cài đặt Sale --- */}
            <div className="border-b">
              <button
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                onClick={() => setOpenSettingsSection(prev => prev === "sale" ? null : "sale")}
              >
                <div className="flex items-center gap-2">
                  <ShoppingBag className="w-3.5 h-3.5 text-green-500" />
                  <span className="text-sm font-medium">Cài đặt Sale</span>
                  <span className="text-[10px] text-muted-foreground">Báo giá, giảm giá...</span>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${openSettingsSection === "sale" ? "rotate-180" : ""}`} />
              </button>
              {openSettingsSection === "sale" && (
                <div className="px-3 pb-3 space-y-3 bg-muted/10 pt-2">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded accent-primary"
                      checked={aiSettings.autoPriceQuote}
                      onChange={e => setAiSettings(prev => ({ ...prev, autoPriceQuote: e.target.checked }))}
                    />
                    <span className="text-sm">Auto báo giá khi đến bước 4</span>
                  </label>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Giới hạn giảm giá tối đa (%)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="w-28 border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background"
                      value={rawMaxDiscount}
                      onChange={e => setRawMaxDiscount(e.target.value)}
                      onBlur={() => {
                        const v = sanitizeNumber(rawMaxDiscount, aiSettings.maxDiscountPercent, 0, 100);
                        setAiSettings(prev => ({ ...prev, maxDiscountPercent: v }));
                        setRawMaxDiscount(String(v));
                      }}
                    />
                    <span className="text-xs text-muted-foreground ml-2">%</span>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">Bước được gửi ảnh báo giá (priceImageSteps cũ)</label>
                    <div className="flex flex-wrap gap-2">
                      {[1,2,3,4,5,6,7].map(step => (
                        <label key={step} className="flex items-center gap-1.5 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            className="w-3.5 h-3.5 rounded accent-primary"
                            checked={aiSettings.priceImageSteps.includes(step)}
                            onChange={e => {
                              setAiSettings(prev => ({
                                ...prev,
                                priceImageSteps: e.target.checked
                                  ? [...prev.priceImageSteps, step].sort()
                                  : prev.priceImageSteps.filter(s => s !== step),
                              }));
                            }}
                          />
                          <span className="text-xs">Bước {step}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="border-t pt-3 mt-1 space-y-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold">Tự động gửi ảnh bảng giá</p>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded accent-primary"
                        checked={aiSettings.autoSendPriceImage}
                        onChange={e => setAiSettings(prev => ({ ...prev, autoSendPriceImage: e.target.checked }))}
                      />
                      <span className="text-sm">Tự động gửi ảnh bảng giá khi đến bước báo giá</span>
                    </label>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Gửi ảnh tại bước (nhập số, cách nhau bằng dấu phẩy)</label>
                      <input
                        type="text"
                        className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background"
                        placeholder="4"
                        value={aiSettings.priceImageSendSteps.join(", ")}
                        onChange={e => {
                          const steps = e.target.value
                            .split(",")
                            .map(s => sanitizeNumber(s.trim(), 0, 1, 7))
                            .filter(n => n >= 1);
                          const unique = [...new Set(steps)].sort();
                          setAiSettings(prev => ({ ...prev, priceImageSendSteps: unique }));
                        }}
                      />
                      <p className="text-[10px] text-muted-foreground">VD: 4 hoặc 4, 5, 6</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded accent-primary"
                        checked={aiSettings.sendPriceTextAfterImage}
                        onChange={e => setAiSettings(prev => ({ ...prev, sendPriceTextAfterImage: e.target.checked }))}
                      />
                      <span className="text-sm">Gửi text báo giá sau khi gửi ảnh</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* --- 4. Fallback --- */}
            <div className="border-b">
              <button
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                onClick={() => setOpenSettingsSection(prev => prev === "fallback" ? null : "fallback")}
              >
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-orange-500" />
                  <span className="text-sm font-medium">Fallback</span>
                  <span className="text-[10px] text-muted-foreground">Tin khi không hiểu, lỗi GPT...</span>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${openSettingsSection === "fallback" ? "rotate-180" : ""}`} />
              </button>
              {openSettingsSection === "fallback" && (
                <div className="px-3 pb-3 space-y-3 bg-muted/10 pt-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Tin nhắn khi không hiểu câu hỏi (mỗi dòng = 1 lựa chọn ngẫu nhiên)</label>
                    <textarea
                      className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background resize-none"
                      rows={3}
                      value={rawFallback}
                      placeholder={"Dạ bạn chờ em xíu nha\nDạ để em xem lại thông tin"}
                      onChange={e => setRawFallback(e.target.value)}
                      onBlur={() => setAiSettings(prev => ({
                        ...prev,
                        fallbackMessages: rawFallback.split("\n").map(s => s.trim()).filter(Boolean),
                      }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Tin nhắn khi lỗi GPT (mỗi dòng = 1 lựa chọn ngẫu nhiên)</label>
                    <textarea
                      className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 bg-background resize-none"
                      rows={3}
                      value={rawGptError}
                      placeholder={"Dạ bạn chờ em xíu nha\nDạ để em xem lại thông tin"}
                      onChange={e => setRawGptError(e.target.value)}
                      onBlur={() => setAiSettings(prev => ({
                        ...prev,
                        gptErrorMessages: rawGptError.split("\n").map(s => s.trim()).filter(Boolean),
                      }))}
                    />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded accent-primary"
                      checked={aiSettings.saveUnknownQuestions}
                      onChange={e => setAiSettings(prev => ({ ...prev, saveUnknownQuestions: e.target.checked }))}
                    />
                    <span className="text-sm">Tự động lưu câu hỏi chưa trả lời được</span>
                  </label>
                </div>
              )}
            </div>

            {/* --- 5. Debug --- */}
            <div>
              <button
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                onClick={() => setOpenSettingsSection(prev => prev === "debug" ? null : "debug")}
              >
                <div className="flex items-center gap-2">
                  <Bug className="w-3.5 h-3.5 text-purple-500" />
                  <span className="text-sm font-medium">Debug</span>
                  <span className="text-[10px] text-muted-foreground">Log, force QA/GPT...</span>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${openSettingsSection === "debug" ? "rotate-180" : ""}`} />
              </button>
              {openSettingsSection === "debug" && (
                <div className="px-3 pb-3 space-y-3 bg-muted/10 pt-2">
                  {[
                    { key: "logDecisions" as const, label: "Bật log decision (qa/gpt/fallback) vào console" },
                    { key: "forceQaOnly" as const, label: "Chỉ dùng QA matching — bỏ qua GPT" },
                    { key: "forceGptOnly" as const, label: "Chỉ dùng GPT — bỏ qua QA matching" },
                  ].map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded accent-primary"
                        checked={aiSettings[key]}
                        onChange={e => {
                          if ((key === "forceQaOnly" && e.target.checked) || (key === "forceGptOnly" && e.target.checked)) {
                            const opposite = key === "forceQaOnly" ? "forceGptOnly" : "forceQaOnly";
                            setAiSettings(prev => ({ ...prev, [key]: true, [opposite]: false }));
                          } else {
                            setAiSettings(prev => ({ ...prev, [key]: e.target.checked }));
                          }
                        }}
                      />
                      <span className="text-sm">{label}</span>
                      {(key === "forceQaOnly" || key === "forceGptOnly") && aiSettings[key] && (
                        <span className="text-[10px] text-orange-500 font-medium">● Đang bật</span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {viewMode === "script" && (<div className="flex items-start gap-1.5 pt-0.5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mr-1 mt-1.5 shrink-0">Bước theo nhóm DV:</span>
          <div className="flex gap-1 flex-wrap">
            {(["all", 4, 5, 6, 7] as const).map((v) => {
              const hasUnknown = v === "all"
                ? unknownQuestions.some(q => q.status === "pending" && q.step !== null && q.step >= 4)
                : unknownQuestions.some(q => q.status === "pending" && q.step === v);
              return (
                <button
                  key={v}
                  onClick={() => setFilterStep(v)}
                  className={`relative flex flex-col items-center px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    filterStep === v
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                >
                  <span>{v === "all" ? "Tất cả" : `Bước ${v}`}</span>
                  {v !== "all" && (
                    <span className={`text-[9px] leading-tight font-normal ${filterStep === v ? "text-primary-foreground/70" : "text-violet-400 dark:text-violet-500"}`}>
                      theo nhóm
                    </span>
                  )}
                  {hasUnknown && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full border border-background" />
                  )}
                </button>
              );
            })}
            <button
              onClick={() => { setViewMode("shared"); setSharedFilterStep("all"); }}
              className="flex flex-col items-center px-2.5 py-1 rounded-lg text-xs font-medium transition-colors bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-primary hover:bg-slate-200 dark:hover:bg-slate-700 border border-dashed border-slate-300 dark:border-slate-600"
              title="Quản lý Q&A chung cho bước 1–3"
            >
              <span>B1–B3</span>
              <span className="text-[9px] leading-tight font-normal text-slate-400">→ bước chung</span>
            </button>
          </div>
        </div>)}
        {viewMode === "script" && filterStep !== "all" && (filterStep as number) >= 4 && (
          <StepFollowUpSlotEditor
            slots={stepFollowUpSlots[filterStep as number] ?? []}
            onChange={(updater) => {
              const step = filterStep as number;
              setStepFollowUpSlots(prev => ({ ...prev, [step]: updater(prev[step] ?? []) }));
            }}
          />
        )}
      </div>

      {viewMode === "shared" ? (
        <div className="flex-1 min-w-0 w-full overflow-x-auto overflow-y-auto">
          {loadingSharedRows ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Đang tải...
            </div>
          ) : (
            <>
            <div className="px-4 py-2 border-b bg-slate-50 dark:bg-slate-900/40">
              <div className="flex items-center gap-2">
                <Star className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-sm font-semibold text-foreground">
                  {sharedFilterStep === "all" ? "Bước chung B1–B3" : STEP_LABELS[sharedFilterStep as number]}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-medium">Dùng chung mọi kịch bản</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Q&A ở đây áp dụng cho bước 1–3 của <strong>mọi kịch bản</strong>: chào hỏi, khai thác nhu cầu, xác nhận nhóm dịch vụ. AI sẽ tra cứu bộ Q&A này trước khi dùng GPT.
              </p>
            </div>
            <table className="w-[100vw] min-w-[100vw] border-collapse text-sm table-fixed">
              <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur border-b">
                <tr>
                  {sharedFilterStep === "all" && (
                    <th className="w-12 text-center px-2 py-2.5 font-semibold text-xs uppercase tracking-wide text-muted-foreground border-r">
                      Bước
                    </th>
                  )}
                  <th className="w-[56%] text-left px-3 py-2.5 font-semibold text-xs uppercase tracking-wide text-muted-foreground border-r">
                    Khách nói
                  </th>
                  <th className="w-[36%] text-left px-3 py-2.5 font-semibold text-xs uppercase tracking-wide text-muted-foreground border-r">
                    AI trả lời
                  </th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {filteredSharedRows.map((row) => (
                  <tr key={row.localId} className="group border-b hover:bg-muted/20 transition-colors">
                    {sharedFilterStep === "all" && (
                      <td className="px-2 py-1 border-r align-top text-center">
                        <select
                          value={row.step}
                          onChange={(e) => updateSharedRow(row.localId, "step", parseInt(e.target.value))}
                          className="text-[11px] font-bold px-1 py-0.5 rounded bg-primary/10 text-primary border-none focus:outline-none focus:ring-1 focus:ring-primary/40 cursor-pointer"
                        >
                          <option value={1}>B1</option>
                          <option value={2}>B2</option>
                          <option value={3}>B3</option>
                        </select>
                      </td>
                    )}
                    <td className="px-1 py-1 border-r align-top">
                      <textarea
                        className="w-full bg-transparent resize-none py-1.5 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 rounded min-h-[38px] leading-relaxed"
                        rows={Math.max(1, Math.ceil((row.question.length || 1) / 50))}
                        placeholder="Khách nói gì..."
                        value={row.question}
                        onChange={(e) => updateSharedRow(row.localId, "question", e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Tab") { e.preventDefault(); }
                        }}
                      />
                    </td>
                    <td className="px-1 py-1 border-r align-top">
                      <textarea
                        className="w-full bg-transparent resize-none py-1.5 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 rounded min-h-[38px] leading-relaxed"
                        rows={Math.max(1, Math.ceil((row.answer.length || 1) / 60))}
                        placeholder="AI sẽ trả lời..."
                        value={row.answer}
                        onChange={(e) => updateSharedRow(row.localId, "answer", e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Tab") { e.preventDefault(); }
                        }}
                      />
                    </td>
                    <td className="px-1 py-1 text-center align-top">
                      <button
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-500 p-1 rounded"
                        onClick={() => deleteSharedRow(row.localId)}
                        title="Xóa hàng"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={sharedFilterStep === "all" ? 4 : 3} className="px-3 py-2">
                    <button
                      className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => {
                        const step = sharedFilterStep === "all" ? 1 : (sharedFilterStep as number);
                        const newRow = makeEmptyRow(sharedRows.length, step);
                        setSharedRows((prev) => [...prev, newRow]);
                      }}
                    >
                      <Plus className="w-4 h-4" /> Thêm dòng
                    </button>
                  </td>
                </tr>
              </tfoot>
            </table>
            </>
          )}
        </div>
      ) : !selectedScriptId ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center space-y-2">
            <Bot className="w-12 h-12 mx-auto opacity-20" />
            <p className="font-medium">Chưa có kịch bản nào</p>
            <p className="text-sm">Nhấn "Kịch bản mới" để bắt đầu</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-w-0 w-full overflow-x-auto overflow-y-auto" onPaste={handlePaste}>
          {loadingRows ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Đang tải...
            </div>
          ) : (
            <>
            {filterStep !== "all" && (
              <div className="px-4 py-2 border-b bg-violet-50/40 dark:bg-violet-950/20">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-primary">{STEP_LABELS[filterStep]}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400 font-medium">Riêng theo nhóm DV</span>
                </div>
                <p className="text-[11px] text-violet-500/80 dark:text-violet-400/70 mt-0.5">
                  Bước này dùng nội dung riêng của từng kịch bản nhóm dịch vụ — có thể báo giá, gửi ảnh mẫu và xử lý chốt đơn.
                </p>
              </div>
            )}
            <table className="w-[100vw] min-w-[100vw] border-collapse text-sm table-fixed">
              <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur border-b">
                <tr>
                  {filterStep === "all" && (
                    <th className="w-12 text-center px-2 py-2.5 font-semibold text-xs uppercase tracking-wide text-muted-foreground border-r">
                      Bước
                    </th>
                  )}
                  <th className={`${filterStep === "all" ? "w-[56%]" : "w-[56%]"} text-left px-3 py-2.5 font-semibold text-xs uppercase tracking-wide text-muted-foreground border-r`}>
                    Khách nói
                  </th>
                  <th className={`${filterStep === "all" ? "w-[36%]" : "w-[36%]"} text-left px-3 py-2.5 font-semibold text-xs uppercase tracking-wide text-muted-foreground border-r`}>
                    AI trả lời
                  </th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {filteredUnknownRows.map(q => (
                  <tr key={`uq-${q.id}`} className="border-b bg-red-50/50 dark:bg-red-950/20">
                    {filterStep === "all" && (
                      <td className="px-2 py-1 border-r align-top text-center">
                        {q.step ? (
                          <span className="inline-block text-[11px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 leading-tight cursor-default select-none dark:bg-red-900/40 dark:text-red-400">
                            B{q.step}
                          </span>
                        ) : (
                          <span className="inline-block text-[11px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 leading-tight cursor-default select-none dark:bg-red-900/40 dark:text-red-400">?</span>
                        )}
                      </td>
                    )}
                    <td className="px-2 py-2 border-r align-top">
                      <div className="flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] font-semibold text-red-600 dark:text-red-400 mb-0.5">❓ Chưa trả lời</div>
                          <div className="text-sm text-foreground leading-relaxed">{q.question_text}</div>
                          {q.psid && <div className="text-[10px] text-muted-foreground mt-0.5">PSID: {q.psid.slice(-6)}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-1 py-2 border-r align-top">
                      <textarea
                        className="w-full bg-white dark:bg-background border border-red-200 dark:border-red-800 resize-none py-1.5 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 rounded min-h-[60px] leading-relaxed"
                        rows={3}
                        placeholder="Nhập câu trả lời cho AI học..."
                        value={unknownAnswers[q.id] ?? ""}
                        onChange={e => setUnknownAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                      />
                      <button
                        disabled={savingUnknown[q.id] || !unknownAnswers[q.id]?.trim()}
                        onClick={() => saveUnknownAnswer(q.id)}
                        className="mt-1 flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {savingUnknown[q.id] ? (
                          <><Loader2 className="w-3 h-3 animate-spin" /> Đang lưu...</>
                        ) : savedUnknown[q.id] ? (
                          <><CheckCircle2 className="w-3 h-3" /> Đã lưu ✓</>
                        ) : (
                          <><Save className="w-3 h-3" /> Lưu câu trả lời</>
                        )}
                      </button>
                    </td>
                    <td className="px-1 py-1 text-center align-top" />
                  </tr>
                ))}
                {filteredRows.map((row, rowIdx) => (
                  <tr key={row.localId} className="group border-b hover:bg-muted/20 transition-colors">
                    {filterStep === "all" && (
                      <td className="px-2 py-1 border-r align-top text-center">
                        <span
                          className="inline-block text-[11px] font-bold px-1.5 py-0.5 rounded bg-primary/10 text-primary leading-tight cursor-default select-none"
                          title={STEP_LABELS[row.step]}
                        >
                          B{row.step}
                        </span>
                      </td>
                    )}
                    <td className="px-1 py-1 border-r align-top">
                      <textarea
                        ref={(el) => { cellRefs.current[`${row.localId}-question`] = el; }}
                        className="w-full bg-transparent resize-none py-1.5 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 rounded min-h-[38px] leading-relaxed"
                        rows={Math.max(1, Math.ceil((row.question.length || 1) / 50))}
                        placeholder="Khách nói gì..."
                        value={row.question}
                        onChange={(e) => updateRow(row.localId, "question", e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            const newRow = makeEmptyRow(0, filterStep === "all" ? 4 : filterStep);
                            setRows((prev) => {
                              const idx = prev.findIndex((r) => r.localId === row.localId);
                              const next = [...prev];
                              next.splice(idx + 1, 0, newRow);
                              return next.map((r, i) => ({ ...r, sort_order: i }));
                            });
                            focusCell(newRow.localId, "question");
                          }
                          if (e.key === "Tab") {
                            e.preventDefault();
                            focusCell(row.localId, "answer");
                          }
                          if (e.key === "Backspace" && !row.question && !row.answer && rowIdx === filteredRows.length - 1 && rows.length > 1) {
                            e.preventDefault();
                            deleteRow(row.localId);
                          }
                        }}
                      />
                    </td>
                    <td className="px-1 py-1 border-r align-top">
                      <textarea
                        ref={(el) => { cellRefs.current[`${row.localId}-answer`] = el; }}
                        className="w-full bg-transparent resize-none py-1.5 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 rounded min-h-[38px] leading-relaxed"
                        rows={Math.max(1, Math.ceil((row.answer.length || 1) / 60))}
                        placeholder="AI sẽ trả lời..."
                        value={row.answer}
                        onChange={(e) => updateRow(row.localId, "answer", e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            const newRow = makeEmptyRow(0, filterStep === "all" ? 4 : filterStep);
                            setRows((prev) => {
                              const idx = prev.findIndex((r) => r.localId === row.localId);
                              const next = [...prev];
                              next.splice(idx + 1, 0, newRow);
                              return next.map((r, i) => ({ ...r, sort_order: i }));
                            });
                            focusCell(newRow.localId, "question");
                          }
                          if (e.key === "Tab") {
                            e.preventDefault();
                            const nextRow = rows[rows.findIndex((r) => r.localId === row.localId) + 1];
                            if (nextRow) {
                              focusCell(nextRow.localId, "question");
                            } else {
                              const newRow = makeEmptyRow(0, filterStep === "all" ? 4 : filterStep);
                              setRows((prev) => [...prev, { ...newRow, sort_order: prev.length }]);
                              focusCell(newRow.localId, "question");
                            }
                          }
                          if (e.key === "Backspace" && !row.question && !row.answer && rowIdx === filteredRows.length - 1 && rows.length > 1) {
                            e.preventDefault();
                            deleteRow(row.localId);
                          }
                        }}
                      />
                    </td>
                    <td className="px-1 py-1 text-center align-top">
                      <button
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-500 p-1 rounded"
                        onClick={() => deleteRow(row.localId)}
                        title="Xóa hàng"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={filterStep === "all" ? 4 : 3} className="px-3 py-2">
                    <button
                      className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => {
                        const newRow = makeEmptyRow(rows.length, filterStep === "all" ? 4 : filterStep);
                        setRows((prev) => [...prev, newRow]);
                        focusCell(newRow.localId, "question");
                      }}
                    >
                      <Plus className="w-4 h-4" /> Thêm dòng
                    </button>
                  </td>
                </tr>
              </tfoot>
            </table>
            </>
          )}
        </div>
      )}

      {viewMode === "script" && selectedScript && (
        <div className="border-t px-4 py-2 text-xs text-muted-foreground bg-muted/30 flex items-center gap-4">
          <span>Kịch bản: <strong>{selectedScript.name}</strong></span>
          <span className={selectedScript.is_active ? "text-green-600" : "text-muted-foreground"}>
            {selectedScript.is_active ? "● Đang dùng" : "○ Tắt"}
          </span>
          <span>{rows.filter((r) => r.question.trim()).length} dòng Q&A (B4–B7)</span>
          {unknownQuestions.filter(q => q.status === "pending" && (q.step === null || q.step >= 4)).length > 0 && (
            <span className="text-red-500 font-medium flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {unknownQuestions.filter(q => q.status === "pending" && (q.step === null || q.step >= 4)).length} câu hỏi chưa trả lời
            </span>
          )}
          {priceImages.length > 0 && <span>{priceImages.length} ảnh báo giá</span>}
          <span className="ml-auto text-[11px]">Paste từ Excel/Google Sheets: Tab = phân cột, Enter = phân hàng</span>
        </div>
      )}
      {viewMode === "shared" && (
        <div className="border-t px-4 py-2 text-xs text-muted-foreground bg-muted/30 flex items-center gap-4">
          <Star className="w-3.5 h-3.5 text-slate-500" />
          <span>Bước chung B1–B3 — áp dụng cho <strong>mọi kịch bản</strong></span>
          <span>{sharedRows.filter((r) => r.question.trim()).length} dòng Q&A chung</span>
          <span className="ml-auto text-[11px]">Paste từ Excel/Google Sheets: Tab = phân cột, Enter = phân hàng</span>
        </div>
      )}
    </div>
  );
}
