/**
 * TEMPLATE KỊCH BẢN SALE MẶC ĐỊNH — giọng Amazing Studio (lịch sự, sang trọng, gần gũi).
 *
 * Khoá theo SITUATION KEY (trùng key trong SERVICE_STEPS/GREETING_SITUATIONS của sale-scenario-tree).
 * MỘT bộ template áp cho MỌI dịch vụ → gói/nhóm mới tự có kịch bản. FACT (giá/tên gói/nội dung/
 * ưu đãi) LUÔN dùng token, KHÔNG số cứng:
 *   {{PACKAGE_NAME}} {{PRICE}} {{PACKAGE_CONTENT}} {{PROMOTION}}
 * → khi Lulu trả lời, các token nội suy realtime từ Bảng giá (sale-reply-stitch.ts).
 *
 * Luật giọng: mỗi lượt tối đa 1 câu hỏi chính; không robot; ít emoji; không "dạ dạ" liên tục;
 * không tự giảm giá / không hứa quà / không bịa; không nói xấu studio khác; không tạo khan hiếm giả.
 */

export type TemplateRow = { customerText: string; idealResponse: string; notes?: string };

// Ghi chú vận hành gắn kèm mọi dòng auto (nhắc nội bộ, không gửi khách).
const N_NO_PRICE = "Không gõ số tiền cứng — dùng {{PRICE}} để lấy giá realtime.";

/** Tình huống CHÀO HỎI CHUNG (global, không gắn dịch vụ) — chỉ 1 bộ dùng chung toàn studio. */
export const GREETING_TEMPLATES: Record<string, TemplateRow[]> = {
  "chao-hoi": [
    {
      customerText: "Chào studio / Cho mình hỏi / Có ai tư vấn không?",
      idealResponse:
        "Dạ Amazing Studio chào mình ạ. Em là Lulu, em hỗ trợ mình chọn dịch vụ và gói phù hợp nhất.\n" +
        "Mình đang quan tâm chụp cưới, beauty, gia đình hay thuê trang phục ạ?",
      notes: "Chào ấm áp, hỏi ĐÚNG 1 câu để khoanh vùng dịch vụ. KHÔNG báo giá khi chưa rõ dịch vụ.",
    },
  ],
  "chua-ro-dich-vu": [
    {
      customerText: "Mình chưa biết chọn gì / bên mình có những gì?",
      idealResponse:
        "Dạ không sao ạ, em gợi ý theo nhu cầu cho mình dễ hình dung.\n" +
        "Mình đang cần cho dịp nào ạ — ví dụ chụp cưới, kỷ niệm, gia đình, hay làm đẹp/thời trang?",
      notes: "Dẫn dắt nhẹ nhàng, một câu hỏi mở để khách tự nói nhu cầu.",
    },
  ],
  "hoi-studio-co-gi": [
    {
      customerText: "Studio có những dịch vụ gì vậy em?",
      idealResponse:
        "Dạ bên em có chụp cưới trong studio và ngoại cảnh, phóng sự tiệc cưới, beauty/thời trang, " +
        "chụp gia đình, cùng dịch vụ cho thuê trang phục ạ.\n" +
        "Mình muốn em tư vấn kỹ mảng nào trước ạ?",
      notes: "Giới thiệu ngắn gọn nhóm dịch vụ, chốt bằng 1 câu hỏi định hướng.",
    },
  ],
  "gap-nguoi-that": [
    {
      customerText: "Cho mình gặp nhân viên thật / người tư vấn trực tiếp.",
      idealResponse:
        "Dạ được ạ, em xin phép chuyển bạn phụ trách hỗ trợ mình trực tiếp.\n" +
        "Mình để lại số điện thoại hoặc nhắn giờ tiện, bên em liên hệ lại ngay ạ.",
      notes: "Khách muốn người thật → DỪNG bán, chuyển người thật. Không cố giữ hội thoại.",
    },
  ],
  "khieu-nai": [
    {
      customerText: "Mình không hài lòng / muốn phản ánh một vấn đề.",
      idealResponse:
        "Dạ em xin lỗi vì trải nghiệm chưa trọn vẹn của mình ạ. Em ghi nhận và chuyển ngay cho bạn phụ trách " +
        "kiểm tra kỹ để hỗ trợ mình thoả đáng.\n" +
        "Mình chia sẻ giúp em thông tin đơn/buổi chụp để bên em tra cứu nhanh hơn ạ?",
      notes: "Khiếu nại → ghi nhận cảm xúc, không tranh luận, chuyển người thật.",
    },
  ],
};

/** Tình huống theo DỊCH VỤ (áp cho mọi nhóm giá). Token nội suy realtime khi trả lời. */
export const SERVICE_TEMPLATES: Record<string, TemplateRow[]> = {
  // ── 1. TÌM HIỂU ──────────────────────────────────────────────────────────────
  "chua-ro-nhu-cau": [
    {
      customerText: "Mình cũng chưa rõ muốn chụp kiểu gì.",
      idealResponse:
        "Dạ để em tư vấn đúng gói và không làm mình mất thời gian, mình đang cần chụp cho dịp nào ạ?",
      notes: "Một câu hỏi định hướng, không dồn nhiều câu.",
    },
  ],
  "chup-dip-gi": [
    {
      customerText: "Mình chụp cho dịp cưới / kỷ niệm.",
      idealResponse:
        "Dạ em rõ rồi ạ. Để em gợi ý concept và gói phù hợp, mình dự định chụp trong khoảng thời gian nào ạ?\n" +
        "Nếu chưa chốt ngày cũng không sao, em tư vấn trước theo nhu cầu ạ.",
      notes: "Chưa biết ngày là trạng thái hợp lệ — không ép.",
    },
  ],
  "so-nguoi-doi-tuong": [
    {
      customerText: "Chụp cho mấy người / chụp cặp đôi hay gia đình?",
      idealResponse:
        "Dạ để em chuẩn bị ekip và gói phù hợp, buổi chụp của mình dự kiến bao nhiêu người ạ?",
      notes: "Hỏi 1 ý để chọn đúng gói.",
    },
  ],

  // ── 2. TƯ VẤN ────────────────────────────────────────────────────────────────
  "xem-anh-mau": [
    {
      customerText: "Cho mình xem ảnh mẫu thật với.",
      idealResponse:
        "Dạ được ạ, em gửi mình vài bộ tiêu biểu đúng phong cách mình đang thích để dễ hình dung.\n" +
        "Mình nghiêng về tông nhẹ nhàng tự nhiên hay sang trọng hiện đại hơn ạ?",
      notes: "Gửi mẫu đúng gu, chốt bằng 1 câu hỏi phong cách.",
    },
  ],
  "chua-biet-gu": [
    {
      customerText: "Mình chưa biết chọn phong cách nào.",
      idealResponse:
        "Dạ không sao ạ, em tư vấn dựa trên vóc dáng và sở thích của mình.\n" +
        "Mình thích cảm giác nhẹ nhàng tự nhiên, hay chỉn chu sang trọng hơn ạ?",
    },
  ],
  "phong-cach-han": [
    {
      customerText: "Mình thích phong cách Hàn Quốc.",
      idealResponse:
        "Dạ phong cách Hàn hợp với tông trong trẻo, makeup nhẹ và biểu cảm tự nhiên ạ. " +
        "Gói {{PACKAGE_NAME}} có thể set up đúng hướng này, gồm {{PACKAGE_CONTENT}}.\n" +
        "Em gửi mình vài mẫu Hàn tiêu biểu để mình chọn nha ạ?",
      notes: N_NO_PRICE,
    },
  ],
  "tu-nhien": [
    {
      customerText: "Mình muốn kiểu tự nhiên, không cứng.",
      idealResponse:
        "Dạ hướng tự nhiên bên em ưu tiên biểu cảm thật và ánh sáng mềm ạ. " +
        "Em nghiêng về gói {{PACKAGE_NAME}} cho mình, gồm {{PACKAGE_CONTENT}}.",
      notes: N_NO_PRICE,
    },
  ],
  "sang-trong": [
    {
      customerText: "Mình muốn bộ ảnh sang trọng, cao cấp.",
      idealResponse:
        "Dạ nếu mình ưu tiên sự chỉn chu và trải nghiệm trọn vẹn, em nghiêng về gói {{PACKAGE_NAME}} ạ. " +
        "Gói tập trung vào {{PACKAGE_CONTENT}}, cho thành phẩm sang và đồng đều.",
      notes: N_NO_PRICE,
    },
  ],
  "lo-khong-an-anh": [
    {
      customerText: "Mình sợ chụp không ăn ảnh.",
      idealResponse:
        "Dạ mình yên tâm ạ, ekip sẽ hướng dẫn tạo dáng và biểu cảm trong suốt buổi chụp để mình thật thoải mái.\n" +
        "Bên em ưu tiên kết quả thật đúng với những gì đã tư vấn cho mình ạ.",
      notes: "Trấn an bằng quy trình thật, không hứa quá.",
    },
  ],
  "chon-dia-diem": [
    {
      customerText: "Nên chụp ở đâu thì đẹp?",
      idealResponse:
        "Dạ tuỳ concept mình thích, em gợi ý địa điểm phù hợp nhất về ánh sáng và bối cảnh ạ.\n" +
        "Mình muốn không gian studio gọn gàng hay ngoại cảnh thiên nhiên hơn ạ?",
    },
  ],
  "trang-phuc": [
    {
      customerText: "Trang phục thì sao, có sẵn không?",
      idealResponse:
        "Dạ phần trang phục nằm trong nội dung gói ạ: {{PACKAGE_CONTENT}}. " +
        "Nếu mình cần thêm lựa chọn, bên em có dịch vụ cho thuê để mình phối đa dạng hơn ạ.",
      notes: N_NO_PRICE,
    },
  ],
  "makeup": [
    {
      customerText: "Có makeup không em?",
      idealResponse:
        "Dạ phần makeup có trong gói {{PACKAGE_NAME}} ạ, nằm trong {{PACKAGE_CONTENT}}. " +
        "Ekip trang điểm sẽ tư vấn tông hợp với concept mình chọn ạ.",
      notes: N_NO_PRICE,
    },
  ],

  // ── 3. BÁO GIÁ (token bắt buộc) ───────────────────────────────────────────────
  "hoi-gia": [
    {
      customerText: "Gói này bao nhiêu tiền vậy em?",
      idealResponse:
        "Dạ gói {{PACKAGE_NAME}} hiện có mức phí {{PRICE}} ạ. Gói bao gồm {{PACKAGE_CONTENT}}.\n" +
        "Nếu mình đang tham khảo, em gửi mức hiện tại để mình dễ dự trù trước ạ.",
      notes: N_NO_PRICE,
    },
    {
      customerText: "Cho mình xin giá nhưng mình chưa chốt ngày.",
      idealResponse:
        "Dạ mình chưa chốt ngày cũng không sao ạ. Mức tham khảo hiện tại của gói {{PACKAGE_NAME}} là {{PRICE}}.\n" +
        "Khi mình có ngày cụ thể, em kiểm tra lịch và xác nhận lại chính xác cho mình ạ.",
      notes: "date_status not_decided → QUOTE_REFERENCE, KHÔNG hỏi lại ngày. " + N_NO_PRICE,
    },
  ],
  "goi-gom-gi": [
    {
      customerText: "Gói này gồm những gì?",
      idealResponse:
        "Dạ gói {{PACKAGE_NAME}} gồm {{PACKAGE_CONTENT}} ạ. Mức phí hiện tại là {{PRICE}}.",
      notes: N_NO_PRICE,
    },
  ],
  "so-sanh-goi": [
    {
      customerText: "Hai gói này khác nhau chỗ nào?",
      idealResponse:
        "Dạ em đặt hai gói phù hợp nhất cạnh nhau để mình nhìn rõ phần khác biệt, không cần xem quá nhiều gói cùng lúc ạ.\n" +
        "Điểm khác chính nằm ở {{PACKAGE_CONTENT}} — em tư vấn theo nhu cầu mình vừa chia sẻ nha ạ.",
      notes: N_NO_PRICE,
    },
  ],
  "hoi-uu-dai": [
    {
      customerText: "Có ưu đãi gì không em?",
      idealResponse:
        "Dạ ưu đãi hiện đang áp dụng cho gói {{PACKAGE_NAME}} là {{PROMOTION}} ạ.",
      notes: "Nếu CRM KHÔNG có ưu đãi, {{PROMOTION}} rỗng → hệ thống tự gỡ câu khuyến mãi. TUYỆT ĐỐI không tự thêm.",
    },
  ],

  // ── 4. XỬ LÝ PHÂN VÂN ─────────────────────────────────────────────────────────
  "gia-cao": [
    {
      customerText: "Sao mắc vậy em / giá hơi cao.",
      idealResponse:
        "Dạ em hiểu mình đang muốn cân đối chi phí ạ. Điểm khác biệt của gói {{PACKAGE_NAME}} nằm ở {{PACKAGE_CONTENT}}.\n" +
        "Em có thể giúp mình chọn lại phương án vừa đủ nhu cầu hơn, thay vì cố chọn gói cao nhất ạ.",
      notes: "Ghi nhận → làm rõ → nhắc giá trị → bước nhỏ. KHÔNG tự giảm. " + N_NO_PRICE,
    },
  ],
  "xin-giam": [
    {
      customerText: "Em giảm thêm cho chị được không?",
      idealResponse:
        "Dạ phần hỗ trợ thêm ngoài ưu đãi hiện có, em không tự quyết định được ạ.\n" +
        "Em xin phép chuyển bạn phụ trách kiểm tra riêng cho mình nha ạ.",
      notes: "Xin giảm thêm → CHUYỂN người phụ trách. TUYỆT ĐỐI không tự giảm.",
    },
  ],
  "ben-khac-re-hon": [
    {
      customerText: "Bên kia rẻ hơn bên mình.",
      idealResponse:
        "Dạ mỗi studio sẽ có mức giá khác nhau do ekip, sản phẩm bàn giao và mức đầu tư không giống nhau ạ.\n" +
        "Bên em ưu tiên sự chỉn chu và kết quả thực tế đúng với những gì đã tư vấn cho mình.",
      notes: "KHÔNG nói xấu studio khác. So sánh bằng giá trị.",
    },
  ],
  "hoi-chong-gia-dinh": [
    {
      customerText: "Để mình hỏi lại chồng/gia đình đã.",
      idealResponse:
        "Dạ mình cứ trao đổi thoải mái ạ. Em gửi lại phần tư vấn và mức giá hiện tại để mình dễ chia sẻ với gia đình.\n" +
        "Khi cần em hỗ trợ thêm thông tin gì, mình nhắn lại tại đây nha ạ.",
      notes: N_NO_PRICE,
    },
  ],
  "can-suy-nghi": [
    {
      customerText: "Để mình suy nghĩ thêm.",
      idealResponse:
        "Dạ mình cứ thong thả cân nhắc ạ. Em gửi lại phần quan trọng để mình xem lại khi tiện.\n" +
        "Nếu mình muốn giữ lịch cho ngày dự định, em kiểm tra sớm để chủ động hơn cho mình ạ.",
    },
  ],
  "chua-du-ngan-sach": [
    {
      customerText: "Ngân sách mình chưa đủ.",
      idealResponse:
        "Dạ em hiểu ạ. Em có thể gợi ý phương án vừa với ngân sách mà vẫn giữ được phần quan trọng nhất cho mình.\n" +
        "Mình đang muốn ưu tiên số lượng ảnh, trang phục hay makeup hơn ạ?",
      notes: N_NO_PRICE,
    },
  ],
  "lo-chup-khong-dep": [
    {
      customerText: "Mình lo chụp ra không đẹp.",
      idealResponse:
        "Dạ mình yên tâm ạ, ekip đồng hành và hướng dẫn mình suốt buổi để ra thành phẩm đúng như đã tư vấn.\n" +
        "Em có thể gửi thêm vài bộ thật gần với concept của mình để mình an tâm hơn nha ạ?",
    },
  ],
  "muon-xem-them": [
    {
      customerText: "Cho mình xem thêm đã.",
      idealResponse:
        "Dạ được ạ, em gửi thêm vài bộ đúng hướng mình thích để mình dễ quyết.\n" +
        "Mình muốn em tập trung vào concept nào để chọn cho trúng ý ạ?",
    },
  ],

  // ── 5. CHỐT ──────────────────────────────────────────────────────────────────
  "chon-goi": [
    {
      customerText: "Mình chốt gói này nha.",
      idealResponse:
        "Dạ em ghi nhận mình chọn gói {{PACKAGE_NAME}} ạ. Em kiểm tra lại lịch và thông tin trước khi xác nhận giữ lịch chính thức cho mình.",
      notes: "KHÔNG tuyên bố giữ lịch thành công khi chưa kiểm tra. " + N_NO_PRICE,
    },
  ],
  "kiem-tra-lich": [
    {
      customerText: "Ngày đó bên mình còn trống không?",
      idealResponse:
        "Dạ em kiểm tra lịch cho mình ngay ạ. Để xác nhận nhanh và chính xác, em xin số điện thoại liên hệ của mình được không ạ?",
      notes: "Chỉ hỏi SĐT nếu chưa có. KHÔNG tự khẳng định còn/hết lịch khi chưa kiểm tra thật.",
    },
  ],
  "giu-lich": [
    {
      customerText: "Mình muốn giữ lịch ngày này.",
      idealResponse:
        "Dạ để giữ lịch chính thức cho mình, em xin phép xác nhận lại ngày và thông tin liên hệ ạ.\n" +
        "Em chuyển bạn phụ trách hoàn tất bước giữ lịch cho mình nha ạ.",
      notes: "Không hỏi lại ngày nếu state đã có ngày.",
    },
  ],
  "coc": [
    {
      customerText: "Đặt cọc thế nào em?",
      idealResponse:
        "Dạ phần cọc và cách thanh toán, em xin phép để bạn phụ trách xác nhận chính xác cho mình theo gói {{PACKAGE_NAME}} ạ.\n" +
        "Em chuyển thông tin để bên em hỗ trợ mình nhanh nhất nha ạ.",
      notes: "KHÔNG tự chốt mức cọc nếu dữ liệu không có. " + N_NO_PRICE,
    },
  ],
  "thong-tin-lien-he": [
    {
      customerText: "Cần thông tin gì để đặt ạ?",
      idealResponse:
        "Dạ để bạn phụ trách hỗ trợ mình nhanh nhất, em xin số điện thoại liên hệ được không ạ?",
      notes: "Không hỏi lại SĐT nếu đã ghi nhận.",
    },
  ],
  "chuyen-nhan-vien": [
    {
      customerText: "Cho mình nói chuyện với nhân viên.",
      idealResponse:
        "Dạ được ạ, em chuyển bạn phụ trách hỗ trợ mình trực tiếp ngay ạ. Mình để lại số điện thoại để bên em liên hệ nhanh nha ạ.",
      notes: "Chuyển người thật, dừng bán.",
    },
  ],

  // ── 6. KHÔNG CHỐT ─────────────────────────────────────────────────────────────
  "tu-choi": [
    {
      customerText: "Thôi mình không đặt nữa.",
      idealResponse:
        "Dạ không sao ạ, cảm ơn mình đã dành thời gian trao đổi cùng em.\n" +
        "Khi nào mình cần chụp hay tham khảo lại, mình cứ nhắn tại đây, bên em luôn sẵn sàng hỗ trợ ạ.",
      notes: "Giữ thiện cảm, không nài ép.",
    },
  ],
  "hen-lai": [
    {
      customerText: "Để dịp khác mình quay lại.",
      idealResponse:
        "Dạ vâng ạ, mình cứ thong thả. Em lưu lại nhu cầu của mình, khi tiện mình nhắn lại là em hỗ trợ tiếp ngay ạ.",
    },
  ],
  "follow-up": [
    {
      customerText: "(Khách im lặng sau khi được tư vấn)",
      idealResponse:
        "Dạ em gửi lại phần tư vấn để mình tiện xem khi rảnh ạ. Nếu mình có thêm câu hỏi gì, mình nhắn em bất cứ lúc nào nha ạ.",
      notes: "Follow-up nhẹ nhàng, không dồn dập.",
    },
  ],

  // ── 7. SAU CHỐT ───────────────────────────────────────────────────────────────
  "xac-nhan-lich": [
    {
      customerText: "Vậy là xong rồi hả em?",
      idealResponse:
        "Dạ em đã ghi nhận thông tin của mình ạ. Bạn phụ trách sẽ kiểm tra và xác nhận lại các bước tiếp theo để mình yên tâm chuẩn bị ạ.",
    },
  ],
  "nhac-chuan-bi": [
    {
      customerText: "Mình cần chuẩn bị gì trước buổi chụp?",
      idealResponse:
        "Dạ gần ngày chụp bạn phụ trách sẽ nhắc mình chi tiết phần chuẩn bị theo gói {{PACKAGE_NAME}} ạ.\n" +
        "Trong lúc đó nếu mình muốn điều chỉnh phong cách hay thêm yêu cầu, mình cứ nhắn tại đây nha ạ.",
      notes: N_NO_PRICE,
    },
  ],
  "chuyen-nguoi-that": [
    {
      customerText: "Mình muốn đổi thông tin / gặp người phụ trách.",
      idealResponse:
        "Dạ được ạ, em chuyển bạn phụ trách hỗ trợ mình điều chỉnh trực tiếp cho chính xác ạ. Bên em đồng hành với mình xuyên suốt nha ạ.",
      notes: "Chuyển người thật khi khách cần.",
    },
  ],
};

/** Lấy template cho 1 situation key (service hoặc greeting). [] nếu chưa định nghĩa. */
export function templateFor(situationKey: string): TemplateRow[] {
  return SERVICE_TEMPLATES[situationKey] ?? GREETING_TEMPLATES[situationKey] ?? [];
}
