# Kịch bản tư vấn Lulu (Scenario Manager) — Hướng dẫn sử dụng

> Dành cho chủ studio / admin. Trang này cho phép sửa cách Lulu xử lý TỪNG TÌNH HUỐNG khách
> bằng tiếng Việt đời thường — không cần sửa prompt, không cần sửa code.

## 1. Vào đâu?

Sidebar → nhóm **Facebook & Sale** → **Kịch bản Lulu** (`/lulu-sale-scenarios`).

Nếu thấy màn "Tính năng chưa được bật": thêm biến môi trường rồi khởi động lại server:

```
LULU_SCENARIO_MANAGER_ENABLED=1
```

Cờ này CHỈ mở trang quản lý — chưa thay đổi gì cách Lulu trả lời khách.

## 2. Thẻ kịch bản là gì?

Mỗi thẻ = một tình huống khách, gồm các ô tiếng Việt:

| Ô | Ý nghĩa |
|---|---|
| **KHI KHÁCH…** | Lúc nào thẻ này được dùng (chọn chip: hỏi giá, xem mẫu, chê giá…) + điều kiện (đã rõ nhóm dịch vụ? đã có ngày?…) |
| **LULU NÊN…** | Lời dặn cách xử lý (viết tự nhiên) + hành động chính |
| **ĐỪNG BAO GIỜ…** | Điều cấm BỔ SUNG. Các cấm có ổ khoá 🔒 là luật an toàn hệ thống — không tắt được |
| **CẦN BIẾT…** | Dữ liệu Lulu được dùng (bảng giá, ảnh mẫu…) |
| **CÂU KẾT GỢI Ý** | Câu chốt mẫu — Lulu diễn đạt lại tự nhiên, không đọc y nguyên |
| **ĐIỀU KIỆN THOÁT** | Thẻ coi như xong khi nào (để người vận hành hiểu) |
| **CHUYỂN SANG KỊCH BẢN…** | Tình huống kế tiếp (khách cho ngày → thẻ "Hỏi giá và đã có ngày"…) |

Hệ thống có sẵn **12+ thẻ mẫu** đúng logic Lulu đang chạy — sửa dần từ nền này.

## 3. Quy trình sửa an toàn (3 bước)

1. **Sửa** thẻ → bấm **Lưu bản nháp**. Bản đang chạy KHÔNG đổi.
2. **Test thử** ngay trong thẻ: gõ câu khách → thấy Lulu hiểu gì, chọn thẻ nào, vì sao,
   trả lời thử ra sao, Đạt/Cảnh báo/Bị chặn. Có bản nháp → tự so sánh **TRƯỚC / SAU**.
   Tick "Hội thoại nhiều lượt" để test cả chuỗi (mỗi dòng 1 câu khách).
3. **Áp dụng tất cả** (nút xanh trên đầu trang) → mọi bản nháp chạy thật CÙNG LÚC,
   kèm snapshot để khôi phục.

## 4. Khôi phục (rollback)

Nút **Lịch sử** → chọn snapshot → **Khôi phục**. Cả bộ kịch bản quay về đúng thời điểm đó
(khôi phục nguyên bộ, không lệch thẻ). Trước khi khôi phục hệ thống tự chụp lại bản hiện tại,
nên khôi phục nhầm vẫn quay lại được.

## 5. Nhờ AI viết kịch bản

Nút **Nhờ AI viết** → mô tả 1 câu (vd: *"Lulu cứ hỏi lại ngày dù khách đã nói chưa biết"*),
có thể dán kèm đoạn chat Lulu trả lời sai → AI đề xuất thẻ NHÁP → bạn duyệt, sửa, Test, Áp dụng.
AI không bao giờ tự áp dụng.

## 6. Bật / tắt / ưu tiên / nhân bản / lưu trữ

- **Công tắc** trên mỗi thẻ: tắt = Lulu không dùng thẻ đó nữa (quay về cách xử lý mặc định).
- **Kéo thả** thẻ để đổi ưu tiên: khi nhiều thẻ cùng khớp một tin, thẻ ĐỨNG TRÊN thắng.
- **Nhân bản**: tạo bản sao dạng nháp để thử biến thể.
- **Lưu trữ**: ẩn thẻ không dùng (KHÔNG xoá vĩnh viễn; thẻ lõi an toàn không lưu trữ được).

## 7. Luật an toàn KHÔNG SỬA ĐƯỢC (nằm trong code)

Dù thẻ viết gì, hệ thống luôn chặn: bịa giá ngoài bảng giá · tự giảm giá · bịa khuyến mãi ·
hỏi lại ngày sai luật · hỏi lặp vô ích · tự xác nhận tiền cọc · lộ ghi chú nội bộ ·
bán tiếp khi phải chuyển người thật · trôi sang dịch vụ khác · chặn đường chuyển người thật.

Thẻ vi phạm sẽ **không lưu/áp dụng được** — hệ thống giải thích bằng tiếng Việt kèm gợi ý sửa.

## 8. Các cờ (dành cho dev / deploy) — mặc định TẤT CẢ TẮT

| Cờ | Tác dụng |
|---|---|
| `LULU_SCENARIO_MANAGER_ENABLED` | Mở trang quản lý + API. Chưa đụng luồng trả lời. |
| `LULU_SCENARIO_SHADOW_ENABLED` | Resolver chạy song song trên Messenger + sân test, CHỈ ghi log `[ScenarioShadow]` — không đổi câu trả lời. |
| `LULU_SCENARIO_ENFORCE_ENABLED` | Cho phép thẻ thật sự lái câu trả lời — CHỈ với PSID trong allowlist. |
| `LULU_SCENARIO_PSIDS` | Danh sách PSID pilot (cách nhau dấu phẩy). Rỗng = enforce không chạy cho ai. |

Lộ trình bật khuyến nghị: `MANAGER` (chỉnh thẻ + test) → `SHADOW` (soi log vài ngày)
→ `ENFORCE + PSIDS` 2–3 khách test → mở rộng (quyết định riêng của chủ).
Rollback bất cứ lúc nào = xoá cờ tương ứng (không cần sửa dữ liệu).

## 9. Kiến trúc (dev)

```
Tin khách → Extractor → Thread State → [Workflow V1 = Core Guard + Router (baseline)]
         → Scenario Resolver (đọc lulu_sale_scenarios, chọn 1 thẻ, chỉ SIẾT không NỚI)
         → Knowledge → LLM viết lời → Validator (8 luật lõi) → State After → Trace
```

- Bảng: `lulu_sale_scenarios` (thẻ + nháp), `lulu_scenario_versions` (snapshot bộ),
  `lulu_scenario_test_runs` (lịch sử test) — additive, đăng ký drizzle + migrations (chống DROP-drift #132).
- Resolver fail-open: DB lỗi / không thẻ khớp → dùng nguyên Workflow V1, Messenger không bao giờ đứng.
- Golden parity: 12 thẻ seed + resolver PHẢI ra đúng quyết định như engine trên 104 golden case
  (test `sale-scenario-resolver.test.ts` khoá hợp đồng này).
