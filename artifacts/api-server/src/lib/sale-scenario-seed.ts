import type { ScenarioCard } from "./sale-scenario-types";

/**
 * 12 THẺ KỊCH BẢN MẪU — nội dung tiếng Việt đời thường (chủ studio duyệt spec 29/07).
 *
 * QUAN TRỌNG: 12 thẻ này EXTERNALIZE đúng logic routeSaleAction đang chạy — seed xong
 * hành vi PHẢI y hệt engine (Golden parity test kiểm chứng). Chủ sửa thẻ = tinh chỉnh
 * dần từ nền an toàn, không phải viết từ số 0.
 *
 * Thứ tự trong mảng = sort_order mặc định (trên = ưu tiên cao khi nhiều thẻ cùng khớp).
 * Thẻ đặc thù (gặp người thật, xin giảm) đứng TRÊN thẻ nền (chưa rõ dịch vụ).
 */

export type SeedScenario = { key: string; isCore: boolean; card: ScenarioCard };

export const SEED_SCENARIOS: SeedScenario[] = [
  {
    key: "gap-nguoi-that",
    isCore: true,
    card: {
      name: "Muốn gặp người thật",
      description: "Khách đòi gặp nhân viên, khiếu nại, hoặc việc tiền bạc — bàn giao ngay, không bán tiếp.",
      triggers: ["doi_gap_nguoi", "hoi_coc_thanh_toan"],
      conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "any" },
      requiredSlots: [],
      primaryAction: "chuyen_nguoi_that",
      guidance:
        "Giữ khách bằng đúng 1 câu lịch sự, xác nhận nhân viên sẽ liên hệ ngay. Không bung giá, không hỏi dồn, không tư vấn tiếp.",
      forbiddenExtra: ["ep_giu_lich", "hoi_don_nhieu_cau"],
      knowledge: [],
      closingLine: "Dạ em báo nhân viên hỗ trợ mình ngay nha 😊",
      exitConditions: ["nhân viên tiếp quản hội thoại", "khách đổi ý quay lại hỏi dịch vụ"],
      nextScenarios: [],
    },
  },
  {
    key: "xin-giam-gia",
    isCore: true,
    card: {
      name: "Khách xin giảm giá",
      description: "Khách đòi bớt/giảm — Lulu không có quyền deal giá, hẹn hỏi quản lý.",
      triggers: ["che_gia_xin_giam"],
      conditions: { serviceIntent: "any", dateStatus: "any", quoted: "yes", firstContact: "any" },
      requiredSlots: [],
      primaryAction: "xu_ly_ban_khoan",
      guidance:
        "Đồng cảm trước, nói khéo rằng mức giảm do quản lý quyết, hẹn hỏi giúp và báo lại. Tuyệt đối không tự đưa mức giảm hay ưu đãi riêng.",
      forbiddenExtra: ["ep_giu_lich"],
      knowledge: ["diem_manh"],
      closingLine: "Khoản này em xin phép hỏi quản lý rồi báo lại mình cho chính xác nha.",
      exitConditions: ["khách đồng ý chờ", "khách chốt gói theo giá niêm yết", "khách rời đi"],
      nextScenarios: [
        { whenVn: "khách chốt gói", scenarioKey: "chon-duoc-goi" },
        { whenVn: "khách cần người quyết giá", scenarioKey: "gap-nguoi-that" },
      ],
    },
  },
  {
    key: "giu-lich-coc",
    isCore: true,
    card: {
      name: "Muốn giữ lịch hoặc cọc",
      description: "Khách muốn giữ lịch / hỏi cọc / cho SĐT — khép kín ngày + SĐT rồi bàn giao người thật.",
      triggers: ["muon_giu_lich", "cho_sdt"],
      conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "any" },
      requiredSlots: [],
      primaryAction: "theo_he_thong",
      guidance:
        "Xin ngày (nếu chưa có) và tên + số điện thoại, sau đó hẹn nhân viên liên hệ xác nhận lịch và hướng dẫn giữ chỗ. Không tự xác nhận cọc, không báo số tài khoản, không hứa chắc còn lịch.",
      forbiddenExtra: [],
      knowledge: ["dat_lich"],
      closingLine: "Mình để lại tên và số điện thoại, nhân viên bên em xác nhận lịch và hướng dẫn giữ chỗ cho mình nha.",
      exitConditions: ["đủ ngày + SĐT → bàn giao nhân viên", "khách đổi ý"],
      nextScenarios: [{ whenVn: "đủ thông tin", scenarioKey: "gap-nguoi-that" }],
    },
  },
  {
    key: "chon-duoc-goi",
    isCore: false,
    card: {
      name: "Khách chọn được gói",
      description: "Khách chốt 'lấy gói này' — xác nhận lựa chọn rồi dẫn sang giữ lịch.",
      triggers: ["chot_goi"],
      conditions: { serviceIntent: "known", dateStatus: "any", quoted: "any", firstContact: "any" },
      requiredSlots: ["service_intent"],
      primaryAction: "theo_he_thong",
      guidance:
        "Chúc mừng lựa chọn của khách thật tự nhiên, xác nhận đúng tên gói khách chọn, rồi dẫn nhẹ sang bước giữ lịch (ngày + tên + SĐT). Không tự xác nhận đã đặt thành công.",
      forbiddenExtra: [],
      knowledge: ["dat_lich", "chi_tiet_goi"],
      closingLine: "Dạ để em giữ thông tin và nhờ nhân viên xác nhận lịch cho mình nha.",
      exitConditions: ["khách cho ngày/SĐT", "khách đổi ý xem thêm"],
      nextScenarios: [{ whenVn: "khách sẵn sàng giữ lịch", scenarioKey: "giu-lich-coc" }],
    },
  },
  {
    key: "che-gia-cao",
    isCore: false,
    card: {
      name: "Khách nói giá cao",
      description: "Khách chê mắc / so sánh chỗ khác — giữ khách bằng giá trị, không tự giảm.",
      triggers: ["che_gia_xin_giam"],
      conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "any" },
      requiredSlots: [],
      primaryAction: "xu_ly_ban_khoan",
      guidance:
        "Đồng cảm với khách trước, sau đó nêu giá trị thật: ekip trang điểm + chụp + chỉnh sửa kỹ, quà tặng kèm, ảnh giao đúng hẹn. Có thể gửi thêm ảnh thật làm bằng chứng. Không nói xấu bên khác.",
      forbiddenExtra: ["noi_xau_ben_khac", "ep_giu_lich"],
      knowledge: ["diem_manh", "anh_mau"],
      closingLine: "Nếu mình cần, em nhờ quản lý xem có chương trình phù hợp giúp mình nha.",
      exitConditions: ["khách dịu lại quan tâm tiếp", "khách xin giảm cụ thể", "khách rời đi"],
      nextScenarios: [
        { whenVn: "khách xin giảm cụ thể", scenarioKey: "xin-giam-gia" },
        { whenVn: "khách ưng trở lại", scenarioKey: "chon-duoc-goi" },
      ],
    },
  },
  {
    key: "hoi-gia-chua-ngay",
    isCore: false,
    card: {
      name: "Hỏi giá nhưng chưa biết ngày",
      description: "Khách hỏi giá, đã rõ nhóm, nhưng nói chưa biết / chưa chốt ngày — báo giá tham khảo, tuyệt đối không hỏi lại ngày.",
      triggers: ["hoi_gia", "xin_bang_gia"],
      conditions: { serviceIntent: "known", dateStatus: "not_decided", quoted: "any", firstContact: "any" },
      requiredSlots: ["service_intent"],
      primaryAction: "bao_gia_tham_khao",
      guidance:
        "Báo giá tham khảo đúng nhóm dịch vụ, nói ngắn gọn rõ ràng, có thể gợi ý xem ảnh mẫu phù hợp. Nhấn mạnh rằng khi có ngày cụ thể sẽ kiểm tra lịch và xác nhận lại. Không được nói 'không thể báo giá vì chưa có ngày'.",
      forbiddenExtra: ["hoi_lai_ngay", "ep_giu_lich"],
      knowledge: ["bang_gia", "anh_mau", "chi_tiet_goi"],
      closingLine: "Khi nào mình có ngày cụ thể, em kiểm tra lịch và xác nhận lại cho mình nha.",
      exitConditions: ["khách cung cấp ngày", "khách chọn gói", "khách ngừng phản hồi"],
      nextScenarios: [
        { whenVn: "khách cung cấp ngày", scenarioKey: "hoi-gia-co-ngay" },
        { whenVn: "khách chọn gói", scenarioKey: "chon-duoc-goi" },
        { whenVn: "khách phân vân", scenarioKey: "phan-van" },
        { whenVn: "khách xin giảm", scenarioKey: "xin-giam-gia" },
      ],
    },
  },
  {
    key: "hoi-gia-co-ngay",
    isCore: false,
    card: {
      name: "Hỏi giá và đã có ngày",
      description: "Khách hỏi giá, đã rõ nhóm và đã cho mốc ngày — báo giá chính thức, không hỏi lại ngày.",
      triggers: ["hoi_gia", "xin_bang_gia"],
      conditions: { serviceIntent: "known", dateStatus: "known", quoted: "any", firstContact: "any" },
      requiredSlots: ["service_intent", "event_date"],
      primaryAction: "bao_gia_chinh_thuc",
      guidance:
        "Báo giá đúng nhóm, dùng đúng mốc ngày khách đã nói khi nhắc tới lịch. Mời chốt nhẹ nhàng, không dồn ép. Không hứa chắc còn lịch ngày đó — nói sẽ kiểm tra lịch giúp.",
      forbiddenExtra: [],
      knowledge: ["bang_gia", "dat_lich"],
      closingLine: "Ngày này em xem lịch giúp mình, mình thấy gói nào hợp em tư vấn kỹ thêm nha.",
      exitConditions: ["khách chọn gói", "khách chê giá", "khách phân vân"],
      nextScenarios: [
        { whenVn: "khách chọn gói / muốn cọc", scenarioKey: "giu-lich-coc" },
        { whenVn: "khách chê giá", scenarioKey: "che-gia-cao" },
      ],
    },
  },
  {
    key: "xem-anh-mau",
    isCore: false,
    card: {
      name: "Xin xem ảnh mẫu hoặc concept",
      description: "Khách muốn xem ảnh/mẫu/album — gửi 1–2 ảnh đúng nhóm rồi hỏi gu.",
      triggers: ["xin_xem_mau"],
      conditions: { serviceIntent: "known", dateStatus: "any", quoted: "any", firstContact: "any" },
      requiredSlots: ["service_intent"],
      primaryAction: "gui_anh_mau",
      guidance:
        "Gửi 1–2 ảnh mẫu đúng nhóm dịch vụ và đúng giới tính khách cần, lời ngắn gọn tự nhiên, rồi hỏi khách thích tone nào để lọc thêm. Không gửi nhầm nhóm (beauty ≠ cưới), không gửi lại ảnh đã gửi.",
      forbiddenExtra: ["spam_anh"],
      knowledge: ["anh_mau"],
      closingLine: "Mình thích tone nào hơn để em lọc thêm cho hợp gu nha?",
      exitConditions: ["khách chọn được gu", "khách hỏi giá", "khách muốn concept lạ"],
      nextScenarios: [
        { whenVn: "khách hỏi giá", scenarioKey: "hoi-gia-chua-ngay" },
        { whenVn: "khách ưng, muốn chốt", scenarioKey: "chon-duoc-goi" },
      ],
    },
  },
  {
    key: "hoi-chi-tiet-goi",
    isCore: false,
    card: {
      name: "Hỏi gói gồm những gì",
      description: "Khách hỏi thành phần gói ('gồm gì', 'bao nhiêu ảnh', 'có váy không') — trả lời đúng dữ liệu, không bịa.",
      triggers: ["hoi_chi_tiet_goi"],
      conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "any" },
      requiredSlots: [],
      primaryAction: "tra_loi_cau_hoi",
      guidance:
        "Liệt kê đúng thành phần gói từ dữ liệu, gọn gàng dễ đọc. Thiếu thông tin thì nói sẽ kiểm tra lại, tuyệt đối không bịa thành phần hay số lượng.",
      forbiddenExtra: [],
      knowledge: ["chi_tiet_goi", "bang_gia"],
      closingLine: "Mình cần em gửi bảng giá chi tiết gói nào để mình so nha?",
      exitConditions: ["khách hỏi giá", "khách ưng gói"],
      nextScenarios: [
        { whenVn: "khách hỏi giá", scenarioKey: "hoi-gia-chua-ngay" },
        { whenVn: "khách ưng gói", scenarioKey: "chon-duoc-goi" },
      ],
    },
  },
  {
    key: "dia-chi-gio-lam",
    isCore: false,
    card: {
      name: "Hỏi địa chỉ / giờ làm",
      description: "Khách hỏi studio ở đâu, mấy giờ mở cửa — trả lời đúng thông tin, ngắn gọn.",
      triggers: ["hoi_dia_chi_gio"],
      conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "any" },
      requiredSlots: [],
      primaryAction: "tra_loi_cau_hoi",
      guidance:
        "Trả lời đúng địa chỉ và giờ làm từ dữ liệu studio. Nếu chưa có thông tin trong dữ liệu thì nói nhân viên sẽ nhắn lại ngay, không đoán bừa.",
      forbiddenExtra: [],
      knowledge: ["dia_chi_gio"],
      closingLine: "Mình ghé chơi xem đồ trước cũng được nha, em hỗ trợ mình liền ạ.",
      exitConditions: ["đã trả lời xong", "khách hỏi tiếp dịch vụ"],
      nextScenarios: [{ whenVn: "khách hỏi tiếp dịch vụ", scenarioKey: "chua-ro-dich-vu" }],
    },
  },
  {
    key: "phan-van",
    isCore: false,
    card: {
      name: "Khách đang phân vân",
      description: "Sau báo giá khách lưỡng lự ('để em xem lại', im lặng) — đáp nhẹ, không dồn ép.",
      triggers: ["tin_cut", "bat_ky"],
      conditions: { serviceIntent: "any", dateStatus: "any", quoted: "yes", firstContact: "no" },
      requiredSlots: [],
      primaryAction: "theo_he_thong",
      guidance:
        "Đáp nhẹ nhàng thoải mái, cho khách không gian cân nhắc. Có thể gửi thêm 1 bằng chứng đẹp (ảnh thật) nếu hợp ngữ cảnh. Không hỏi dồn, không ép chốt, không gửi lại bảng giá dài.",
      forbiddenExtra: ["hoi_don_nhieu_cau", "ep_giu_lich", "gui_lai_bang_gia"],
      knowledge: ["anh_mau"],
      closingLine: "Mình cứ xem thoải mái nha, cần gì em hỗ trợ liền ạ.",
      exitConditions: ["khách quay lại quan tâm", "khách chê giá", "khách rời đi"],
      nextScenarios: [
        { whenVn: "khách quay lại chọn gói", scenarioKey: "chon-duoc-goi" },
        { whenVn: "khách chê giá", scenarioKey: "che-gia-cao" },
      ],
    },
  },
  {
    key: "chao-hoi-moi",
    isCore: false,
    card: {
      name: "Khách mới chào hỏi",
      description: "Khách nhắn lần đầu hoặc chỉ chào — chào lại tự nhiên, mở chuyện nhu cầu.",
      triggers: ["chao_hoi"],
      conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "yes" },
      requiredSlots: [],
      primaryAction: "chao_hoi",
      guidance:
        "Chào lại tự nhiên, xưng em (Hoa) bên Amazing Studio, hỏi khách đang quan tâm dịch vụ nào. Mỗi câu một dòng, thân thiện, không quảng cáo lố. Không báo giá, không xin SĐT, không hỏi ngày ở tin đầu.",
      forbiddenExtra: ["hoi_sdt_som", "hoi_lai_ngay"],
      knowledge: ["danh_muc_dich_vu"],
      closingLine: "Mình đang tính chụp dịp gì để em tư vấn đúng cho mình nha?",
      exitConditions: ["khách nói rõ nhu cầu"],
      nextScenarios: [{ whenVn: "khách nói rõ dịch vụ", scenarioKey: "chua-ro-dich-vu" }],
    },
  },
  {
    key: "chua-ro-dich-vu",
    isCore: false,
    card: {
      name: "Chưa rõ dịch vụ",
      description: "Khách nói chung chung, chưa rõ cưới/beauty/gia đình — hỏi đúng 1 câu khoanh nhu cầu.",
      // firstContact=no: tin ĐẦU TIÊN luôn do thẻ "Khách mới chào hỏi" / hệ thống chào trước
      // (đúng hành vi engine), thẻ này lo các lượt SAU khi vẫn chưa rõ nhóm.
      triggers: ["bat_ky"],
      conditions: { serviceIntent: "unknown", dateStatus: "any", quoted: "any", firstContact: "no" },
      requiredSlots: [],
      primaryAction: "hoi_nhu_cau",
      guidance:
        "Hỏi đúng 1 câu để khoanh nhu cầu, gợi ý vài lựa chọn ngay trong câu (cưới, beauty, gia đình, thuê đồ). Chưa biết nhóm thì không báo giá, không gửi ảnh, không gửi bảng giá.",
      forbiddenExtra: ["hoi_don_nhieu_cau"],
      knowledge: ["danh_muc_dich_vu"],
      closingLine: "Bên em có chụp cưới, beauty, gia đình… mình đang cần dạng nào ạ?",
      exitConditions: ["khách nói rõ nhóm dịch vụ"],
      nextScenarios: [
        { whenVn: "khách muốn xem mẫu", scenarioKey: "xem-anh-mau" },
        { whenVn: "khách hỏi giá", scenarioKey: "hoi-gia-chua-ngay" },
      ],
    },
  },
];
