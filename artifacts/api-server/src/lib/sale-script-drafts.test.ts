import { describe, expect, it } from "vitest";
import {
  getSaleScriptDraftStore,
  withSaleScriptQuestionAnswerSheet,
} from "./sale-script-drafts";

describe("sale script draft compatibility", () => {
  it("maps the legacy greeting node to COMMON.GREETING", () => {
    const store = getSaleScriptDraftStore({
      saleScriptDraft: {
        version: 1,
        nodes: {
          "COMMON.GREETING.NEW_CUSTOMER": {
            nodeKey: "COMMON.GREETING.NEW_CUSTOMER",
            replyTemplate: "Câu chào cũ vẫn phải đọc được",
          },
        },
      },
    });

    expect(store.nodes["COMMON.GREETING"]?.replyTemplate).toBe(
      "Câu chào cũ vẫn phải đọc được",
    );
  });

  it("keeps legacy SALE_COMMON rows while saving a new routing sheet", () => {
    const legacy = {
      saleScriptDraft: {
        version: 1,
        nodes: {},
        questionAnswerSheets: {
          SALE_COMMON: [
            {
              id: "legacy-1",
              stepId: 1,
              question: "Bên mình có dịch vụ gì?",
              answer: "Bên em có nhiều nhóm dịch vụ.",
            },
          ],
        },
      },
    };

    const updated = withSaleScriptQuestionAnswerSheet(
      legacy,
      "COMMON.SERVICE_ROUTING",
      [
        {
          id: "route-1",
          stepId: 1,
          question: "Cho em hỏi chụp cổng.",
          answer: "Dạ được ạ.",
          serviceKey: "wedding_gate",
          routeKey: "SALE_WEDDING_GATE",
        },
      ],
    );
    const store = getSaleScriptDraftStore(updated);

    expect(store.questionAnswerSheets.SALE_COMMON).toHaveLength(1);
    expect(store.questionAnswerSheets["COMMON.SERVICE_ROUTING"]?.[0]).toMatchObject({
      serviceKey: "wedding_gate",
      routeKey: "SALE_WEDDING_GATE",
    });
  });
});
