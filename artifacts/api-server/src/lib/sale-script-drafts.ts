export type SaleScriptNodeOverride = {
  nodeKey: string;
  title?: string;
  replyTemplate?: string;
  customerExamples?: string[];
  nextQuestion?: string;
  source: "manual";
  updatedAt: string;
};

export type SaleScriptQuestionAnswerRow = {
  id: string;
  stepId: number;
  question: string;
  answer: string;
  // Routing rows only accept catalog values so a hand-written route cannot drift.
  serviceKey?: string;
  routeKey?: string;
  source: "manual";
  updatedAt: string;
};

export type SaleScriptDraftStore = {
  version: 1;
  nodes: Record<string, SaleScriptNodeOverride>;
  questionAnswerSheets: Record<string, SaleScriptQuestionAnswerRow[]>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function getSaleScriptDraftStore(rulesJson: unknown): SaleScriptDraftStore {
  const root = record(rulesJson);
  const raw = record(root.saleScriptDraft);
  const rawNodes = record(raw.nodes);
  const rawSheets = record(raw.questionAnswerSheets);
  const nodes: Record<string, SaleScriptNodeOverride> = {};
  const questionAnswerSheets: Record<string, SaleScriptQuestionAnswerRow[]> = {};

  for (const [nodeKey, value] of Object.entries(rawNodes)) {
    const node = record(value);
    if (!nodeKey || node.nodeKey !== nodeKey) continue;
    const compatibleNodeKey = nodeKey === "COMMON.GREETING.NEW_CUSTOMER"
      ? "COMMON.GREETING"
      : nodeKey;
    nodes[compatibleNodeKey] = {
      nodeKey: compatibleNodeKey,
      ...(typeof node.title === "string" ? { title: node.title } : {}),
      ...(typeof node.replyTemplate === "string" ? { replyTemplate: node.replyTemplate } : {}),
      ...(Array.isArray(node.customerExamples)
        ? { customerExamples: node.customerExamples.filter((item): item is string => typeof item === "string") }
        : {}),
      ...(typeof node.nextQuestion === "string" ? { nextQuestion: node.nextQuestion } : {}),
      source: "manual",
      updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
    };
  }

  for (const [scriptKey, value] of Object.entries(rawSheets)) {
    if (!scriptKey || !Array.isArray(value)) continue;
    const rows = value.flatMap((item) => {
      const row = record(item);
      if (typeof row.id !== "string" || typeof row.question !== "string" || typeof row.answer !== "string") return [];
      return [{
        id: row.id,
        stepId: typeof row.stepId === "number" && Number.isInteger(row.stepId) && row.stepId >= 1 && row.stepId <= 9 ? row.stepId : 1,
        question: row.question,
        answer: row.answer,
        ...(typeof row.serviceKey === "string" ? { serviceKey: row.serviceKey } : {}),
        ...(typeof row.routeKey === "string" ? { routeKey: row.routeKey } : {}),
        source: "manual" as const,
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
      }];
    });
    if (rows.length > 0) questionAnswerSheets[scriptKey] = rows;
  }

  return { version: 1, nodes, questionAnswerSheets };
}

export function withSaleScriptNodeOverride(
  rulesJson: unknown,
  patch: Omit<SaleScriptNodeOverride, "source" | "updatedAt">,
): Record<string, unknown> {
  const root = record(rulesJson);
  const current = getSaleScriptDraftStore(root);
  const next: SaleScriptNodeOverride = {
    ...current.nodes[patch.nodeKey],
    ...patch,
    source: "manual",
    updatedAt: new Date().toISOString(),
  };

  return {
    ...root,
    saleScriptDraft: {
      version: 1,
      nodes: { ...current.nodes, [patch.nodeKey]: next },
      questionAnswerSheets: current.questionAnswerSheets,
    },
  };
}

export function withSaleScriptQuestionAnswerSheet(
  rulesJson: unknown,
  scriptKey: string,
  rows: Array<Omit<SaleScriptQuestionAnswerRow, "source" | "updatedAt">>,
): Record<string, unknown> {
  const root = record(rulesJson);
  const current = getSaleScriptDraftStore(root);
  const updatedAt = new Date().toISOString();
  const nextRows = rows.map((row) => ({ ...row, source: "manual" as const, updatedAt }));

  return {
    ...root,
    saleScriptDraft: {
      version: 1,
      nodes: current.nodes,
      questionAnswerSheets: { ...current.questionAnswerSheets, [scriptKey]: nextRows },
    },
  };
}
