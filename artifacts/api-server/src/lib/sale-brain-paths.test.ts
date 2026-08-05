import { describe, it, expect, vi } from "vitest";
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { simulateThreadStateFromHistory } from "./sale-thread-state";
import { resolveScenario, type ScenarioResolveResult } from "./sale-scenario-resolver";
import { cardToDef, type ScenarioDef } from "./sale-scenario-types";
import { compileCard } from "./sale-scenario-compiler";
import { SEED_SCENARIOS } from "./sale-scenario-seed";

/**
 * ĐƯỜNG ĐI A–E (yêu cầu nghiệm thu 30/07) — chạy qua ĐÚNG resolver + 22 thẻ seed.
 * Khách nhảy nhánh tự do; engine bám intent, không ép tuyến tính.
 */

const DEFS: ScenarioDef[] = SEED_SCENARIOS.map((s, i) => cardToDef(s.key, compileCard(s.card).card, (i + 1) * 10, true));
const NOW = new Date(2026, 6, 28, 10, 0, 0);
const SYNTH: Record<string, string> = {
  ASK_DATE: "Dạ mình chụp khi nào ạ?", QUOTE_REFERENCE: "Dạ em gửi giá tham khảo nha",
  QUOTE_EXACT: "Dạ giá gói đây ạ", SEND_SAMPLE: "[image:https://x/m.jpg]", GREET: "Dạ em chào mình ạ",
};

function runPath(msgs: string[]): Array<ScenarioResolveResult & { msg: string }> {
  const out: Array<ScenarioResolveResult & { msg: string }> = [];
  let history: Array<{ direction: "incoming" | "outgoing"; message: string }> = [];
  const quoted: string[] = [];
  for (const msg of msgs) {
    const state = simulateThreadStateFromHistory([...history, { direction: "incoming", message: msg }], { quotedCodes: quoted, now: NOW });
    const r = resolveScenario({ customerMessage: msg, threadState: state, isFirstContact: history.length === 0, scenarios: DEFS });
    out.push({ ...r, msg });
    if (["QUOTE_REFERENCE", "QUOTE_EXACT", "SEND_PRICE"].includes(r.decision.action)) quoted.push(`G-${quoted.length + 1}`);
    history = [...history, { direction: "incoming", message: msg }, { direction: "outgoing", message: SYNTH[r.decision.action] ?? "Dạ vâng ạ" }];
  }
  return out;
}
const acts = (r: Array<ScenarioResolveResult & { msg: string }>) => r.map((x) => x.decision.action);
const noAskDate = (r: Array<ScenarioResolveResult & { msg: string }>) => r.every((x) => x.decision.action !== "ASK_DATE" || !x.decision.forbiddenQuestions.includes("ask_date"));

describe("Đường đi Sales Brain A–E", () => {
  it("A. Chào → album cưới → xem mẫu → giá(chưa ngày) → chốt", () => {
    const r = runPath([
      "alo em oi", "chị muốn chụp album cưới", "cho xem mẫu đi",
      "chưa chốt ngày, giá tham khảo nha", "ok chốt gói này luôn",
    ]);
    expect(acts(r)[0]).toBe("GREET");
    expect(r[2].decision.action).toBe("SEND_SAMPLE");
    expect(r[3].winner?.key).toBe("hoi-gia-chua-ngay");
    expect(r[3].decision.action).toBe("QUOTE_REFERENCE");
    expect(r[4].winner?.key).toBe("chon-duoc-goi");
    expect(noAskDate(r)).toBe(true);
  });

  it("B. Album cưới → báo giá → giá cao → xin giảm → không chốt (cấm tự giảm)", () => {
    const r = runPath([
      "album cưới giá nhiêu em", "20/12 nha", "mắc vậy em", "bớt chút được không",
    ]);
    expect(r[1].decision.action).toBe("QUOTE_EXACT");
    expect(r[2].decision.action).toBe("HANDLE_OBJECTION");
    expect(r[3].decision.action).toBe("HANDLE_OBJECTION");
    // Không lượt nào để Lulu tự giảm (self_discount luôn bị cấm khi xử lý giá).
    expect(r[2].decision.forbiddenQuestions).toContain("self_discount");
  });

  it("C. Tin ĐẦU hỏi thẳng giá album → nhảy thẳng báo giá (không bắt đi tuần tự)", () => {
    const r = runPath(["album cưới bao nhiêu tiền v em, 20/12"]);
    // 1 tin gộp intent + ngày → engine tự tới báo giá, KHÔNG bắt chào→nhu cầu→concept trước.
    expect(["QUOTE_EXACT", "QUOTE_REFERENCE"]).toContain(r[0].decision.action);
  });

  it("D. Đang album cưới → đổi ý hỏi phóng sự → theo intent mới", () => {
    const r = runPath([
      "chụp album cưới nha", "à mà thôi, chụp phóng sự tiệc cưới 2 máy cơ",
    ]);
    // Tin 2 đổi intent → state.serviceIntent chuyển; không kẹt ở album.
    const st = simulateThreadStateFromHistory(
      [{ direction: "incoming", message: "chụp album cưới nha" }, { direction: "outgoing", message: "dạ" }, { direction: "incoming", message: "à mà thôi, chụp phóng sự tiệc cưới 2 máy cơ" }],
      { now: NOW },
    );
    expect(st.serviceIntent).toBe("wedding_party");
    expect(r[1].decision.action).not.toBe("GREET");
  });

  it("E. (giá sống) — resolver KHÔNG chứa số tiền; giá do getEffectivePrice quyết (test riêng sale-pricing)", () => {
    // Khẳng định kiến trúc: quyết định resolver chỉ mang knowledgeNeeded 'pricing:*', KHÔNG con số.
    const r = runPath(["album cưới chưa chốt ngày, giá tham khảo em"]);
    const dec = r[0].decision;
    expect(dec.knowledgeNeeded.some((k) => k.startsWith("pricing:"))).toBe(true);
    expect(JSON.stringify(dec)).not.toMatch(/\d{6,}/); // không có số tiền 6+ chữ số nhúng trong quyết định
  });
});
