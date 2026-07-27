/**
 * Test cho nguồn crew canonical (sự cố DH0248 27/07/2026): 11 phân công 1 dịch vụ
 * → màn chi tiết chỉ hiện 3–4 dòng (dedupe theo TÊN toàn cục), card tuần/tháng rớt
 * Marketing/Khác + chip "TL" không tên. Mọi surface phải cùng đọc collectCrew.
 */
import { describe, it, expect } from "vitest";
import {
  collectCrew, crewNameCount, crewFlags, crewDetailLines, crewCompactLine, canonicalRole,
} from "./crew-display";

const sa = (role: string, staffName: string) => ({ role, staffName });

// Fixture DH0248: 11 phân công, 4 người, 8 vai trò — "Long lee" giữ 6 vai trò.
const DH0248 = [
  sa("photographer", "HUY LA THANG - FREELANCER"),
  sa("photographer", "Long lee make up freelancer"),
  sa("assistant", "Long lee make up freelancer"),
  sa("videographer", "Long lee make up freelancer"),
  sa("marketing", "Long lee make up freelancer"),
  sa("sales", "Long lee make up freelancer"),
  sa("makeup", "HUY LA THANG - FREELANCER"),
  sa("assistant", "MINH CHÂU MAKEUP FREELANCER"),
  sa("assistant_photo", "Long lee make up freelancer"),
  sa("other", "MINH CHÂU MAKEUP FREELANCER"),
  sa("videographer", "NGUYỄN NHẬT TRƯỜNG"),
];

describe("collectCrew — DH0248 11 phân công", () => {
  it("case 1+9: giữ ĐỦ 11 assignment trong 8 nhóm role — không mất ai", () => {
    const groups = collectCrew({ items: [{ assignedStaff: DH0248 }] });
    expect(crewNameCount(groups)).toBe(11);
    expect(groups.map(g => g.canon).sort()).toEqual([
      "assistant", "assistant_photo", "makeup", "marketing",
      "other", "photographer", "sales", "videographer",
    ]);
  });

  it("case 2: một người giữ 6 vai trò → xuất hiện ở ĐỦ 6 nhóm", () => {
    const groups = collectCrew({ items: [{ assignedStaff: DH0248 }] });
    const rolesOfLonglee = groups
      .filter(g => g.names.some(n => n.includes("Long lee")))
      .map(g => g.canon)
      .sort();
    expect(rolesOfLonglee).toEqual([
      "assistant", "assistant_photo", "marketing", "photographer", "sales", "videographer",
    ]);
  });

  it("case 3+4: hai người cùng role Quay phim / Trợ lý — đủ cả hai tên", () => {
    const groups = collectCrew({ items: [{ assignedStaff: DH0248 }] });
    expect(groups.find(g => g.canon === "videographer")!.names).toEqual([
      "Long lee make up freelancer", "NGUYỄN NHẬT TRƯỜNG",
    ]);
    expect(groups.find(g => g.canon === "assistant")!.names).toEqual([
      "Long lee make up freelancer", "MINH CHÂU MAKEUP FREELANCER",
    ]);
  });

  it("case 5: role 'Khác' hiện nhãn Khác với tên, không bị rớt", () => {
    const lines = crewDetailLines(collectCrew({ items: [{ assignedStaff: DH0248 }] }));
    const khac = lines.find(l => l.canon === "other")!;
    expect(khac.label).toBe("Khác");
    expect(khac.names).toEqual(["MINH CHÂU MAKEUP FREELANCER"]);
  });

  it("case 6: legacy photoName trùng 1 assignment canonical → chỉ loại đúng bản trùng", () => {
    const groups = collectCrew({
      items: [{
        assignedStaff: DH0248,
        photoName: "HUY LA THANG - FREELANCER", // trùng photographer đã có
        makeupName: "",
      }],
    });
    expect(crewNameCount(groups)).toBe(11); // không đội thêm, không mất
    expect(groups.find(g => g.canon === "photographer")!.names).toHaveLength(2);
  });

  it("case 6b: legacy photoName KHÁC tên → union (không thay thế assignment)", () => {
    const groups = collectCrew({
      items: [{ assignedStaff: [sa("photographer", "A")], photoName: "B", makeupName: "" }],
    });
    expect(groups.find(g => g.canon === "photographer")!.names).toEqual(["A", "B"]);
  });

  it("case 7+8: hai dịch vụ (2 lần gọi theo items của TỪNG dịch vụ) không lẫn nhân sự", () => {
    const svc1 = collectCrew({ items: [{ assignedStaff: [sa("photographer", "A")] }] });
    const svc2 = collectCrew({ items: [{ assignedStaff: [sa("makeup", "B")] }] });
    expect(crewNameCount(svc1)).toBe(1);
    expect(svc1[0]).toMatchObject({ canon: "photographer", names: ["A"] });
    expect(crewNameCount(svc2)).toBe(1);
    expect(svc2[0]).toMatchObject({ canon: "makeup", names: ["B"] });
  });

  it("nhiều items trong CÙNG dịch vụ: gộp đủ (hết lỗi chỉ đọc items[0])", () => {
    const groups = collectCrew({
      items: [
        { assignedStaff: [sa("photographer", "A")] },
        { assignedStaff: [sa("assistant", "B")] },
      ],
    });
    expect(crewNameCount(groups)).toBe(2);
  });
});

describe("crewCompactLine — card tuần/tháng", () => {
  it("case 10: extras CÓ TÊN cho mọi role phụ — hết chip TL vô danh, không rớt Marketing/Khác", () => {
    const line = crewCompactLine(collectCrew({ items: [{ assignedStaff: DH0248 }] }));
    expect(line.p).toBe("HUY LA THANG - FREELANCER, Long lee make up freelancer");
    expect(line.v).toBe("Long lee make up freelancer, NGUYỄN NHẬT TRƯỜNG");
    expect(line.sale).toBe("Long lee make up freelancer");
    const byCanon = Object.fromEntries(line.extras.map(e => [e.canon, e]));
    expect(byCanon.assistant.names).toHaveLength(2);
    expect(byCanon.assistant_photo.short).toBe("TP");
    expect(byCanon.marketing.names).toEqual(["Long lee make up freelancer"]);
    expect(byCanon.other.names).toEqual(["MINH CHÂU MAKEUP FREELANCER"]);
    // Tổng tên 4 role chính + extras = 11
    const mainCount = [line.p, line.m, line.v, line.sale]
      .filter(Boolean)
      .reduce((n, s) => n + s.split(", ").length, 0);
    const extraCount = line.extras.reduce((n, e) => n + e.names.length, 0);
    expect(mainCount + extraCount).toBe(11);
  });
});

describe("hành vi giữ nguyên + biên", () => {
  it("taskAssignees chỉ đắp role trống (tên cũ từ tasks không đè items)", () => {
    const groups = collectCrew({
      items: [{ assignedStaff: [sa("photographer", "Mới")] }],
      taskAssignees: [
        { role: "photographer", taskType: null, assigneeName: "Cũ" },
        { role: "assistant", taskType: null, assigneeName: "TL-từ-task" },
      ],
    });
    expect(groups.find(g => g.canon === "photographer")!.names).toEqual(["Mới"]);
    expect(groups.find(g => g.canon === "assistant")!.names).toEqual(["TL-từ-task"]);
  });

  it("alias sale/sales gộp 1 nhóm; legacy object {sale: 4} bỏ qua không crash", () => {
    const groups = collectCrew({
      items: [{ assignedStaff: [sa("sales", "A"), sa("sale", "B")] }],
      bookingAssignedStaff: { sale: 4, photoshop: 7 },
    });
    expect(groups.filter(g => g.canon === "sales")).toHaveLength(1);
    expect(groups.find(g => g.canon === "sales")!.names).toEqual(["A", "B"]);
  });

  it("role lạ chưa từng có: hiện nhãn raw, không bị rớt", () => {
    const groups = collectCrew({ items: [{ assignedStaff: [sa("drone_pilot", "X")] }] });
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Drone_pilot");
    expect(groups[0].names).toEqual(["X"]);
  });

  it("crewFlags giữ nguyên ngữ nghĩa cảnh báo cũ", () => {
    const only = (r: string) => collectCrew({ items: [{ assignedStaff: [sa(r, "X")] }] });
    expect(crewFlags(only("assistant")).unassigned).toBe(true);   // như main
    expect(crewFlags(only("photographer")).unassigned).toBe(false);
    expect(crewFlags(only("videographer")).isFullyAssigned).toBe(true);
    expect(canonicalRole(null)).toBe("other");
  });
});
