# HOW LULU WORKS — 1 trang cho chủ studio

## Lulu trả lời khách qua các TẦNG (không phải "1 cục prompt")

```
Tin khách → EXTRACTOR → STATE (trí nhớ) → ROUTER (chọn việc) → LLM (viết lời) → VALIDATOR (khám) → Gửi → cập nhật STATE
```

- **Extractor** — đọc tin khách bằng luật cứng: có ngày chụp không, "chưa biết ngày" không, cần dịch vụ gì, có SĐT không. Không dùng AI, không đoán mò.
- **State (trí nhớ)** — bảng `lulu_thread_state`: khách này đã nói gì (ngày, nhu cầu), bot đã hỏi gì, đã báo giá gói nào, đã gửi ảnh nào. Nhờ nó Lulu KHÔNG hỏi lại ngày khi khách đã bảo "chưa biết".
- **Router** — bộ luật code quyết định lượt này LÀM GÌ (hỏi ngày / báo giá tham khảo / gửi mẫu / trả lời FAQ / bàn giao người thật). Luật cứng nằm ở đây, LLM không có quyền phá.
- **LLM (prompt)** — CHỈ còn nhiệm vụ "viết lời cho hay" theo việc Router đã chọn.
- **Validator** — khám câu trả lời trước khi gửi: sai giá so catalog? tự giảm giá? hỏi lại ngày sai luật? lộ chữ nội bộ? → BLOCK, không bao giờ tới khách.

## Công tắc & tắt khẩn cấp
- **Cầu dao tổng** (màn Cài đặt Lulu → Master): tắt = bot im toàn bộ, tin khách vẫn được lưu.
- **Trí nhớ mới**: env `LULU_STATE_ENABLED` (+ `LULU_STATE_PSIDS` để chỉ bật vài khách test). Gỡ env = tắt tức thời, không cần deploy.
- **Từng khách**: nút chuyển thread sang "takeover" — bot im riêng khách đó.

## Đọc Debug Trace (sân test Claude Sale Test)
Mỗi lượt trả về khối `trace`: tin khách → slot rút được → state trước/sau → Router chọn gì + **VÌ SAO** (reason) + được/cấm hỏi gì → verdict Validator trên câu trả lời thật.

**Lulu nói ngu → nhìn trace biết ngu Ở TẦNG NÀO:**
| Triệu chứng | Tầng lỗi |
|---|---|
| Slot sai (vd "2-3 người" thành ngày) | Extractor |
| Slot đúng nhưng state trước/sau sai | State/Memory |
| State đúng nhưng action vô lý | Router |
| Action đúng nhưng lời nói sai/bịa | LLM (lúc này mới đụng prompt) |
| Lời sai mà verdict vẫn PASS | Validator (thiếu rule) |

**Cấm** quay lại "sửa prompt thử xem" khi chưa xem trace.

## 6 mức "xong" — đừng nhầm
Code xong → Test xanh (104 golden) → Brain Lab pass (anh test tay) → Pilot pass (vài khách thật) → Production pass → Business KPI pass. Hiện tại: đang ở mức 2, chờ anh nghiệm thu mức 3.
