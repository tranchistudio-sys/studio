import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import {
  createDraftVersion,
  ensureBrainLabTables,
  getActiveVersion,
  getOpenDraftVersion,
  updateDraftVersion,
  type BrainVersion,
} from "../lib/sale-brain-lab";
import {
  COMMON_SERVICE_ROUTES,
  LULU_SCRIPT_NODES,
  resolveCommonServiceRouting,
  selectSaleScriptResponse,
  type SaleScriptNode,
} from "../lib/sale-script-registry";
import { evaluateSaleWorkflow } from "../lib/sale-workflow";
import type { SaleHistoryItem } from "../lib/sale-price-sheet";
import {
  getSaleScriptDraftStore,
  withSaleScriptQuestionAnswerSheet,
  withSaleScriptNodeOverride,
  type SaleScriptNodeOverride,
  type SaleScriptQuestionAnswerRow,
} from "../lib/sale-script-drafts";

const router: IRouter = Router();

type Caller = { id: number; name: string | null };
type GroupRow = {
  id: number;
  name: string;
  description: string | null;
  ai_image_url: string | null;
  public_for_customer: boolean;
  is_active: number;
  package_count: number | string;
  active_package_count: number | string;
};

const COMMON_GREETING_SHEET = "COMMON.GREETING";
const COMMON_ROUTING_SHEET = "COMMON.SERVICE_ROUTING";
const COMMON_SHEET_KEYS = new Set([COMMON_GREETING_SHEET, COMMON_ROUTING_SHEET]);
const COMMON_ROUTING_OPTIONS = [
  ...COMMON_SERVICE_ROUTES,
  { serviceKey: "needs_clarification", serviceType: "UNRESOLVED", label: "Chưa rõ / hỏi nhiều dịch vụ", routeKey: "COMMON.SERVICE_ROUTING" },
  { serviceKey: "unmapped", serviceType: "UNMAPPED", label: "Không thuộc dịch vụ", routeKey: "COMMON.HANDOFF.UNMAPPED_REQUEST" },
];

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function serviceForGroup(group: Pick<GroupRow, "id" | "name">) {
  const name = normalize(group.name);
  if (name.includes("chup cong"))
    return {
      serviceKey: "wedding_gate",
      scriptKey: "SALE_WEDDING_GATE",
      active: true,
    };
  if (name.includes("album") && name.includes("studio"))
    return {
      serviceKey: "studio_album",
      scriptKey: "SALE_STUDIO_ALBUM",
      active: false,
    };
  if (
    name.includes("album") &&
    (name.includes("ngoai canh") || name.includes("outdoor"))
  )
    return {
      serviceKey: "album_outdoor",
      scriptKey: "SALE_OUTDOOR_ALBUM",
      active: false,
    };
  if (name.includes("tiec cuoi"))
    return {
      serviceKey: "wedding_party",
      scriptKey: "SALE_WEDDING_EVENT",
      active: false,
    };
  if (name.includes("beauty") || name.includes("thoi trang"))
    return { serviceKey: "beauty", scriptKey: "SALE_BEAUTY", active: false };
  return {
    serviceKey: `group_${group.id}`,
    scriptKey: `SALE_GROUP_${group.id}`,
    active: false,
  };
}

function nodeWithDraft(
  node: SaleScriptNode,
  overrides: Record<string, SaleScriptNodeOverride>,
) {
  const patch = overrides[node.nodeKey];
  return {
    ...node,
    ...(patch?.title ? { title: patch.title } : {}),
    ...(patch?.replyTemplate ? { replyTemplate: patch.replyTemplate } : {}),
    manual: Boolean(patch),
    customerExamples: patch?.customerExamples ?? [],
    nextQuestion: patch?.nextQuestion ?? null,
  };
}

function commonNodes(overrides: Record<string, SaleScriptNodeOverride>) {
  return LULU_SCRIPT_NODES.filter(
    (node) => node.scriptKey === "SALE_COMMON",
  ).map((node) => nodeWithDraft(node, overrides));
}

function groupNodes(
  group: GroupRow,
  overrides: Record<string, SaleScriptNodeOverride>,
) {
  const script = serviceForGroup(group);
  if (!script.active) return [];
  return LULU_SCRIPT_NODES.filter(
    (node) => node.scriptKey === script.scriptKey,
  ).map((node) => nodeWithDraft(node, overrides));
}

function questionAnswerRows(
  rulesJson: unknown,
  scriptKey: string,
): SaleScriptQuestionAnswerRow[] {
  return (
    getSaleScriptDraftStore(rulesJson).questionAnswerSheets[scriptKey] ?? []
  );
}

function isLegacyRoutingRow(row: SaleScriptQuestionAnswerRow): boolean {
  const text = normalize(`${row.question} ${row.answer}`);
  if (/\b(alo|hello|shop oi|ben minh oi|khach moi|chao hoi|chao shop)\b/.test(text)) return false;
  return /\b(dich vu gi|co dich vu|quan tam dich vu|chup cong|album|chup tiec|phong su|beauty|beaty|gia dinh|chup bau|em be|thue vay|thue ao dai|thue vest|thue trang phuc)\b/.test(text);
}

function commonTableRows(
  rulesJson: unknown,
  tableKey: string,
): SaleScriptQuestionAnswerRow[] {
  const explicit = questionAnswerRows(rulesJson, tableKey);
  const explicitIds = new Set(explicit.map((row) => row.id));
  const legacy = questionAnswerRows(rulesJson, "SALE_COMMON")
    .filter((row) => tableKey === COMMON_ROUTING_SHEET ? isLegacyRoutingRow(row) : !isLegacyRoutingRow(row))
    .filter((row) => !explicitIds.has(row.id))
    .map((row) => {
      if (tableKey !== COMMON_ROUTING_SHEET || (row.serviceKey && row.routeKey)) return row;
      const routing = resolveCommonServiceRouting(row.question);
      const route = routing.selected ?? COMMON_ROUTING_OPTIONS.find((option) => option.serviceKey === "needs_clarification")!;
      return { ...row, serviceKey: route.serviceKey, routeKey: route.routeKey };
    });
  return [...explicit, ...legacy];
}

function commonPayload(active: BrainVersion | null, draft: BrainVersion | null) {
  const overrides = getSaleScriptDraftStore(draft?.rulesJson).nodes;
  const nodes = commonNodes(overrides);
  const greetingRows = commonTableRows(draft?.rulesJson, COMMON_GREETING_SHEET);
  const routingRows = commonTableRows(draft?.rulesJson, COMMON_ROUTING_SHEET);
  return {
    scriptKey: "COMMON_SALE_SCRIPT",
    activeVersion: active?.versionNumber ?? 1,
    draftVersion: draft?.versionNumber ?? null,
    nodes,
    questionAnswerRows: [...greetingRows, ...routingRows],
    tables: [
      {
        key: COMMON_GREETING_SHEET,
        title: "Chào hỏi khách hàng",
        shortTitle: "Chào hỏi",
        description: "Chào khách mới và xử lý các câu mở đầu.",
        nodeKeys: ["COMMON.GREETING"],
        questionAnswerRows: greetingRows,
        routeCount: null,
      },
      {
        key: COMMON_ROUTING_SHEET,
        title: "Tìm hiểu khách đang quan tâm dịch vụ nào",
        shortTitle: "Phân loại dịch vụ",
        description: "Xác định khách cần dịch vụ gì và rẽ sang đúng nhóm kịch bản.",
        nodeKeys: ["COMMON.SERVICE_ROUTING", "COMMON.SERVICE_ROUTING.WEDDING_CLARIFY", "COMMON.SERVICE_ROUTING.MATCHED"],
        questionAnswerRows: routingRows,
        routeCount: COMMON_SERVICE_ROUTES.length,
      },
    ],
    serviceRoutes: COMMON_ROUTING_OPTIONS,
    fallbackNode: nodes.find((node) => node.nodeKey === "COMMON.HANDOFF.UNMAPPED_REQUEST") ?? null,
  };
}

function sheetRowsFromRequest(
  value: unknown,
  options: { routing?: boolean } = {},
): Array<Omit<SaleScriptQuestionAnswerRow, "source" | "updatedAt">> | null {
  if (!Array.isArray(value)) return null;
  let invalidRoutingRow = false;
  const rows = value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.question !== "string" || typeof row.answer !== "string")
      return [];
    const question = row.question.trim();
    const answer = row.answer.trim();
    if (!question || !answer) return [];
    const id =
      typeof row.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(row.id)
        ? row.id
        : `qa-${index + 1}`;
    const stepId =
      typeof row.stepId === "number" &&
      Number.isInteger(row.stepId) &&
      row.stepId >= 1 &&
      row.stepId <= 9
        ? row.stepId
        : 1;
    const serviceKey = typeof row.serviceKey === "string" ? row.serviceKey.trim() : "";
    const routeKey = typeof row.routeKey === "string" ? row.routeKey.trim() : "";
    if (options.routing) {
      // Keep unconfigured rows as drafts; the runtime ignores them until routed.
      if (!serviceKey && !routeKey) {
        return [{ id, stepId, question: question.slice(0, 2000), answer: answer.slice(0, 8000) }];
      }
      const route = COMMON_ROUTING_OPTIONS.find(
        (candidate) => candidate.serviceKey === serviceKey && candidate.routeKey === routeKey,
      );
      if (!route) {
        invalidRoutingRow = true;
        return [];
      }
    }
    return [
      {
        id,
        stepId,
        question: question.slice(0, 2000),
        answer: answer.slice(0, 8000),
        ...(options.routing ? { serviceKey, routeKey } : {}),
      },
    ];
  });
  if (invalidRoutingRow) return null;
  return rows.slice(0, 100);
}

async function requireStaff(
  req: Request,
  res: Response,
): Promise<Caller | null> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  const result = await pool.query(
    `SELECT id, name FROM staff WHERE id = $1 AND is_active = 1`,
    [callerId],
  );
  const user = result.rows[0] as
    | { id: number; name: string | null }
    | undefined;
  if (!user) {
    res.status(401).json({ error: "Invalid staff account" });
    return null;
  }
  return { id: user.id, name: user.name ?? null };
}

async function listGroups(): Promise<GroupRow[]> {
  const result = await pool.query(`
    SELECT g.id, g.name, g.description, g.ai_image_url, g.public_for_customer, g.is_active,
      COUNT(p.id)::int AS package_count,
      COUNT(p.id) FILTER (WHERE p.is_active = 1)::int AS active_package_count
    FROM service_groups g
    LEFT JOIN service_packages p ON p.group_id = g.id
    GROUP BY g.id
    ORDER BY g.sort_order, g.id
  `);
  return result.rows as GroupRow[];
}

async function ensureDraft(caller: Caller): Promise<BrainVersion> {
  const open = await getOpenDraftVersion();
  if (open) return open;
  const active = await getActiveVersion();
  if (!active)
    throw new Error("No active Lulu version is available to create a draft");
  return createDraftVersion({
    title: `Kich ban Sale - ban nhap tu Version ${active.versionNumber}`,
    description:
      "Ban nhap chinh sua Kich ban Sale; chua ap dung vao chat that.",
    promptContent: active.promptContent,
    rulesJson: active.rulesJson,
    basedOnVersionId: active.id,
    changeSummary: "Khoi tao ban nhap de sua Kich ban Sale.",
    createdBy: caller.id,
    createdByName: caller.name,
  });
}

function dashboardGroup(group: GroupRow, draft: BrainVersion | null) {
  const script = serviceForGroup(group);
  const overrides = getSaleScriptDraftStore(draft?.rulesJson).nodes;
  const nodes = groupNodes(group, overrides);
  const warnings: string[] = [];
  if (Number(group.active_package_count) === 0)
    warnings.push("Thieu goi gia dang ban");
  if (!group.ai_image_url || !group.public_for_customer)
    warnings.push("Thieu anh bang gia cong khai");
  if (
    script.active &&
    nodes.filter((node) => node.stepNumber >= 2 && node.stepNumber <= 7)
      .length === 0
  )
    warnings.push("Thieu node kich ban");
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    packageCount: Number(group.package_count),
    activePackageCount: Number(group.active_package_count),
    priceImageUrl: group.ai_image_url,
    priceImagePublic: group.public_for_customer,
    isActive: Boolean(group.is_active),
    ...script,
    status: script.active ? "dang_dung" : draft ? "ban_nhap" : "chua_co",
    activeVersion: script.active ? 1 : null,
    draftVersion: draft?.versionNumber ?? null,
    nodeCount: nodes.length,
    // Every service group exposes the same nine-stage editing frame. Groups
    // without an active engine keep those stages empty until they are authored.
    stepCount: 9,
    warnings,
  };
}

router.get("/sale-scripts", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    await ensureBrainLabTables();
    const [groups, active, draft] = await Promise.all([
      listGroups(),
      getActiveVersion(),
      getOpenDraftVersion(),
    ]);
    const items = groups.map((group) => dashboardGroup(group, draft));
    res.json({
      common: commonPayload(active, draft),
      groups: items,
      stats: {
        totalGroups: items.length,
        groupsWithScript: items.filter((item) => item.active).length,
        groupsWithoutScript: items.filter((item) => !item.active).length,
        drafts: draft ? 1 : 0,
        activeScripts: items.filter((item) => item.status === "dang_dung")
          .length,
        groupsMissingPrice: items.filter((item) =>
          item.warnings.includes("Thieu goi gia dang ban"),
        ).length,
        groupsMissingPriceImage: items.filter((item) =>
          item.warnings.includes("Thieu anh bang gia cong khai"),
        ).length,
      },
    });
  } catch (error) {
    console.error(
      "[SaleScripts] dashboard failed:",
      String(error).slice(0, 180),
    );
    res.status(500).json({ error: "Cannot load Sale Script dashboard" });
  }
});

router.get("/sale-scripts/common", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    await ensureBrainLabTables();
    const [active, draft] = await Promise.all([
      getActiveVersion(),
      getOpenDraftVersion(),
    ]);
    res.json(commonPayload(active, draft));
  } catch (error) {
    res.status(500).json({ error: "Cannot load common Sale Script" });
  }
});

router.post("/sale-scripts/common/test", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  const body = (req.body ?? {}) as { message?: unknown; prior?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "Customer message is required" });
  const prior: SaleHistoryItem[] = Array.isArray(body.prior)
    ? body.prior.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const entry = item as Record<string, unknown>;
        if ((entry.direction !== "incoming" && entry.direction !== "outgoing") || typeof entry.message !== "string") return [];
        return [{ direction: entry.direction, message: entry.message, aiDecision: typeof entry.aiDecision === "string" ? entry.aiDecision : null } as SaleHistoryItem];
      }).slice(-20)
    : [];
  try {
    await ensureBrainLabTables();
    const draft = await getOpenDraftVersion();
    const workflowBefore = evaluateSaleWorkflow({ message: "", prior });
    const workflow = evaluateSaleWorkflow({ message, prior });
    const routing = resolveCommonServiceRouting(message, workflow.serviceKey);
    const draftStore = getSaleScriptDraftStore(draft?.rulesJson);
    const trace = selectSaleScriptResponse({
      message,
      workflow,
      workflowBefore,
      overrides: draftStore.nodes,
      questionAnswerSheets: draftStore.questionAnswerSheets,
    });
    const asksForService = trace.nodeKey === "COMMON.GREETING"
      || trace.nodeKey === "COMMON.SERVICE_ROUTING"
      || trace.nodeKey === "COMMON.SERVICE_ROUTING.WEDDING_CLARIFY";
    res.json({
      message,
      intent: workflow.priceRequested ? "ASK_PRICE" : routing.selected ? "SERVICE_SELECTION" : trace.stage,
      service: trace.stateAfter.serviceType,
      serviceLabel: routing.selected?.label ?? null,
      serviceCandidates: trace.stateAfter.serviceCandidates,
      confidence: routing.confidence,
      route: trace.routeKey,
      askServiceAgain: asksForService,
      askReason: asksForService ? trace.decisionRule : null,
      nodeKey: trace.nodeKey,
      reply: trace.renderedText,
      stateBefore: trace.stateBefore,
      stateAfter: trace.stateAfter,
      decisionRule: trace.decisionRule,
    });
  } catch (error) {
    console.error("[SaleScripts] common test failed:", String(error).slice(0, 180));
    res.status(500).json({ error: "Cannot test common Sale Script" });
  }
});

router.put(["/sale-scripts/common/question-answer-sheet", "/sale-scripts/common/question-answer-sheet/:tableKey"], async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const tableKey = String(req.params.tableKey ?? COMMON_GREETING_SHEET).trim();
  if (!COMMON_SHEET_KEYS.has(tableKey)) return res.status(400).json({ error: "Invalid common script table" });
  const rows = sheetRowsFromRequest((req.body ?? {}).rows, { routing: tableKey === COMMON_ROUTING_SHEET });
  if (!rows)
    return res
      .status(400)
      .json({ error: "Question and Answer rows are required" });
  try {
    await ensureBrainLabTables();
    const draft = await ensureDraft(caller);
    const updated = await updateDraftVersion(draft.id, {
      rulesJson: withSaleScriptQuestionAnswerSheet(
        draft.rulesJson,
        tableKey,
        rows,
      ),
      changeSummary: `Cap nhat ${rows.length} dong hoi dap trong ${tableKey} (source=manual).`,
    });
    if (!updated)
      return res.status(409).json({ error: "Draft is no longer editable" });
    res.json({
      draft: updated,
      questionAnswerRows: commonTableRows(updated.rulesJson, tableKey),
    });
  } catch (error) {
    console.error(
      "[SaleScripts] save common sheet failed:",
      String(error).slice(0, 180),
    );
    res
      .status(500)
      .json({ error: "Cannot save common Question and Answer sheet" });
  }
});

router.put("/sale-scripts/common/nodes/:nodeKey", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const nodeKey = String(req.params.nodeKey ?? "").trim();
  const body = (req.body ?? {}) as {
    title?: unknown;
    replyTemplate?: unknown;
    customerExamples?: unknown;
    nextQuestion?: unknown;
  };
  if (
    !nodeKey ||
    typeof body.replyTemplate !== "string" ||
    !body.replyTemplate.trim()
  ) {
    return res.status(400).json({ error: "Reply text is required" });
  }
  try {
    await ensureBrainLabTables();
    const base = LULU_SCRIPT_NODES.find(
      (node) => node.nodeKey === nodeKey && node.scriptKey === "SALE_COMMON",
    );
    if (!base)
      return res.status(404).json({ error: "Common script node not found" });
    const draft = await ensureDraft(caller);
    const patch = {
      nodeKey,
      ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
      replyTemplate: body.replyTemplate.trim(),
      ...(Array.isArray(body.customerExamples)
        ? {
            customerExamples: body.customerExamples
              .filter(
                (item): item is string =>
                  typeof item === "string" && item.trim().length > 0,
              )
              .map((item) => item.trim())
              .slice(0, 12),
          }
        : {}),
      ...(typeof body.nextQuestion === "string"
        ? { nextQuestion: body.nextQuestion.trim() }
        : {}),
    };
    const updated = await updateDraftVersion(draft.id, {
      rulesJson: withSaleScriptNodeOverride(draft.rulesJson, patch),
      changeSummary: `Sua node ${nodeKey} trong Kich ban chung (source=manual).`,
    });
    if (!updated)
      return res.status(409).json({ error: "Draft is no longer editable" });
    const override = getSaleScriptDraftStore(updated.rulesJson).nodes[nodeKey];
    res.json({
      draft: updated,
      node: nodeWithDraft(base, { [nodeKey]: override }),
    });
  } catch (error) {
    console.error(
      "[SaleScripts] save common node failed:",
      String(error).slice(0, 180),
    );
    res.status(500).json({ error: "Cannot save common Sale Script draft" });
  }
});

router.get("/sale-scripts/:serviceGroupId", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  const groupId = Number(req.params.serviceGroupId);
  if (!Number.isInteger(groupId))
    return res.status(400).json({ error: "Invalid service group" });
  try {
    await ensureBrainLabTables();
    const [groups, active, draft] = await Promise.all([
      listGroups(),
      getActiveVersion(),
      getOpenDraftVersion(),
    ]);
    const group = groups.find((item) => item.id === groupId);
    if (!group)
      return res.status(404).json({ error: "Service group not found" });
    const result = await pool.query(
      `
      SELECT id, name, code, price, description, notes, is_active
      FROM service_packages WHERE group_id = $1 ORDER BY sort_order, id
    `,
      [group.id],
    );
    const pricing = result.rows.map((pkg) => {
      const source = normalize(
        `${pkg.name ?? ""} ${pkg.code ?? ""} ${pkg.description ?? ""} ${pkg.notes ?? ""}`,
      );
      const partnerOnly =
        /(doi tac|partner|noi bo|internal|ctv|cong tac vien|gia ho tro)/.test(
          source,
        );
      return {
        ...pkg,
        price: Number(pkg.price),
        isActive: Boolean(pkg.is_active),
        audience: partnerOnly ? "partner" : "retail",
      };
    });
    const item = dashboardGroup(group, draft);
    res.json({
      group: item,
      script: {
        scriptKey: item.scriptKey,
        serviceKey: item.serviceKey,
        activeVersion: active?.versionNumber ?? 1,
        draftVersion: draft?.versionNumber ?? null,
        nodes: groupNodes(
          group,
          getSaleScriptDraftStore(draft?.rulesJson).nodes,
        ),
        questionAnswerRows: questionAnswerRows(
          draft?.rulesJson,
          item.scriptKey,
        ),
      },
      pricing,
      promotion: {
        configured: false,
        message:
          "Chua co chuong trinh khuyen mai duoc kich hoat trong Kich ban Sale.",
      },
      liveRepliesEnabled: false,
    });
  } catch (error) {
    console.error("[SaleScripts] detail failed:", String(error).slice(0, 180));
    res.status(500).json({ error: "Cannot load Sale Script" });
  }
});

router.put(
  "/sale-scripts/:serviceGroupId/question-answer-sheet",
  async (req, res) => {
    const caller = await requireStaff(req, res);
    if (!caller) return;
    const groupId = Number(req.params.serviceGroupId);
    const rows = sheetRowsFromRequest((req.body ?? {}).rows);
    if (!Number.isInteger(groupId) || !rows)
      return res
        .status(400)
        .json({ error: "Valid Question and Answer rows are required" });
    try {
      await ensureBrainLabTables();
      const groups = await listGroups();
      const group = groups.find((item) => item.id === groupId);
      if (!group)
        return res.status(404).json({ error: "Service group not found" });
      const script = serviceForGroup(group);
      const draft = await ensureDraft(caller);
      const updated = await updateDraftVersion(draft.id, {
        rulesJson: withSaleScriptQuestionAnswerSheet(
          draft.rulesJson,
          script.scriptKey,
          rows,
        ),
        changeSummary: `Cap nhat ${rows.length} dong hoi dap cho ${script.scriptKey} (source=manual).`,
      });
      if (!updated)
        return res.status(409).json({ error: "Draft is no longer editable" });
      res.json({
        draft: updated,
        questionAnswerRows: questionAnswerRows(
          updated.rulesJson,
          script.scriptKey,
        ),
      });
    } catch (error) {
      console.error(
        "[SaleScripts] save sheet failed:",
        String(error).slice(0, 180),
      );
      res.status(500).json({ error: "Cannot save Question and Answer sheet" });
    }
  },
);

router.put("/sale-scripts/:serviceGroupId/nodes/:nodeKey", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const groupId = Number(req.params.serviceGroupId);
  const nodeKey = String(req.params.nodeKey ?? "").trim();
  if (!Number.isInteger(groupId) || !nodeKey)
    return res.status(400).json({ error: "Invalid node request" });
  const body = (req.body ?? {}) as {
    title?: unknown;
    replyTemplate?: unknown;
    customerExamples?: unknown;
    nextQuestion?: unknown;
  };
  if (typeof body.replyTemplate !== "string" || !body.replyTemplate.trim())
    return res.status(400).json({ error: "Reply text is required" });
  try {
    await ensureBrainLabTables();
    const groups = await listGroups();
    const group = groups.find((item) => item.id === groupId);
    if (!group)
      return res.status(404).json({ error: "Service group not found" });
    const script = serviceForGroup(group);
    const base = LULU_SCRIPT_NODES.find(
      (node) => node.nodeKey === nodeKey && node.scriptKey === script.scriptKey,
    );
    if (!base)
      return res
        .status(404)
        .json({
          error: "This node is not editable for the selected service group",
        });

    const draft = await ensureDraft(caller);
    const patch = {
      nodeKey,
      ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
      replyTemplate: body.replyTemplate.trim(),
      ...(Array.isArray(body.customerExamples)
        ? {
            customerExamples: body.customerExamples
              .filter(
                (item): item is string =>
                  typeof item === "string" && item.trim().length > 0,
              )
              .map((item) => item.trim())
              .slice(0, 12),
          }
        : {}),
      ...(typeof body.nextQuestion === "string"
        ? { nextQuestion: body.nextQuestion.trim() }
        : {}),
    };
    const updated = await updateDraftVersion(draft.id, {
      rulesJson: withSaleScriptNodeOverride(draft.rulesJson, patch),
      changeSummary: `Sua node ${nodeKey} trong Kich ban Sale (source=manual).`,
    });
    if (!updated)
      return res.status(409).json({ error: "Draft is no longer editable" });
    const override = getSaleScriptDraftStore(updated.rulesJson).nodes[nodeKey];
    res.json({
      draft: updated,
      node: nodeWithDraft(base, { [nodeKey]: override }),
    });
  } catch (error) {
    console.error(
      "[SaleScripts] save node failed:",
      String(error).slice(0, 180),
    );
    res.status(500).json({ error: "Cannot save Sale Script draft" });
  }
});

export default router;
