import { describe, it, expect, vi } from "vitest";
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import { computeServiceTrail } from "./sale-service-context";

const inc = (message: string) => ({ direction: "incoming" as const, message });
const out = (message: string) => ({ direction: "outgoing" as const, message });

describe("computeServiceTrail — đổi & quay lại dịch vụ giữa chat", () => {
  it("TEST4: Ảnh cổng → Album cưới ⇒ current=album, previous=cổng, switched", () => {
    const t = computeServiceTrail([
      inc("Ảnh cổng bên mình bao nhiêu vậy?"),
      out("Dạ ảnh cổng bên em..."),
      inc("Còn album cưới thì sao em?"),
    ]);
    expect(t.current).toBe("wedding_album");
    expect(t.previous).toBe("wedding_gate");
    expect(t.switched).toBe(true);
    expect(t.referenced).toEqual(["wedding_gate", "wedding_album"]);
  });

  it("TEST5: quay lại Ảnh cổng ⇒ current về wedding_gate, giữ referenced", () => {
    const t = computeServiceTrail([
      inc("Ảnh cổng bao nhiêu?"),
      inc("Còn album cưới thì sao?"),
      inc("Còn ảnh cổng lúc nãy thì sao em?"),
    ]);
    expect(t.current).toBe("wedding_gate");
    expect(t.previous).toBe("wedding_album");
    expect(t.referenced).toEqual(["wedding_gate", "wedding_album"]);
  });

  it("tin không nêu dịch vụ (chào/hỏi chung) ⇒ giữ nguyên current, không switch", () => {
    const t = computeServiceTrail([inc("Chào em"), inc("Bên mình chụp album cưới nha"), inc("Ừ vậy đi")]);
    expect(t.current).toBe("wedding_album");
    expect(t.switched).toBe(false);
  });

  it("chưa rõ dịch vụ ⇒ current null", () => {
    expect(computeServiceTrail([inc("Chào shop"), inc("Cho hỏi xíu")]).current).toBeNull();
  });
});
