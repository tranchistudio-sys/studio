/**
 * Test cho nguồn crew canonical (sự cố DH0248 27/07/2026): 11 phân công 1 dịch vụ
 * → màn chi tiết chỉ hiện 3–4 dòng (dedupe theo TÊN toàn cục), card tuần/tháng rớt
 * Marketing/Khác + chip "TL" không tên. Mọi surface phải cùng đọc collectCrew.
 */
import { describe, it, expect } from "vitest";
import {
  collectCrew, crewNameCount, crewFlags, crewDetailLines, crewCompactLine, canonicalRole,
  isServiceStaffLocked, allServicesStaffLocked,
} from "./crew-display";

const sa = (role: string, staffName: string, staffId?: number) => ({ role, staffName, staffId });

// Fixture DH0248: 11 phân công, 4 người (staffId 1,2,3,4), 8 vai trò — "Long lee" (2) giữ 6 vai trò.
const DH0248 = [
  sa("photographer", "HUY LA THANG - FREELANCER", 1),
  sa("photographer", "Long lee make up freelancer", 2),
  sa("assistant", "Long lee make up freelancer", 2),
  sa("videographer", "Long lee make up freelancer", 2),
  sa("marketing", "Long lee make up freelancer", 2),
  sa("sales", "Long lee make up freelancer", 2),
  sa("makeup", "HUY LA THANG - FREELANCER", 1),
  sa("assistant", "MINH CHÂU MAKEUP FREELANCER", 3),
  sa("assistant_photo", "Long lee make up freelancer", 2),
  sa("other", "MINH CHÂU MAKEUP FREELANCER", 3),
  sa("videographer", "NGUYỄN NHẬT TRƯỜNG", 4),
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

describe("REVIEW #134 — F1 dedupe theo ĐỊNH DANH + F2 taskAssignees lấp đủ + F3 coverage", () => {
  it("F1: HAI NGƯỜI khác staffId nhưng TRÙNG TÊN → giữ đủ cả hai", () => {
    const groups = collectCrew({ items: [{ assignedStaff: [
      sa("photographer", "Nguyễn Văn A", 21),
      sa("photographer", "Nguyễn Văn A", 22),
    ] }] });
    expect(groups.find(g => g.canon === "photographer")!.names).toEqual(["Nguyễn Văn A", "Nguyễn Văn A"]);
    expect(crewNameCount(groups)).toBe(2);
  });

  it("F1: cùng staffId lặp 2 lần trong role → chỉ 1 (trùng thật)", () => {
    const groups = collectCrew({ items: [
      { assignedStaff: [sa("photographer", "A", 21)] },
      { assignedStaff: [sa("photographer", "A", 21)] },
    ] });
    expect(crewNameCount(groups)).toBe(1);
  });

  it("F1: legacy-không-id vào TRƯỚC, canonical-có-id cùng tên vào SAU → 1 người (không hiện đôi)", () => {
    const groups = collectCrew({ items: [
      { assignedStaff: [], photoName: "B" },          // item 0: chỉ legacy
      { assignedStaff: [sa("photographer", "B", 30)] }, // item 1: canonical cùng tên
    ] });
    expect(groups.find(g => g.canon === "photographer")!.names).toEqual(["B"]);
  });

  it("F2: role TRỐNG nhận ĐỦ nhiều người từ taskAssignees (không chỉ người đầu)", () => {
    const groups = collectCrew({
      items: [{ assignedStaff: [sa("photographer", "P", 40)] }],
      taskAssignees: [
        { role: "photoshop", taskType: null, assigneeName: "PTS-A" },
        { role: "photoshop", taskType: null, assigneeName: "PTS-B" },
      ],
    });
    expect(groups.find(g => g.canon === "photoshop")!.names).toEqual(["PTS-A", "PTS-B"]);
  });

  it("W (chủ chốt 27/07): role ĐÃ CÓ canonical từ items → tên từ tasks GIỮ ẨN (chống tên stale)", () => {
    const groups = collectCrew({
      items: [{ assignedStaff: [sa("photographer", "Mới", 41)] }],
      taskAssignees: [{ role: "photographer", taskType: null, assigneeName: "Người-chỉ-trong-tasks" }],
    });
    expect(groups.find(g => g.canon === "photographer")!.names).toEqual(["Mới"]);
  });

  it("F3: parentAssignedStaff (hợp đồng cha) được gộp — Sale tầng cha hiện trên chi tiết con", () => {
    const groups = collectCrew({
      items: [{ assignedStaff: [sa("photographer", "P", 50)] }],
      parentAssignedStaff: [sa("sales", "Sale-Cha", 51)],
    });
    expect(groups.find(g => g.canon === "sales")!.names).toEqual(["Sale-Cha"]);
    expect(crewNameCount(groups)).toBe(2);
  });

  it("F3: 5 và 15 assignment — đếm đủ, không rớt", () => {
    const five = collectCrew({ items: [{ assignedStaff: [
      sa("photographer", "A", 61), sa("makeup", "B", 62), sa("videographer", "C", 63),
      sa("assistant", "D", 64), sa("marketing", "E", 65),
    ] }] });
    expect(crewNameCount(five)).toBe(5);
    const fifteenRows = [
      ["photographer", 71], ["photographer", 72], ["photographer", 73],
      ["makeup", 74], ["makeup", 75],
      ["videographer", 72], ["videographer", 76],
      ["sales", 77],
      ["assistant", 74], ["assistant", 78], ["assistant", 79],
      ["assistant_photo", 79],
      ["marketing", 80],
      ["other", 74], ["other", 78],
    ] as const;
    const fifteen = collectCrew({ items: [{
      assignedStaff: fifteenRows.map(([r, id], i) => sa(r, "NV " + id + " tên rất dài để wrap thử " + i, id)),
    }] });
    expect(crewNameCount(fifteen)).toBe(15);
  });
});

describe("F3: wiring-guard — 4 surface calendar.tsx phải nối vào lib (chặn revert lặng lẽ)", () => {
  it("calendar.tsx không còn logic crew cũ ở surface sống, có đủ call-site collectCrew", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../pages/calendar.tsx"), "utf8");
    // Bộ lọc cũ gây sự cố DH0248 phải biến mất khỏi mã sống
    expect(src.includes("seenNames.has(normName)")).toBe(false);
    expect(src.includes("const addStaff = (role")).toBe(false);
    // Đủ call-site lib: detail + day-wrapper + month + week (>= 4 lần collectCrew()
    const collectCalls = (src.match(/collectCrew\(\{/g) || []).length;
    expect(collectCalls).toBeGreaterThanOrEqual(4);
    // getStaffLine chỉ còn được GỌI trong component deprecated (1 call-site duy nhất)
    const staffLineCalls = (src.match(/getStaffLine\(/g) || []).filter(Boolean).length;
    expect(staffLineCalls).toBeLessThanOrEqual(2); // 1 định nghĩa "function getStaffLine(" + 1 call deprecated
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

// ─── Khoá "Đã đủ nhân sự" theo TỪNG dịch vụ (items[].staffLocked) ─────────────
// Bối cảnh: khách chỉ thuê váy / tự lo photographer-makeup / studio chỉ giữ ngày —
// không cần cử người, nhưng lịch vẫn kẹt cảnh báo đỏ "Chưa giao việc".
describe("staffLocked — xác nhận thủ công đủ nhân sự", () => {
  const dress = (locked?: boolean) => ({
    serviceName: "Thuê váy cưới",
    assignedStaff: [],
    ...(locked === undefined ? {} : { staffLocked: locked }),
  });
  const photo = (staff: ReturnType<typeof sa>[], locked?: boolean) => ({
    serviceName: "Chụp tiệc",
    assignedStaff: staff,
    ...(locked === undefined ? {} : { staffLocked: locked }),
  });
  const flagsOf = (items: unknown[]) =>
    crewFlags(collectCrew({ items: items as { assignedStaff?: unknown }[] }), {
      staffConfirmedComplete: allServicesStaffLocked(items),
    });

  it("isServiceStaffLocked: chỉ boolean true mới tính là đã khoá", () => {
    expect(isServiceStaffLocked({ staffLocked: true })).toBe(true);
    expect(isServiceStaffLocked({ staffLocked: false })).toBe(false);
    expect(isServiceStaffLocked({})).toBe(false);           // show cũ: không có cờ
    expect(isServiceStaffLocked({ staffLocked: "true" })).toBe(false); // rác không được tin
    expect(isServiceStaffLocked({ staffLocked: 1 })).toBe(false);
    expect(isServiceStaffLocked(null)).toBe(false);
  });

  it("allServicesStaffLocked: show rỗng / thiếu items không bao giờ tự 'đủ nhân sự'", () => {
    expect(allServicesStaffLocked([])).toBe(false);
    expect(allServicesStaffLocked(undefined)).toBe(false);
    expect(allServicesStaffLocked(null)).toBe(false);
    expect(allServicesStaffLocked([dress(true)])).toBe(true);
    expect(allServicesStaffLocked([dress(true), photo([], false)])).toBe(false);
  });

  it("test 1: show chỉ thuê váy, không nhân sự, ĐÃ khoá → hết 'Chưa giao việc'", () => {
    const f = flagsOf([dress(true)]);
    expect(f.unassigned).toBe(false);
    // và cũng không rơi sang nhãn "Thiếu" (isAssigned && !isFullyAssigned)
    expect(f.isFullyAssigned).toBe(true);
  });

  it("test 3: mở khoá, vẫn không nhân sự → lịch hiện lại 'Chưa giao việc'", () => {
    expect(flagsOf([dress(false)]).unassigned).toBe(true);
  });

  it("test 4: váy đã khoá + chụp chưa có photographer → show VẪN báo 'Chưa giao việc'", () => {
    expect(flagsOf([dress(true), photo([], false)]).unassigned).toBe(true);
  });

  it("test 5: váy đã khoá + chụp đã có photographer → show đủ nhân sự", () => {
    expect(flagsOf([dress(true), photo([sa("photographer", "TranChi", 1)])]).unassigned).toBe(false);
  });

  it("test 6: khoá dịch vụ ĐANG CÓ nhân sự → giữ nguyên mọi tên, chỉ tắt cảnh báo", () => {
    const items = [photo([sa("photographer", "TranChi", 1), sa("makeup", "Diệu Mai", 2)], true)];
    const groups = collectCrew({ items });
    expect(crewNameCount(groups)).toBe(2);
    expect(groups.find(g => g.canon === "photographer")!.names).toEqual(["TranChi"]);
    expect(crewFlags(groups, { staffConfirmedComplete: allServicesStaffLocked(items) }).unassigned).toBe(false);
  });

  it("show CŨ (items không có cờ staffLocked) giữ NGUYÊN hành vi hiện tại", () => {
    expect(flagsOf([dress()]).unassigned).toBe(true);
    expect(flagsOf([photo([sa("photographer", "TranChi", 1)])]).unassigned).toBe(false);
  });

  it("crewCompactLine (card tháng/tuần) cùng kết luận với crewFlags", () => {
    const items = [dress(true)];
    const line = crewCompactLine(collectCrew({ items }), {
      staffConfirmedComplete: allServicesStaffLocked(items),
    });
    expect(line.unassigned).toBe(false);
    expect(line.p).toBe("");           // không bịa tên nhân sự
    expect(line.extras).toEqual([]);
  });
});
