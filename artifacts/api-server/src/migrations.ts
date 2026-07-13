import { pool } from "@workspace/db";
import { withStartupDdlLock } from "./lib/startup-ddl";

async function runMigrationsUnlocked() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Task #363: phân loại chi phí theo mô hình tài chính (direct/operating/depreciation/interest/loan_principal)
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cost_class TEXT NOT NULL DEFAULT 'operating'`);
    await client.query(`UPDATE expenses SET cost_class = 'direct' WHERE booking_id IS NOT NULL AND cost_class = 'operating'`);

    // ── Phiếu chi datetime: thêm cột expense_at (timestamp) để lưu ngày + giờ + phút.
    // Backfill từ expense_date (ngày cũ → 00:00 cùng ngày) và created_at để giữ thứ tự
    // hợp lý cho dữ liệu cũ. KHÔNG đụng tới expense_date để các thống kê hiện có
    // (dashboard / revenue) không bị ảnh hưởng.
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_at TIMESTAMP`);
    await client.query(`
      UPDATE expenses
      SET expense_at = CASE
        WHEN expense_date::date = (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          THEN created_at
        ELSE expense_date::timestamp
      END
      WHERE expense_at IS NULL
    `);

    await client.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS notes TEXT`);
    await client.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS customer_id INTEGER`);
    await client.query(`ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL`);

    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS photoshop_note text DEFAULT ''`);
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS extra_retouch_price integer DEFAULT 0`);

    // Fix: nếu DB có partial unique INDEX (không phải CONSTRAINT), xoá index đó rồi tạo CONSTRAINT chuẩn.
    // Nếu CONSTRAINT đã tồn tại → bỏ qua.
    await client.query(`
      DO $$ BEGIN
        -- Kiểm tra xem CONSTRAINT đã tồn tại chưa
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'crm_leads_facebook_user_id_unique'
            AND conrelid = 'crm_leads'::regclass
        ) THEN
          -- Xoá partial INDEX nếu có (không phải backing index của constraint)
          IF EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE tablename = 'crm_leads'
              AND indexname = 'crm_leads_facebook_user_id_unique'
          ) THEN
            DROP INDEX crm_leads_facebook_user_id_unique;
          END IF;
          -- Thêm CONSTRAINT chuẩn
          ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_facebook_user_id_unique UNIQUE (facebook_user_id);
        END IF;
      END $$
    `);

    await client.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS ai_per_thread_enabled BOOLEAN DEFAULT NULL`);
    await client.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS ai_mode TEXT DEFAULT 'active'`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS facebook_user_id TEXT`);
    await client.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS zalo TEXT`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_rank TEXT NOT NULL DEFAULT 'new'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_rank ON customers(customer_rank)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_service_scripts (
        id          serial PRIMARY KEY,
        name        text NOT NULL,
        price_content text,
        is_active   boolean DEFAULT true,
        created_at  timestamp DEFAULT now(),
        updated_at  timestamp DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_script_steps (
        id            serial PRIMARY KEY,
        script_id     integer NOT NULL REFERENCES ai_service_scripts(id) ON DELETE CASCADE,
        step          integer NOT NULL CHECK (step BETWEEN 1 AND 7),
        step_label    text,
        content       text,
        variants_json text,
        created_at    timestamp DEFAULT now(),
        updated_at    timestamp DEFAULT now(),
        UNIQUE(script_id, step)
      )
    `);

    // Backfill UNIQUE constraint for old DBs where ai_script_steps was created
    // before the UNIQUE(script_id, step) clause existed. Required for the
    // ON CONFLICT (script_id, step) seed below.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'ai_script_steps'::regclass
            AND contype = 'u'
            AND conkey = (
              SELECT array_agg(attnum ORDER BY attnum)
              FROM pg_attribute
              WHERE attrelid = 'ai_script_steps'::regclass
                AND attname IN ('script_id', 'step')
            )
        ) THEN
          ALTER TABLE ai_script_steps
            ADD CONSTRAINT ai_script_steps_script_id_step_key UNIQUE (script_id, step);
        END IF;
      END$$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_follow_up_logs (
        psid                     text PRIMARY KEY,
        last_customer_message_at timestamptz,
        follow_up_count          integer DEFAULT 0,
        last_follow_up_at        timestamptz,
        is_opted_out             boolean DEFAULT false,
        current_sale_step        integer
      )
    `);

    await client.query(`ALTER TABLE ai_follow_up_logs ADD COLUMN IF NOT EXISTS current_sale_step integer`);
    await client.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS current_script_id integer`);
    await client.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS current_sale_step  integer`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_script_qa_rows (
        id          serial PRIMARY KEY,
        script_id   integer NOT NULL REFERENCES ai_service_scripts(id) ON DELETE CASCADE,
        step        integer NOT NULL CHECK (step BETWEEN 1 AND 7),
        question    TEXT,
        answer      TEXT,
        sort_order  integer DEFAULT 0
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_script_qa_rows_script_id
      ON ai_script_qa_rows(script_id)
    `);

    await client.query(`ALTER TABLE ai_service_scripts ADD COLUMN IF NOT EXISTS price_images TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE ai_service_scripts ADD COLUMN IF NOT EXISTS ai_rules TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE ai_service_scripts ADD COLUMN IF NOT EXISTS follow_up_message TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE ai_service_scripts ADD COLUMN IF NOT EXISTS step_follow_up_messages JSONB DEFAULT NULL`);
    await client.query(`ALTER TABLE ai_service_scripts ADD COLUMN IF NOT EXISTS step_follow_up_slots JSONB DEFAULT NULL`);
    await client.query(`ALTER TABLE ai_follow_up_logs ADD COLUMN IF NOT EXISTS last_follow_up_slot_index INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE ai_service_scripts ADD COLUMN IF NOT EXISTS ai_settings JSONB DEFAULT NULL`);
    await client.query(`ALTER TABLE ai_service_scripts ADD COLUMN IF NOT EXISTS conversation_examples JSONB DEFAULT NULL`);
    await client.query(`ALTER TABLE ai_service_scripts ADD COLUMN IF NOT EXISTS service_group TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS service_group TEXT DEFAULT NULL`);

    // Ảnh bảng giá theo nhóm dịch vụ để Sale AI gửi cho khách (object storage path).
    await client.query(`ALTER TABLE service_groups ADD COLUMN IF NOT EXISTS ai_image_url TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE service_groups ADD COLUMN IF NOT EXISTS public_for_customer BOOLEAN NOT NULL DEFAULT TRUE`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_unknown_questions (
        id              SERIAL PRIMARY KEY,
        script_id       INT NULL,
        step            INT NULL,
        question_text   TEXT NOT NULL,
        suggested_answer TEXT NULL,
        psid            TEXT,
        status          TEXT DEFAULT 'pending',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_unknown_questions_status
      ON ai_unknown_questions(status)
    `);

    // ── Seed: Gói chụp ảnh cưới ngoại cảnh (script id=1) ──────────────────────
    // Idempotent: chỉ điền price_content / ai_rules khi chúng đang NULL (tránh ghi đè admin).
    // Steps chỉ điền content khi đang NULL. QA chỉ seed khi chưa có row nào.
    await client.query(`
      INSERT INTO ai_service_scripts (id, name, price_content, ai_rules, is_active, service_group)
      VALUES (
        1,
        'Gói chụp ảnh cưới ngoại cảnh',
        $1,
        $2,
        true,
        'ngoai_canh'
      )
      ON CONFLICT (id) DO UPDATE
        SET price_content   = CASE WHEN ai_service_scripts.price_content IS NULL
                                   THEN EXCLUDED.price_content
                                   ELSE ai_service_scripts.price_content END,
            ai_rules        = CASE WHEN ai_service_scripts.ai_rules IS NULL
                                   THEN EXCLUDED.ai_rules
                                   ELSE ai_service_scripts.ai_rules END,
            service_group   = CASE WHEN ai_service_scripts.service_group IS NULL
                                   THEN EXCLUDED.service_group
                                   ELSE ai_service_scripts.service_group END,
            updated_at      = now()
    `, [
      `GÓI A — TIÊU CHUẨN: 8.500.000đ
Phù hợp cho cặp đôi muốn có bộ ảnh ngoại cảnh đẹp, nhẹ nhàng và tự nhiên.
BAO GỒM:
- 2 địa điểm ngoại cảnh (ekip di chuyển cùng)
- 1 photographer chuyên nghiệp
- Make up + tóc cô dâu tại tiệm trước khi chụp
- 80 ảnh chỉnh màu nghệ thuật
- Tặng toàn bộ file gốc
- Thời gian chụp: nửa ngày (4–5 tiếng)

GÓI B — CAO CẤP: 12.000.000đ
Phù hợp cho cặp đôi muốn bộ ảnh ngoại cảnh đầy đủ, sang trọng, kèm album in cao cấp.
BAO GỒM:
- 3 địa điểm ngoại cảnh (ekip di chuyển cùng)
- 1 photographer master
- Make up + tóc cô dâu tại tiệm trước khi chụp
- 120 ảnh chỉnh màu nghệ thuật
- 1 album photobook cao cấp (thiết kế riêng)
- Ảnh phóng khung trang trí 60x90cm
- Tặng toàn bộ file gốc
- Thời gian chụp: cả ngày (7–8 tiếng)

GÓI C — LUXURY: 18.000.000đ
Trải nghiệm cao cấp nhất: địa điểm tỉnh, ekip đầy đủ, ảnh và video hậu trường.
BAO GỒM:
- Chụp tại địa điểm tỉnh (Đà Lạt, Hội An, Mũi Né… — chưa bao gồm chi phí di chuyển)
- 1 photographer master + 1 photo assistant
- Make up + tóc cô dâu tại tiệm
- 150 ảnh chỉnh màu nghệ thuật
- 1 album photobook cao cấp + 2 ảnh phóng khung
- Video hậu trường 3–5 phút
- Tặng toàn bộ file gốc

THANH TOÁN LINH HOẠT: Cọc 30% khi đặt lịch → 50% ngày chụp → 20% còn lại khi nhận ảnh
LƯU Ý: Phí di chuyển ngoài TP.HCM tính thêm theo khoảng cách. Ngày cuối tuần/lễ có thể phát sinh phụ phí 10%.`,
      `1. Không báo giá ngay khi chưa hiểu nhu cầu — hỏi trước: chụp trong TP hay ngoại tỉnh, muốn mấy địa điểm, cần album không.
2. Không được báo sai giá — giá phải bám đúng bảng giá hiện hành.
3. Khi khách hỏi giá, hỏi thêm mong muốn (số địa điểm, có cần album, có video không) để tư vấn gói phù hợp.
4. Không giảm giá quá 10% khi chưa được admin duyệt.
5. Luôn nhấn mạnh giá trị: file gốc, địa điểm đẹp, photographer master, album cao cấp.
6. Khi khách nói đắt, hướng sang gói thấp hơn hoặc giải thích quyền lợi thay vì giảm giá.
7. Không nhắc tên studio đối thủ hay so sánh tiêu cực.
8. Gói Luxury chỉ gợi ý khi khách muốn chụp ngoại tỉnh hoặc cần video hậu trường.`,
    ]);

    // Advance the sequence so future auto-inserts don't collide with id=1
    await client.query(
      `SELECT setval(pg_get_serial_sequence('ai_service_scripts','id'), (SELECT COALESCE(MAX(id), 1) FROM ai_service_scripts))`,
    );

    // Upsert 7 bước kịch bản cho script id=1 — chỉ điền content khi đang NULL
    const ngoaiCanhSteps: Array<{ step: number; label: string; content: string }> = [
      {
        step: 1,
        label: "Chào hỏi",
        content: "Chào hỏi thân thiện, hỏi khách đang tìm hiểu chụp ảnh cưới ngoại cảnh trong TP hay muốn đi tỉnh (Đà Lạt, Hội An…). Không báo giá ngay. Tạo cảm giác gần gũi như nhắn tin với người quen.",
      },
      {
        step: 2,
        label: "Khai thác nhu cầu",
        content: "Hỏi: ngày dự kiến chụp, muốn chụp trong TP hay ngoại tỉnh, cần mấy địa điểm, có muốn album in hay không, có cần video hậu trường không. Lắng nghe ngân sách để tư vấn đúng gói.",
      },
      {
        step: 3,
        label: "Gợi ý gói phù hợp",
        content: "Dựa trên nhu cầu, gợi ý 1 gói cụ thể: chụp trong TP 2 địa điểm → Gói A; cần album hoặc 3 địa điểm → Gói B; muốn đi tỉnh hoặc video → Gói C Luxury. Giải thích ngắn tại sao phù hợp, chưa gửi toàn bộ bảng giá để tạo sự tò mò.",
      },
      {
        step: 4,
        label: "Báo giá + quyền lợi",
        content: "Gửi bảng giá đầy đủ 3 gói. Nhấn mạnh điểm nổi bật: file gốc tặng hết, photographer master, địa điểm linh hoạt, album photobook thiết kế riêng. Đề cập thanh toán linh hoạt cọc 30%. Hỏi khách muốn tìm hiểu gói nào thêm.",
      },
      {
        step: 5,
        label: "Chốt mềm",
        content: "Hỏi ngày cụ thể để kiểm tra lịch ekip. Tạo cảm giác khan hiếm: cuối tuần và ngày lễ thường được book trước 2–3 tháng. Hỏi: 'Mình muốn em giữ ngày không ạ?' Đừng tạo áp lực quá mức.",
      },
      {
        step: 6,
        label: "Xử lý từ chối",
        content: "Nếu khách nói đắt: so sánh quyền lợi Gói A vs Gói B, hoặc nhấn mạnh Gói A 8tr5 vẫn có file gốc và 80 ảnh đẹp. Nếu cần suy nghĩ: hỏi đang phân vân điểm gì để giải đáp cụ thể. Không chạy theo giảm giá vội.",
      },
      {
        step: 7,
        label: "Follow-up tự động",
        content: "Nhắn lại sau 24–48h nếu khách im lặng. Hỏi có câu hỏi gì không, hoặc báo lịch ekip ngày đó còn slot không. Có thể gửi 1 ảnh mẫu đẹp để kích thích cảm xúc. Tối đa 3 lần follow-up, sau đó dừng nhắn.",
      },
    ];
    for (const s of ngoaiCanhSteps) {
      await client.query(
        `INSERT INTO ai_script_steps (script_id, step, step_label, content)
         VALUES (1, $1, $2, $3)
         ON CONFLICT (script_id, step) DO UPDATE
           SET step_label = EXCLUDED.step_label,
               content    = CASE WHEN ai_script_steps.content IS NULL OR ai_script_steps.content = ''
                                 THEN EXCLUDED.content
                                 ELSE ai_script_steps.content END,
               updated_at = now()`,
        [s.step, s.label, s.content],
      );
    }

    // Seed QA rows cho script id=1 — chỉ chạy khi chưa có row nào
    const existingQa = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM ai_script_qa_rows WHERE script_id = 1`,
    );
    if ((existingQa.rows[0] as { cnt: number }).cnt === 0) {
      const qaRows: Array<{ step: number; q: string; a: string }> = [
        { step: 1, q: "Chụp ảnh cưới ngoại cảnh", a: "Dạ em chào mình ạ! Bên em chuyên chụp ảnh cưới ngoại cảnh với nhiều địa điểm đẹp ạ. Mình đang muốn chụp trong TP.HCM hay muốn đi địa điểm tỉnh như Đà Lạt, Hội An nha?" },
        { step: 2, q: "Chụp ở đâu thì đẹp?", a: "Dạ tùy phong cách mình thích ạ! Trong TP.HCM có nhiều địa điểm đẹp như phố cổ, công viên, khu đô thị. Nếu muốn bối cảnh thiên nhiên rộng hơn thì Đà Lạt, Hội An, Mũi Né rất hot ạ. Mình ưu tiên phong cách nào để em tư vấn địa điểm phù hợp nha?" },
        { step: 4, q: "Giá chụp ngoại cảnh bao nhiêu?", a: "Dạ bên em có 3 gói ạ: Gói A 8.500.000đ (2 địa điểm, 80 ảnh), Gói B 12.000.000đ (3 địa điểm, 120 ảnh + album), Gói C Luxury 18.000.000đ (ngoại tỉnh, 150 ảnh + video). Mình cho em biết dự kiến chụp trong TP hay đi tỉnh để tư vấn gói phù hợp nhất nha?" },
        { step: 4, q: "Có mấy gói chụp ngoại cảnh?", a: "Dạ bên em có 3 gói ạ: Gói A 8tr5 (2 địa điểm), Gói B 12tr (3 địa điểm + album), Gói C Luxury 18tr (ngoại tỉnh + video hậu trường). Mỗi gói khác nhau về số địa điểm, sản phẩm và thời gian chụp nha mình." },
        { step: 4, q: "Gói A gồm những gì?", a: "Dạ Gói A 8.500.000đ gồm: 2 địa điểm ngoại cảnh, 1 photographer chuyên nghiệp, make up + tóc tại tiệm, 80 ảnh chỉnh màu nghệ thuật, tặng toàn bộ file gốc, thời gian chụp nửa ngày (4–5 tiếng) ạ." },
        { step: 4, q: "Gói B gồm những gì?", a: "Dạ Gói B 12.000.000đ gồm: 3 địa điểm ngoại cảnh, 1 photographer master, make up + tóc tại tiệm, 120 ảnh chỉnh màu nghệ thuật, 1 album photobook cao cấp thiết kế riêng, ảnh phóng khung 60x90cm, tặng toàn bộ file gốc, chụp cả ngày (7–8 tiếng) ạ." },
        { step: 4, q: "Gói Luxury gồm những gì?", a: "Dạ Gói C Luxury 18.000.000đ là gói cao cấp nhất: chụp ngoại tỉnh (Đà Lạt, Hội An, Mũi Né…), photographer master + photo assistant, 150 ảnh chỉnh màu, album photobook + 2 ảnh phóng khung, video hậu trường 3–5 phút, tặng toàn bộ file gốc ạ. Chưa bao gồm chi phí di chuyển nha mình." },
        { step: 4, q: "Có tặng file gốc không?", a: "Dạ tất cả 3 gói đều tặng toàn bộ file gốc ạ, mình giữ được mãi và in thêm tùy thích nha." },
        { step: 4, q: "Thanh toán như thế nào?", a: "Dạ bên em thanh toán linh hoạt ạ: Cọc 30% khi đặt lịch, 50% ngày chụp, 20% còn lại khi nhận ảnh. Không cần thanh toán hết một lần nha mình." },
        { step: 4, q: "Có đi Đà Lạt chụp không?", a: "Dạ có ạ! Bên em có Gói C Luxury dành riêng cho chụp ngoại tỉnh như Đà Lạt, Hội An, Mũi Né… Giá 18.000.000đ chưa bao gồm phí di chuyển. Mình muốn em báo chi tiết thêm không ạ?" },
        { step: 4, q: "Chụp bao lâu?", a: "Dạ Gói A chụp nửa ngày (4–5 tiếng), Gói B cả ngày (7–8 tiếng) ạ. Gói C ngoại tỉnh thường chụp 1–2 ngày tùy địa điểm. Em sẽ lên kế hoạch cụ thể khi biết mình chọn gói nào nha." },
        { step: 6, q: "Đắt quá, giảm được không?", a: "Dạ em hiểu mình đang cân nhắc ngân sách ạ. Gói A 8tr5 vẫn có 2 địa điểm đẹp, 80 ảnh nghệ thuật và toàn bộ file gốc — rất đáng giá mình ơi. Nếu mình muốn em giải thích thêm quyền lợi để so sánh nha 😊" },
        { step: 6, q: "Suy nghĩ thêm đã", a: "Dạ không sao ạ, mình cứ thoải mái suy nghĩ. Nếu có câu hỏi gì em luôn ở đây hỗ trợ. Lịch cuối tuần thường được đặt sớm nên nếu mình quyết định em giữ ngày ngay nha 😊" },
        { step: 5, q: "Đặt lịch sớm được không?", a: "Dạ được ạ, mình đặt càng sớm càng tốt vì lịch cuối tuần thường được book trước 2–3 tháng ạ. Mình cho em ngày dự kiến để em kiểm tra lịch và giữ slot ngay nha 😊" },
        { step: 5, q: "Đặt lịch như thế nào?", a: "Dạ mình cho em biết ngày chụp dự kiến, em kiểm tra lịch ekip và giữ slot cho mình ạ. Cọc 30% để chính thức giữ ngày nha 😊" },
      ];
      for (let i = 0; i < qaRows.length; i++) {
        const row = qaRows[i];
        await client.query(
          `INSERT INTO ai_script_qa_rows (script_id, step, question, answer, sort_order)
           VALUES (1, $1, $2, $3, $4)`,
          [row.step, row.q, row.a, i],
        );
      }
    }
    // ── Seed: Gợi ý địa điểm theo mùa cho script id=1 (idempotent) ─────────────
    // Chèn từng row chỉ khi câu hỏi đó chưa tồn tại (tránh duplicate khi migrate lại)
    const seasonalQaRows: Array<{ step: number; q: string; a: string; sort_order: number }> = [
      {
        step: 2,
        q: "Tháng mấy thì nên đi Đà Lạt chụp?",
        a: "Dạ Đà Lạt đẹp nhất vào tháng 11 đến tháng 4 ạ — đây là mùa khô, trời trong xanh, hoa cỏ nở rộ, ánh sáng rất đẹp cho ảnh ngoại cảnh. Tháng 12–2 còn có thể gặp mây mù lãng mạn buổi sáng sớm ạ. Tháng 5–10 là mùa mưa ở Đà Lạt, hay có mưa chiều nên khó chụp hơn — nếu mình muốn đi thời gian đó em sẽ lên kế hoạch linh hoạt nha 😊",
        sort_order: 15,
      },
      {
        step: 2,
        q: "Mùa mưa có địa điểm nào đẹp không?",
        a: "Dạ mùa mưa (tháng 5–10) ở miền Nam mình vẫn chụp ngoại cảnh đẹp được ạ! Trong TP.HCM có nhiều địa điểm không bị mưa ảnh hưởng nhiều như phố cổ Bình Dương, khu đô thị Phú Mỹ Hưng, các công trình kiến trúc cổ điển. Buổi sáng sớm hoặc chiều tối thường không có mưa. Nếu mình muốn đi tỉnh thì Đà Nẵng/Hội An tháng 5–8 lại rất đẹp — miền Trung mùa này nắng đẹp ạ!",
        sort_order: 16,
      },
      {
        step: 2,
        q: "Tháng mấy thì nên đi Hội An chụp?",
        a: "Dạ Hội An đẹp nhất từ tháng 2 đến tháng 8 ạ! Tháng 3–6 là thời điểm vàng: nắng đẹp, ít mưa, biển An Bàng trong xanh rất lý tưởng để chụp. Tháng 9–11 là mùa mưa lũ ở Hội An nên em không khuyến khích đi thời gian này ạ. Nếu mình đang tính đi Hội An, tháng 4–5 là tuyệt vời nhất luôn nha 😊",
        sort_order: 17,
      },
      {
        step: 2,
        q: "Tháng mấy thì nên đi Mũi Né/Phan Thiết chụp?",
        a: "Dạ Mũi Né đẹp nhất từ tháng 11 đến tháng 4 ạ — đây là mùa khô, biển êm, cồn cát vàng rực rỡ và ánh nắng rất đẹp. Đặc biệt tháng 12–3 gió ít, trời xanh, lý tưởng để chụp ảnh cưới lãng mạn ạ. Tháng 5–10 hay có gió lớn và sóng to nên đi biển sẽ khó chụp hơn nha mình.",
        sort_order: 18,
      },
      {
        step: 2,
        q: "Mùa nào đẹp nhất để chụp ngoại cảnh?",
        a: "Dạ tùy địa điểm mình muốn đến ạ! Em tóm gọn theo mùa nha:\n\n🌸 Tháng 11–4 (mùa khô miền Nam): Đẹp nhất để đi Đà Lạt, Mũi Né, Phú Quốc — nắng đẹp, ít mưa.\n\n☀️ Tháng 2–8 (nắng miền Trung): Đà Nẵng, Hội An, Huế rất lý tưởng — tránh tháng 9–11 vì mưa lũ.\n\n🌧️ Tháng 5–10 (mùa mưa miền Nam): Ưu tiên chụp trong TP.HCM, hoặc chọn khung giờ sáng sớm/chiều tối để tránh mưa.\n\nMình dự kiến chụp khoảng tháng mấy để em tư vấn địa điểm phù hợp nhất nha 😊",
        sort_order: 19,
      },
      {
        step: 2,
        q: "Chụp tháng 12 thì nên đi đâu?",
        a: "Dạ tháng 12 là thời điểm cực đẹp để chụp ngoại cảnh ạ! Em gợi ý:\n\n✅ Đà Lạt: Mùa khô, trời trong, nhiều hoa dã quỳ và hoa cúc nở đẹp — rất phù hợp phong cách lãng mạn, cổ tích.\n✅ Mũi Né: Biển êm, cát trắng, nắng vàng đẹp — lý tưởng cho ảnh cưới biển.\n✅ Hội An: Tiết trời mát mẻ, phố cổ lung linh đèn lồng — thơ mộng và lãng mạn.\n\nMình thích phong cách nào để em tư vấn địa điểm cụ thể hơn nha?",
        sort_order: 20,
      },
      {
        step: 2,
        q: "Chụp tháng 6 tháng 7 thì nên đi đâu?",
        a: "Dạ tháng 6–7 ở miền Nam đang mùa mưa nên em gợi ý:\n\n✅ Hội An/Đà Nẵng: Miền Trung mùa này nắng đẹp, ít mưa — rất lý tưởng!\n✅ Trong TP.HCM: Chụp buổi sáng sớm (7–10h) hoặc chiều tối (5–7h) tránh mưa, vẫn ra ảnh đẹp ạ.\n✅ Phú Quốc: Tháng 6–7 đang mùa mưa nên không khuyến khích.\n\nNếu mình linh hoạt lịch, Hội An tháng 6–7 là lựa chọn hàng đầu đó ạ 😊",
        sort_order: 21,
      },
      {
        step: 2,
        q: "Chụp trong TP.HCM thì có địa điểm đẹp không?",
        a: "Dạ trong TP.HCM có rất nhiều địa điểm đẹp ạ! Em gợi ý một số nha:\n\n🏙️ Phong cách đô thị/hiện đại: Phú Mỹ Hưng, khu Landmark, cầu Ánh Sao.\n🌿 Phong cách thiên nhiên/xanh: Thảo Cầm Viên, công viên 23/9, khu dân cư có nhiều cây xanh.\n🏛️ Phong cách vintage/cổ điển: Bưu điện Thành phố, Nhà thờ Đức Bà, phố cổ Chợ Lớn.\n🌸 Phong cách lãng mạn: Đường hoa, khu resort ven thành phố.\n\nMình thích phong cách nào để em gợi ý địa điểm cụ thể và lên kế hoạch cho nha 😊",
        sort_order: 22,
      },
    ];
    for (const row of seasonalQaRows) {
      await client.query(
        `INSERT INTO ai_script_qa_rows (script_id, step, question, answer, sort_order)
         SELECT 1, $1, $2, $3, $4
         WHERE NOT EXISTS (
           SELECT 1 FROM ai_script_qa_rows WHERE script_id = 1 AND question = $2
         )`,
        [row.step, row.q, row.a, row.sort_order],
      );
    }
    // ── End seed: Gợi ý địa điểm theo mùa (script id=1) ───────────────────────

    // ── End seed: Gói chụp ảnh cưới ngoại cảnh ────────────────────────────────

    // ── Seed: Gói chụp kỷ yếu (script id=2) ───────────────────────────────────
    // Idempotent: chỉ điền price_content / ai_rules khi chúng đang NULL (tránh ghi đè admin).
    // Steps chỉ điền content khi đang NULL. QA chỉ seed khi chưa có row nào.
    await client.query(`
      INSERT INTO ai_service_scripts (id, name, price_content, ai_rules, is_active)
      VALUES (
        2,
        'Gói chụp kỷ yếu',
        $1,
        $2,
        true
      )
      ON CONFLICT (id) DO UPDATE
        SET price_content = CASE WHEN ai_service_scripts.price_content IS NULL OR ai_service_scripts.price_content = ''
                                 THEN EXCLUDED.price_content
                                 ELSE ai_service_scripts.price_content END,
            ai_rules      = CASE WHEN ai_service_scripts.ai_rules IS NULL OR ai_service_scripts.ai_rules = ''
                                 THEN EXCLUDED.ai_rules
                                 ELSE ai_service_scripts.ai_rules END,
            updated_at    = now()
    `, [
      `GÓI CƠ BẢN: 3.500.000đ/lớp — Chụp tại studio, 50 ảnh lớp (đã edit), 1 ảnh cá nhân/thành viên (5x7cm in sẵn), thời gian chụp 2–3 tiếng.
GÓI NGOẠI CẢNH: 6.000.000đ/lớp — 1–2 địa điểm ngoại cảnh, 100 ảnh lớp (đã edit), ảnh cá nhân full file gốc, album tập thể thiết kế riêng (size A4), thời gian 4–5 tiếng.
GÓI PREMIUM: 9.000.000đ/lớp — 2–3 địa điểm ngoại cảnh hoặc 1 địa điểm xa, 150 ảnh đã edit + file gốc toàn bộ, album photobook cao cấp, video highlight lớp 2–3 phút, makeup artist tùy chọn (+phí riêng), thời gian 5–6 tiếng.
Giá trên tính cho lớp tối đa 40 người. Lớp >40 người phụ thu 50.000đ/người.
Di chuyển xa (ngoài TP.HCM) phụ thu phí xăng + ăn ở nếu có.
Cọc 30% để giữ lịch. Thanh toán đủ trước ngày chụp 3 ngày.`,
      `1. Không báo giá ngay khi chưa biết thông tin lớp — hỏi trước: sĩ số lớp, muốn chụp studio hay ngoại cảnh, ngày dự kiến.
2. Giá phải bám đúng bảng giá. Không tự ý giảm hơn 10% khi chưa được admin duyệt.
3. Khi khách hỏi giá, hỏi thêm nhu cầu (studio/ngoại cảnh, có cần album/video không) để tư vấn gói phù hợp.
4. Luôn nhấn mạnh quyền lợi: file gốc, photographer chuyên nghiệp, album thiết kế riêng, video highlight.
5. Gói Cơ bản phù hợp lớp ít kinh phí hoặc chụp nhanh. Gói Ngoại cảnh phù hợp lớp muốn ảnh đẹp kỷ niệm. Gói Premium cho lớp muốn trọn bộ kỷ niệm.
6. Khi khách nói đắt, hướng sang gói thấp hơn hoặc giải thích quyền lợi cụ thể thay vì giảm giá ngay.
7. Không nhắc tên studio đối thủ hay so sánh tiêu cực.
8. Luôn hỏi sĩ số lớp để tính phụ thu nếu cần (>40 người).
9. Nếu khách là lớp trưởng hoặc đại diện, hỏi xem đã thống nhất ngân sách với lớp chưa để tư vấn gói phù hợp.
10. Gói Premium có thể gợi ý thêm makeup artist hoặc thuê trang phục nếu lớp muốn ảnh lung linh hơn.`,
    ]);

    // Upsert 7 bước kịch bản cho script id=2 — chỉ điền content khi đang NULL
    const kyYeuSteps: Array<{ step: number; label: string; content: string }> = [
      {
        step: 1,
        label: "Chào hỏi",
        content: "Dạ chào bạn, mình là trợ lý tư vấn của Amazing Studio ạ! Bạn đang quan tâm đến dịch vụ chụp kỷ yếu cho lớp mình phải không ạ? Để mình tư vấn gói phù hợp nhất, bạn cho mình biết lớp đang học cấp nào và dự kiến chụp vào thời điểm nào không ạ?",
      },
      {
        step: 2,
        label: "Khai thác nhu cầu",
        content: "Hỏi đủ 4 thông tin chính trước khi tư vấn gói: (1) Sĩ số lớp (để tính phụ thu nếu >40 người), (2) Lớp muốn chụp studio hay ngoại cảnh — cả hai đều được, (3) Ngân sách lớp đã dự kiến chưa (mỗi bạn đóng bao nhiêu), (4) Có cần album in hay chỉ lấy file ảnh kỹ thuật số. Hỏi tự nhiên từng câu, không hỏi dồn cùng lúc.",
      },
      {
        step: 3,
        label: "Gợi ý gói phù hợp",
        content: "Dựa trên nhu cầu, gợi ý 1 gói cụ thể: (1) Lớp muốn chụp nhanh, kinh phí thấp hoặc chụp trong trường → Gói Cơ Bản 3.500.000đ. (2) Lớp muốn chụp ngoại cảnh đẹp, có album kỷ niệm → Gói Ngoại Cảnh 6.000.000đ. (3) Lớp muốn trọn bộ kỷ niệm: nhiều địa điểm + album cao cấp + video → Gói Premium 9.000.000đ. Giải thích ngắn tại sao phù hợp với nhu cầu lớp đó, chưa gửi toàn bộ bảng giá để tạo sự tập trung.",
      },
      {
        step: 4,
        label: "Báo giá + quyền lợi",
        content: "Gửi bảng giá đầy đủ 3 gói. Nhấn mạnh điểm nổi bật: (1) File gốc tặng kèm (Gói Ngoại Cảnh và Premium), (2) Ảnh cá nhân cho từng thành viên, (3) Photographer chuyên nghiệp, kinh nghiệm chụp kỷ yếu nhiều năm, (4) Album photobook thiết kế riêng theo concept lớp, (5) Video highlight 2–3 phút (Gói Premium). Đề cập cọc 30% để giữ lịch. Hỏi lớp đang cân nhắc gói nào ạ?",
      },
      {
        step: 5,
        label: "Chốt mềm",
        content: "Hỏi ngày cụ thể hoặc khoảng thời gian lớp muốn chụp để kiểm tra lịch ekip. Tạo cảm giác khan hiếm tự nhiên: cuối tuần và tháng 5–6 (mùa kỷ yếu) thường được đặt trước 1–2 tháng. Hỏi: 'Mình muốn em giữ slot ngày đó cho lớp mình không ạ?' — tạo cảm giác chủ động mà không áp lực. Nếu lớp còn phân vân, đề nghị giữ lịch dự phòng 3 ngày không mất phí.",
      },
      {
        step: 6,
        label: "Xử lý từ chối",
        content: "Nếu lớp nói đắt: Tính giá theo đầu người — Gói Cơ Bản lớp 40 người chỉ 87.500đ/bạn, Gói Ngoại Cảnh là 150.000đ/bạn — rất hợp lý cho kỷ niệm một đời. Nếu lớp đang so sánh nơi khác: hỏi nơi khác có tặng file gốc, có album thiết kế riêng và photographer chuyên kỷ yếu không. Nếu cần hỏi lại lớp: hỏi phân vân điểm gì cụ thể để giải đáp. Không giảm giá vội — nhấn mạnh chất lượng và kỷ niệm lâu dài.",
      },
      {
        step: 7,
        label: "Follow-up tự động",
        content: "Nhắn lại sau 24–48h nếu lớp im lặng. Có thể hỏi: 'Lớp mình đã thống nhất chưa ạ? Em có thể giữ lịch thêm vài ngày.' Hoặc gửi 1–2 ảnh mẫu kỷ yếu đẹp của studio để kích thích cảm xúc. Sau lần 2 không phản hồi, nhắn nhẹ thông báo slot sắp đầy. Tối đa 3 lần follow-up, sau đó dừng và đánh dấu lead để admin xử lý thủ công nếu cần.",
      },
    ];
    for (const s of kyYeuSteps) {
      await client.query(
        `INSERT INTO ai_script_steps (script_id, step, step_label, content)
         VALUES (2, $1, $2, $3)
         ON CONFLICT (script_id, step) DO UPDATE
           SET step_label = EXCLUDED.step_label,
               content    = CASE WHEN ai_script_steps.content IS NULL OR ai_script_steps.content = ''
                                 THEN EXCLUDED.content
                                 ELSE ai_script_steps.content END,
               updated_at = now()`,
        [s.step, s.label, s.content],
      );
    }

    // Seed QA rows cho script id=2 — chỉ chạy khi chưa có row nào
    const existingKyYeuQa = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM ai_script_qa_rows WHERE script_id = 2`,
    );
    if ((existingKyYeuQa.rows[0] as { cnt: number }).cnt === 0) {
      const kyYeuQaRows: Array<{ step: number; q: string; a: string }> = [
        { step: 2, q: "Lớp mình 45 người thì giá bao nhiêu?", a: "Dạ, giá niêm yết tính cho lớp tối đa 40 người ạ. Lớp bạn 45 người thì phụ thu thêm 5 người × 50.000đ = 250.000đ nhé. Ví dụ Gói Ngoại Cảnh sẽ là 6.250.000đ tổng cộng ạ. Lớp mình đang cân nhắc gói nào ạ?" },
        { step: 4, q: "Studio mình cho thuê địa điểm chụp ngoại cảnh ở đâu?", a: "Dạ Amazing Studio có nhiều địa điểm quen thuộc ở TP.HCM như: Thảo Cầm Viên, Dinh Độc Lập, Phố đi bộ Nguyễn Huệ, Công viên Tao Đàn, khu phố cổ quận 5, hoặc lớp muốn địa điểm riêng mình cũng có thể sắp xếp ạ. Lớp thích phong cách cổ điển hay hiện đại hơn ạ?" },
        { step: 4, q: "Có được lấy file gốc không?", a: "Dạ Gói Ngoại Cảnh và Gói Premium đều được tặng toàn bộ file gốc ạ! Riêng Gói Cơ Bản (chụp studio) thì giao ảnh đã edit, nếu lớp muốn mua thêm file gốc có thể liên hệ bổ sung ạ." },
        { step: 4, q: "Ảnh cá nhân thì mỗi bạn được mấy tấm?", a: "Dạ mỗi thành viên sẽ được chụp ảnh cá nhân riêng ạ. Gói Cơ Bản in sẵn 1 ảnh 5x7cm/người. Gói Ngoại Cảnh và Premium thì có file ảnh cá nhân kỹ thuật số (đã retouch) giao qua Google Drive cho từng bạn ạ." },
        { step: 3, q: "Có thể chụp kỷ yếu trong trường không?", a: "Dạ hoàn toàn được ạ! Nếu trường cho phép thì ekip của Amazing Studio có thể đến chụp tại trường. Thường thì lớp sẽ đặt Gói Cơ Bản hoặc nếu muốn có thêm địa điểm ngoại cảnh thì chụp 1 buổi trong trường + 1 buổi ngoài ạ. Lớp bạn trường có cho phép đem máy vào chụp không nhỉ?" },
        { step: 5, q: "Có thể đặt cọc bao nhiêu?", a: "Dạ cọc 30% tổng giá trị hợp đồng để giữ lịch ạ. Ví dụ Gói Ngoại Cảnh 6.000.000đ thì cọc 1.800.000đ, thanh toán số còn lại trước ngày chụp 3 ngày ạ. Tiền cọc sẽ được trừ vào tổng hóa đơn luôn nhé!" },
        { step: 6, q: "Nơi khác báo rẻ hơn thì sao?", a: "Dạ bạn có thể hỏi thêm nơi đó: họ có tặng file gốc không, photographer chuyên kỷ yếu hay không, album có thiết kế riêng theo concept lớp không? Thường những nơi rẻ hơn sẽ cắt bớt ảnh, không có file gốc hoặc album. Ảnh kỷ yếu là kỷ niệm một lần trong đời nên lớp cân nhắc kỹ ạ!" },
        { step: 2, q: "Mùa chụp kỷ yếu là tháng mấy?", a: "Dạ mùa kỷ yếu thường tập trung vào tháng 4–6 (trước tốt nghiệp) và tháng 11–12 (giữa năm học/cuối kỳ) ạ. Các tháng này lịch thường kín sớm nên lớp mình nên đặt trước 1–2 tháng để chọn được ngày đẹp nhé!" },
        { step: 4, q: "Video highlight lớp là video kiểu gì?", a: "Dạ video highlight là video montage dài 2–3 phút ghép từ những khoảnh khắc đẹp trong buổi chụp, có nhạc nền, chỉnh màu chuyên nghiệp ạ. Lớp có thể dùng để đăng Facebook, TikTok, hoặc chiếu trong lễ tổng kết rất đẹp ạ! Video highlight chỉ có trong Gói Premium nhé." },
        { step: 5, q: "Bao lâu thì nhận được ảnh?", a: "Dạ thường 7–10 ngày làm việc sau buổi chụp là có ảnh đã edit ạ. Album in thì mất thêm 5–7 ngày thiết kế và in ấn nữa. Trường hợp lớp cần gấp (ví dụ để kịp lễ tốt nghiệp), bạn báo trước để ekip ưu tiên ạ!" },
        { step: 1, q: "Các bạn có chụp kỷ yếu cấp 3 không?", a: "Dạ Amazing Studio nhận chụp kỷ yếu cho tất cả các cấp: cấp 2, cấp 3, trung cấp, cao đẳng, đại học ạ! Mỗi cấp học có phong cách ảnh hơi khác nhau nhưng mình đều có kinh nghiệm ạ. Lớp bạn đang học cấp mấy và có bao nhiêu bạn ạ?" },
        { step: 3, q: "Lớp mình muốn có concept riêng được không?", a: "Dạ hoàn toàn được ạ! Lớp có thể propose concept (ví dụ: vintage, thể thao, áo dài, casual...) và ekip sẽ tư vấn địa điểm + phục trang phù hợp. Nếu cần thuê thêm trang phục hay props đặc biệt thì có thể bổ sung thêm chi phí nhỏ ạ. Lớp mình đã có ý tưởng concept chưa nhỉ?" },
      ];
      for (let i = 0; i < kyYeuQaRows.length; i++) {
        const row = kyYeuQaRows[i];
        await client.query(
          `INSERT INTO ai_script_qa_rows (script_id, step, question, answer, sort_order)
           VALUES (2, $1, $2, $3, $4)`,
          [row.step, row.q, row.a, i],
        );
      }
    }
    // ── End seed: Gói chụp kỷ yếu ─────────────────────────────────────────────

    // ── ai_test_sessions + ai_test_messages (Phòng test AI persistent) ─────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_test_sessions (
        id                        TEXT PRIMARY KEY,
        name                      TEXT NOT NULL DEFAULT '',
        customer_name             TEXT NOT NULL DEFAULT 'Khách Test',
        script_id                 INTEGER,
        current_script_id         INTEGER,
        current_sale_step         INTEGER,
        script_updated_at         TIMESTAMPTZ,
        last_customer_message_at  TIMESTAMPTZ,
        follow_up_count           INTEGER NOT NULL DEFAULT 0,
        last_follow_up_at         TIMESTAMPTZ,
        last_follow_up_step       INTEGER,
        last_follow_up_slot_index INTEGER,
        message_count             INTEGER NOT NULL DEFAULT 0,
        last_message_preview      TEXT,
        last_message_at           TIMESTAMPTZ,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_test_messages (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES ai_test_sessions(id) ON DELETE CASCADE,
        role         TEXT NOT NULL,
        text         TEXT NOT NULL DEFAULT '',
        type         TEXT,
        decision     TEXT,
        current_step INTEGER,
        debug_json   JSONB,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_test_messages_session_id
      ON ai_test_messages(session_id, created_at)
    `);

    // ── Backfill: add new columns to ai_test_sessions if they don't exist yet ──
    // Handles environments that had the table before these columns were introduced
    const sessionBackfills: [string, string][] = [
      ["name",                      "TEXT NOT NULL DEFAULT ''"],
      ["script_updated_at",         "TIMESTAMPTZ"],
      ["last_customer_message_at",  "TIMESTAMPTZ"],
      ["follow_up_count",           "INTEGER NOT NULL DEFAULT 0"],
      ["last_follow_up_at",         "TIMESTAMPTZ"],
      ["last_follow_up_step",       "INTEGER"],
      ["last_follow_up_slot_index", "INTEGER"],
      ["message_count",             "INTEGER NOT NULL DEFAULT 0"],
      ["last_message_preview",      "TEXT"],
      ["last_message_at",           "TIMESTAMPTZ"],
      ["updated_at",                "TIMESTAMPTZ NOT NULL DEFAULT now()"],
    ];
    for (const [col, def] of sessionBackfills) {
      await client.query(
        `ALTER TABLE ai_test_sessions ADD COLUMN IF NOT EXISTS ${col} ${def}`,
      );
    }

    // ── Backfill: add new columns to ai_test_messages if they don't exist yet ──
    const msgBackfills: [string, string][] = [
      ["type",         "TEXT"],
      ["decision",     "TEXT"],
      ["current_step", "INTEGER"],
      ["debug_json",   "JSONB"],
    ];
    for (const [col, def] of msgBackfills) {
      await client.query(
        `ALTER TABLE ai_test_messages ADD COLUMN IF NOT EXISTS ${col} ${def}`,
      );
    }
    // ── End ai_test_sessions ───────────────────────────────────────────────────

    // ── Shared Q&A: allow script_id to be NULL in ai_script_qa_rows ──────────
    // Rows with script_id IS NULL + step 1-3 are "shared" and apply to all scripts.
    // Rows with script_id IS NOT NULL + step >= 4 are script-specific.
    await client.query(`
      ALTER TABLE ai_script_qa_rows ALTER COLUMN script_id DROP NOT NULL
    `);
    // ── End shared Q&A migration ───────────────────────────────────────────────

    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS deadline_system TEXT DEFAULT NULL`);
    // Task #383 Bước 2: số ngày hậu kỳ mặc định cho từng gói dịch vụ.
    // Nullable → giữ nguyên hành vi cũ cho gói chưa cấu hình.
    await client.query(`ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS default_editing_days INTEGER DEFAULT NULL`);
    // requires_post_production: bảng giá quyết định booking có vào Tiến độ hậu kỳ
    await client.query(`ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS requires_post_production BOOLEAN NOT NULL DEFAULT false`);
    // Seed mặc định hậu kỳ theo nhóm — chỉ chạy 1 lần, không ghi đè cấu hình người dùng.
    const { rows: ppSeedRows } = await client.query(
      `SELECT 1 FROM settings WHERE key = 'requires_post_production_seeded_v1' LIMIT 1`,
    );
    if (ppSeedRows.length === 0) {
      await client.query(`
        UPDATE service_packages sp
           SET requires_post_production = true
          FROM service_groups sg
         WHERE sp.group_id = sg.id
           AND UPPER(sg.name) IN (
             'CHỤP CỔNG TẠI STUDIO','ALBUM TẠI STUDIO','ALBUM NGOẠI CẢNH',
             'CHỤP TIỆC CƯỚI','BEAUTY / THỜI TRANG','CHỤP GIA ĐÌNH','QUAY PHIM'
           )
      `);
      await client.query(`
        UPDATE service_packages sp
           SET requires_post_production = false
          FROM service_groups sg
         WHERE sp.group_id = sg.id
           AND (
             UPPER(sg.name) IN (
               'MAKEUP LẺ','IN ẢNH','COMBO KHÔNG MAKEUP','COMBO CÓ MAKEUP',
               'COMBO TRANG PHỤC CƯỚI - CÓ MAKEUP','COMBO TRANG PHỤC CƯỚI - KHÔNG MAKEUP'
             )
             OR UPPER(sg.name) LIKE '%COMBO%'
           )
      `);
      await client.query(`
        UPDATE service_packages
           SET requires_post_production = true
         WHERE group_id IS NULL
           AND (
             name ILIKE '%chụp%' OR name ILIKE '%album%' OR name ILIKE '%quay%' OR name ILIKE '%cổng%'
           )
           AND name NOT ILIKE '%makeup%'
      `);
      await client.query(`
        UPDATE service_packages
           SET requires_post_production = false
         WHERE group_id IS NULL
           AND (
             name ILIKE '%makeup%' OR name ILIKE '%phụ tóc%' OR name ILIKE '%thuê%'
             OR name ILIKE '%vest%' OR name ILIKE '%áo dài%'
           )
      `);
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('requires_post_production_seeded_v1', '1') ON CONFLICT (key) DO NOTHING`,
      );
    }

    await client.query(`ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS requires_printing BOOLEAN NOT NULL DEFAULT false`);
    const { rows: printSeedRows } = await client.query(
      `SELECT 1 FROM settings WHERE key = 'requires_printing_seeded_v1' LIMIT 1`,
    );
    if (printSeedRows.length === 0) {
      await client.query(`
        UPDATE service_packages sp
           SET requires_printing = true
          FROM service_groups sg
         WHERE sp.group_id = sg.id
           AND UPPER(sg.name) IN ('ALBUM TẠI STUDIO', 'ALBUM NGOẠI CẢNH', 'IN ẢNH')
      `);
      await client.query(`
        UPDATE service_packages
           SET requires_printing = true
         WHERE CAST(print_cost AS numeric) > 0
      `);
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('requires_printing_seeded_v1', '1') ON CONFLICT (key) DO NOTHING`,
      );
    }


    // ── Partial unique index: chỉ một job active mỗi booking ─────────────────
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS photoshop_jobs_booking_active_unique
      ON photoshop_jobs (booking_id)
      WHERE is_active = true
    `);
    // ── End partial unique index ──────────────────────────────────────────────

    // ── Back-fill deadline_system cho các job hậu kỳ cũ ─────────────────────────
    // deadline_system = shoot_date + 10/15 ngày (theo dịch vụ).
    // Covers cả "ngoại cảnh" (có dấu) lẫn "ngoai canh" (không dấu) — G2.
    // PostgreSQL interval arithmetic không bị UTC drift — G3.
    // Idempotent: chỉ cập nhật khi deadline_system IS NULL.
    await client.query(`
      UPDATE photoshop_jobs pj
      SET deadline_system = CASE
          WHEN lower(COALESCE(pj.service_name, '')) LIKE '%album%'
            OR lower(COALESCE(pj.service_name, '')) LIKE '%ngoai canh%'
            OR lower(COALESCE(pj.service_name, '')) LIKE '%ngo_i c_nh%'
            OR lower(COALESCE(pj.service_name, '')) LIKE '%ngoại cảnh%'
          THEN (b.shoot_date::date + INTERVAL '15 days')::text
          ELSE (b.shoot_date::date + INTERVAL '10 days')::text
        END
      FROM bookings b
      WHERE pj.booking_id = b.id
        AND pj.deadline_system IS NULL
        AND b.shoot_date IS NOT NULL
    `);
    // ── End back-fill deadline_system ─────────────────────────────────────────

    // ── Thêm cột mới cho print management + chi phí phát sinh ────────────────
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS drive_link TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS print_notes TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS da_xuat_in BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS chi_phi_phat_sinh INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS mo_ta_phat_sinh TEXT DEFAULT ''`);
    // ── End cột mới ───────────────────────────────────────────────────────────

    // ── Công hậu kỳ: sản lượng ảnh ───────────────────────────────────────────
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS detail_photos_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS detail_photos_rate INTEGER DEFAULT 12000`);
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS party_photos_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS party_photos_rate INTEGER DEFAULT 1000`);

    // Task #476: Lương Photoshop từ module Hậu kỳ — snapshot ai hoàn thành + khi nào
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS completed_by INTEGER`);
    await client.query(`ALTER TABLE photoshop_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP`);
    // Backfill: rows đã ở trạng thái xong_show/hoan_thanh nhưng chưa có completed_*
    await client.query(`
      UPDATE photoshop_jobs
      SET completed_at = COALESCE(completed_at, updated_at),
          completed_by = COALESCE(completed_by, assigned_staff_id)
      WHERE status IN ('xong_show', 'hoan_thanh')
        AND (completed_at IS NULL OR completed_by IS NULL)
    `);
    // Task #476: chặn race tạo earning trùng cho cùng một photoshop_job.
    // Dọn duplicate (giữ id nhỏ nhất, void phần còn lại) trước khi tạo index.
    await client.query(`
      UPDATE staff_job_earnings
         SET status = 'voided'
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY notes ORDER BY id ASC) AS rn
             FROM staff_job_earnings
            WHERE notes LIKE 'photoshop_job:%' AND status <> 'voided'
         ) t WHERE t.rn > 1
       )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS staff_job_earnings_photoshop_job_unique
        ON staff_job_earnings(notes)
        WHERE notes LIKE 'photoshop_job:%' AND status <> 'voided'
    `);
    // ── End công hậu kỳ ───────────────────────────────────────────────────────

    // ── Backfill trạng thái cũ → mới ─────────────────────────────────────────
    // hoan_thanh → xong_show, dang_xu_ly → dang_pts, cho_duyet → da_pts
    await client.query(`UPDATE photoshop_jobs SET status = 'xong_show' WHERE status = 'hoan_thanh'`);
    await client.query(`UPDATE photoshop_jobs SET status = 'dang_pts'  WHERE status = 'dang_xu_ly'`);
    await client.query(`UPDATE photoshop_jobs SET status = 'da_pts'    WHERE status = 'cho_duyet'`);
    // ── End backfill trạng thái ───────────────────────────────────────────────

    // ── Backfill: chuẩn hoá số điện thoại cũ còn chứa ký tự thừa ────────────
    // Đảm bảo phone ILIKE $normPct hoạt động đúng với mọi row kể cả dữ liệu cũ.
    await client.query(`
      UPDATE customers
      SET phone = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '')
      WHERE phone IS NOT NULL
        AND phone ~ '[\\s\\-\\(\\)\\.\\+]'
    `);
    // ── End backfill phone ────────────────────────────────────────────────────

    // ── Quotes "Báo giá tạm tính" — mở rộng schema ───────────────────────────
    // customer_id optional (cho phép báo giá khách mới chưa lưu hồ sơ)
    await client.query(`ALTER TABLE quotes ALTER COLUMN customer_id DROP NOT NULL`);
    await client.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_name TEXT`);
    await client.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS phone TEXT`);
    await client.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS surcharges JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await client.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deductions JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await client.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS expected_date DATE`);
    await client.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS expected_time TEXT`);
    await client.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS converted_booking_id INTEGER`);
    await client.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS converted_at TIMESTAMP`);
    // ── End quotes ────────────────────────────────────────────────────────────

    // ── Fixed costs (chi phí cố định hàng tháng) ─────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS fixed_costs (
        id          serial PRIMARY KEY,
        label       text NOT NULL,
        amount      numeric(12,2) NOT NULL DEFAULT 0,
        notes       text,
        active      boolean NOT NULL DEFAULT true,
        created_at  timestamp NOT NULL DEFAULT now(),
        updated_at  timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fixed_costs_active ON fixed_costs(active)`);
    // ── End fixed costs ──────────────────────────────────────────────────────

    // ── Task #373: Dọn photoshop_jobs cũ gắn sai vào hợp đồng tổng ──────────
    // Các hợp đồng tổng (is_parent_contract = true) được tách thành child bookings.
    // Job cũ gắn vào parent phải bị deactivate để không làm sai số liệu thống kê.
    // Idempotent: chỉ UPDATE những row đang is_active = true.
    const deactivateResult = await client.query(`
      UPDATE photoshop_jobs
      SET is_active = false
      WHERE booking_id IN (
        SELECT id FROM bookings WHERE is_parent_contract = true
      )
      AND is_active = true
    `);
    const deactivated = deactivateResult.rowCount ?? 0;
    if (deactivated > 0) {
      console.log(`[migrations] Task #373: đã deactivate ${deactivated} photoshop_job(s) gắn vào hợp đồng tổng.`);
    } else {
      console.log("[migrations] Task #373: không có photoshop_job nào cần dọn (đã sạch hoặc chưa có parent contracts).");
    }
    // ── End Task #373 ─────────────────────────────────────────────────────────

    // Cho phép phiếu chi lưu nhiều ảnh biên lai (mảng URL)
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_urls TEXT[] DEFAULT '{}'`);

    // Cho phép phiếu thu lưu nhiều ảnh bằng chứng (mảng URL)
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS proof_image_urls TEXT[] DEFAULT '{}'`);

    // Task #390: phiếu thu lẻ (ad-hoc) — không gắn booking, dùng cho thuê đồ
    // lẻ / phụ kiện / mâm quả / khác. payment_type sẽ là 'ad_hoc'.
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_name TEXT`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_phone TEXT`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS description TEXT`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS ad_hoc_category TEXT`);

    // Task #397: huỷ phiếu thu (soft delete) — không xoá cứng, giữ dấu vết kế toán.
    // status='voided' → không tính vào bất kỳ số liệu tài chính nào.
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_by TEXT`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS void_reason TEXT`);

    // ── Hotfix: tách proof_image_url cũ chứa "|||" (do bug upload ảnh cọc) thành mảng ──
    // Trước đây calendar.tsx gửi depositProofImages.join("|||") khiến nhiều URL bị lưu
    // dồn vào 1 field string → không hiển thị thumbnail. Tách lại thành proof_image_urls.
    const fixed = await client.query(`
      UPDATE payments
      SET proof_image_urls = string_to_array(proof_image_url, '|||'),
          proof_image_url  = split_part(proof_image_url, '|||', 1)
      WHERE proof_image_url LIKE '%|||%'
        AND (proof_image_urls IS NULL OR array_length(proof_image_urls, 1) IS NULL OR array_length(proof_image_urls, 1) <= 1)
    `);
    if ((fixed.rowCount ?? 0) > 0) {
      console.log(`[migrations] Đã tách ${fixed.rowCount} payment.proof_image_url chứa "|||" thành mảng.`);
    }

    // ── Task #465: HR Payroll FSM + paid leave ──────────────────────────────
    // Link earnings to payroll, plus optional service booking back-reference.
    await client.query(`ALTER TABLE staff_job_earnings ADD COLUMN IF NOT EXISTS payroll_id INTEGER REFERENCES payrolls(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE staff_job_earnings ADD COLUMN IF NOT EXISTS service_booking_id INTEGER`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staff_job_earnings_payroll_id ON staff_job_earnings(payroll_id)`);

    // ── Task #458: Lịch thuê outfit & usageCount ─────────────────────────────
    // Bảng junction booking ↔ outfit (dress). Mỗi row = 1 outfit được gắn với
    // 1 booking kèm ngày lấy / trả và trạng thái.
    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_dresses (
        id           serial PRIMARY KEY,
        booking_id   integer NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        dress_id     integer NOT NULL REFERENCES dresses(id) ON DELETE CASCADE,
        outfit_code  text NOT NULL DEFAULT '',
        outfit_name  text NOT NULL DEFAULT '',
        outfit_image text,
        category     text,
        size         text,
        rental_price numeric(12,2) NOT NULL DEFAULT 0,
        pickup_date  date NOT NULL,
        return_date  date NOT NULL,
        status       text NOT NULL DEFAULT 'reserved',
        note         text,
        created_at   timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_booking_dresses_booking_id ON booking_dresses(booking_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_booking_dresses_dress_id   ON booking_dresses(dress_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_booking_dresses_return_date ON booking_dresses(return_date)`);
    // Cột usage_count trên dresses: đếm số lượt outfit đã được trả (status='returned').
    // Trigger-free: tăng/giảm thủ công trong booking-dresses route khi status thay đổi.
    await client.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS usage_count integer NOT NULL DEFAULT 0`);
    // ── End Task #458 ─────────────────────────────────────────────────────────

    // ── Task #483: Phụ cấp linh hoạt theo show (per-show staff allowances) ──
    // Cộng thêm vào lương nhân sự trong kỳ tính lương. Không ảnh hưởng doanh
    // thu / lợi nhuận booking.
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_allowances (
        id            serial PRIMARY KEY,
        booking_id    integer NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        staff_id      integer NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        allowance_type text NOT NULL,
        amount        numeric(12,2) NOT NULL DEFAULT 0,
        note          text,
        created_by    integer REFERENCES staff(id),
        created_at    timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staff_allowances_booking ON staff_allowances(booking_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staff_allowances_staff   ON staff_allowances(staff_id)`);
    // ── End Task #483 ─────────────────────────────────────────────────────────

    // ── Task #487: inline per-staff-row allowances ───────────────────────────
    // Thêm role + service_booking_id (nullable, backward-compat) để allowance gắn
    // đúng dòng nhân sự trong UI. Filter chính là (booking_id, staff_id, role).
    await client.query(`ALTER TABLE staff_allowances ADD COLUMN IF NOT EXISTS role text`);
    await client.query(`ALTER TABLE staff_allowances ADD COLUMN IF NOT EXISTS service_booking_id integer`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staff_allowances_b_s_r ON staff_allowances(booking_id, staff_id, role)`);
    // ── End Task #487 ─────────────────────────────────────────────────────────

    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS additional_services jsonb NOT NULL DEFAULT '[]'::jsonb`);

    // ── Thùng rác Booking (soft-delete) ───────────────────────────────────────
    // deleted_at != null = booking trong thùng rác. Index để query active/trash nhanh.
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deleted_at timestamp`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deleted_by integer`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delete_reason text`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_deleted_at ON bookings(deleted_at)`);

    // ── CMS Cho thuê đồ: Ưu tiên hiển thị + Giá giảm ────────────────────────
    // is_priority/priority_at: sản phẩm hot ghim lên đầu danh sách (CMS + web public).
    // sale_price: giá giảm hiển thị kèm giá gốc gạch ngang (null/0 = không giảm).
    await client.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS is_priority boolean NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS priority_at timestamp`);
    await client.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS sale_price numeric`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dresses_priority ON dresses(is_priority, priority_at DESC NULLS LAST)`);

    // ── Module "Ý tưởng chụp ảnh" (photo ideas) ─────────────────────────────
    // Concept/dáng chụp mẫu cho khách tham khảo — bảo vệ bằng mật khẩu (24h).
    // extra_images: JSON array đường dẫn ảnh. Tương lai mở rộng albums (ảnh + video)
    // sẽ thêm bảng photo_idea_albums tham chiếu idea_id — schema hiện tại không cản trở.
    await client.query(`
      CREATE TABLE IF NOT EXISTS photo_ideas (
        id                serial PRIMARY KEY,
        name              text NOT NULL,
        slug              text,
        category_id       integer,
        description       text,
        image_url         text,
        public_image_url  text,
        cover_image_url   text,
        extra_images      text,
        tags_text         text,
        visibility_status text NOT NULL DEFAULT 'public',
        execution_status  text NOT NULL DEFAULT 'available',
        sort_order        integer NOT NULL DEFAULT 0,
        created_at        timestamp NOT NULL DEFAULT now(),
        deleted_at        timestamp
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_photo_ideas_category ON photo_ideas(category_id)`);

    // Key-value settings dùng chung (mật khẩu xem Ý tưởng chụp ảnh, có thể đổi trong CMS).
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        text PRIMARY KEY,
        value      text,
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      INSERT INTO app_settings (key, value) VALUES
        ('photo_ideas_password', '999999'),
        ('photo_ideas_password_enabled', '1')
      ON CONFLICT (key) DO NOTHING
    `);

    // ── Ngày thực hiện PHỤ của booking (dịch vụ nhiều ngày) — additive, idempotent.
    // Ngày 1 vẫn là bookings.shoot_date; bảng này chỉ lưu ngày 2 trở đi, KHÔNG có
    // trường tiền (chống nhân đôi doanh thu/công nợ). Không sửa dữ liệu booking cũ.
    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_occurrences (
        id          serial PRIMARY KEY,
        booking_id  integer NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        shoot_date  date NOT NULL,
        shoot_time  text,
        label       text,
        sort_order  integer NOT NULL DEFAULT 0,
        created_at  timestamp NOT NULL DEFAULT now(),
        updated_at  timestamp
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_booking_occurrences_booking ON booking_occurrences(booking_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_booking_occurrences_date ON booking_occurrences(shoot_date)`);

    // ── Vòng đời thuê váy theo từng sản phẩm — thêm cột vào booking_dresses (additive,
    // idempotent). status mở rộng dùng chung cột text sẵn có (không đổi kiểu).
    // KHÔNG có cột tiền → không đụng doanh thu/công nợ. Không sửa dữ liệu cũ.
    await client.query(`ALTER TABLE booking_dresses ADD COLUMN IF NOT EXISTS actual_pickup_date date`);
    await client.query(`ALTER TABLE booking_dresses ADD COLUMN IF NOT EXISTS actual_return_date date`);
    await client.query(`ALTER TABLE booking_dresses ADD COLUMN IF NOT EXISTS preparation_note text`);
    await client.query(`ALTER TABLE booking_dresses ADD COLUMN IF NOT EXISTS return_note text`);
    await client.query(`ALTER TABLE booking_dresses ADD COLUMN IF NOT EXISTS damage_note text`);

    // ── Nút gạt "Thuê đồ" per gói (additive, idempotent): gói/nhóm CÓ CHO THUÊ
    // trang phục → mọi đơn dùng gói tự sinh nhắc soạn/lấy/trả đồ trên Lịch.
    // Thuần hiển thị chip cảnh báo — không đụng tiền/đơn/công nợ.
    await client.query(`ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS warn_upcoming_show boolean NOT NULL DEFAULT false`);

    // ── Setting nhắc lấy/trả đồ per booking (nullable = mặc định lấy trước 3
    // ngày, trả sau 2 ngày). Thuần lịch nhắc — không có trường tiền nào.
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dress_warn_pickup_days integer`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dress_warn_return_days integer`);

    await client.query("COMMIT");
    console.log("[migrations] Hoàn thành.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[migrations] Lỗi:", err);
    throw err;
  } finally {
    client.release();
  }

  // Hotfix: đảm bảo cột requires_printing tồn tại kể cả khi transaction cũ đã commit
  try {
    await pool.query(`ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS requires_printing BOOLEAN NOT NULL DEFAULT false`);
    const { rows: seeded } = await pool.query(
      `SELECT 1 FROM settings WHERE key = 'requires_printing_seeded_v1' LIMIT 1`,
    );
    if (seeded.length === 0) {
      await pool.query(`
        UPDATE service_packages sp
           SET requires_printing = true
          FROM service_groups sg
         WHERE sp.group_id = sg.id
           AND UPPER(sg.name) IN ('ALBUM TẠI STUDIO', 'ALBUM NGOẠI CẢNH', 'IN ẢNH')
      `);
      await pool.query(`
        UPDATE service_packages SET requires_printing = true
         WHERE CAST(print_cost AS numeric) > 0
      `);
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('requires_printing_seeded_v1', '1') ON CONFLICT (key) DO NOTHING`,
      );
    }
    console.log("[migrations] requires_printing_hotfix_v1 OK");
  } catch (err) {
    console.error("[migrations] requires_printing_hotfix_v1:", err);
  }

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_facebook ON customers (facebook)`);

  // ── Hotfix prod: hàm immutable_unaccent dùng trong /customers search ─────────
  // Lý do: customers.ts gọi immutable_unaccent(...) nhưng prod DB chưa có hàm
  // này → tìm kiếm khách hàng 500. Tạo extension unaccent + wrapper IMMUTABLE
  // để dùng trong WHERE/INDEX. Nếu không thể tạo extension (quyền), fallback
  // sang LOWER() cho an toàn, không làm crash app.
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION immutable_unaccent(text)
      RETURNS text AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$
      LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT
    `);
  } catch (err) {
    console.warn("[migrations] unaccent extension không khả dụng, fallback LOWER():", err);
    await pool.query(`
      CREATE OR REPLACE FUNCTION immutable_unaccent(text)
      RETURNS text AS $$ SELECT LOWER($1) $$
      LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT
    `).catch((e) => console.error("[migrations] tạo immutable_unaccent fallback thất bại:", e));
  }

  // ── Module Claude Sale: bảng cấu hình + cờ lead (idempotent, an toàn) ─────────
  // KHÔNG đụng booking/khách hàng/CRM. Chỉ thêm 2 bảng riêng của chatbot.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS claude_sale_settings (
        id          INTEGER PRIMARY KEY DEFAULT 1,
        config      JSONB NOT NULL,
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_by  INTEGER,
        CONSTRAINT claude_sale_settings_singleton CHECK (id = 1)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS claude_sale_lead_flags (
        facebook_user_id      TEXT PRIMARY KEY,
        phone_captured        BOOLEAN NOT NULL DEFAULT false,
        phone_captured_at     TIMESTAMP,
        appointment_intent    BOOLEAN NOT NULL DEFAULT false,
        appointment_intent_at TIMESTAMP,
        needs_human           BOOLEAN NOT NULL DEFAULT false,
        escalation_reason     TEXT,
        escalated_at          TIMESTAMP,
        profile_sync_status   TEXT,
        profile_synced_at     TIMESTAMP,
        updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    // Bổ sung cột cho DB đã tạo bảng từ trước (idempotent).
    await pool.query(`ALTER TABLE claude_sale_lead_flags ADD COLUMN IF NOT EXISTS profile_sync_status TEXT`);
    await pool.query(`ALTER TABLE claude_sale_lead_flags ADD COLUMN IF NOT EXISTS profile_synced_at TIMESTAMP`);
    console.log("[migrations] Claude Sale: claude_sale_settings + claude_sale_lead_flags OK");
  } catch (err) {
    console.error("[migrations] Claude Sale tables:", err);
  }

  // ── Chương trình giảm giá theo NHÓM dịch vụ + theo GÓI riêng lẻ (module Bảng giá) ──
  // 7 cột discount_* trên CẢ service_groups (giảm cấp nhóm) lẫn service_packages
  // (giảm riêng gói). Ưu tiên giảm-gói > giảm-nhóm, KHÔNG cộng dồn — xem
  // resolveDiscount() ở lib/pricing-discount.ts. ADD COLUMN IF NOT EXISTS nên an toàn
  // chạy nhiều lần; KHÔNG đụng dữ liệu/giá hiện có.
  try {
    for (const tbl of ["service_groups", "service_packages"]) {
      await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS discount_enabled boolean NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS discount_type text`);
      await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS discount_value numeric(12,2)`);
      await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS discount_start_date timestamptz`);
      await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS discount_end_date timestamptz`);
      await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS discount_name text`);
      await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS discount_description text`);
    }
    console.log("[migrations] discount_* (service_groups + service_packages) OK");
  } catch (err) {
    console.error("[migrations] discount_* columns:", err);
  }

  // ── Giờ vàng (Golden Hour) — campaign giảm giá theo nhóm danh mục / sản phẩm ───
  // Bảng cấu hình riêng, KHÔNG đụng dresses/cms_categories, KHÔNG ghi đè giá gốc.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS golden_hour_campaigns (
        id          serial PRIMARY KEY,
        scope       text NOT NULL,              -- 'category' | 'dress'
        ref_id      integer NOT NULL,           -- cms_categories.id hoặc dresses.id
        name        text NOT NULL DEFAULT 'Giờ vàng',
        percent     numeric(5,2) NOT NULL DEFAULT 0,
        starts_at   timestamptz,
        ends_at     timestamptz,
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS golden_hour_campaigns_scope_ref_unique ON golden_hour_campaigns(scope, ref_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_golden_hour_active ON golden_hour_campaigns(is_active, starts_at, ends_at)`,
    );
    console.log("[migrations] golden_hour_campaigns OK");
  } catch (err) {
    console.error("[migrations] golden_hour_campaigns:", err);
  }

  // ── Hợp đồng online v2: link public bằng token + chữ ký Bên A + lịch sử sửa ────
  // public_token: 1 hợp đồng = 1 link cố định (không dùng id thô). signed_snapshot:
  // chụp các field quan trọng lúc khách ký để phát hiện "sửa sau khi ký" (CHỈ cảnh
  // báo nội bộ). resign_requested_at: admin chủ động bật yêu cầu khách ký lại.
  // contract_change_log: lịch sử chỉnh sửa NỘI BỘ (mirror booking_change_log).
  try {
    await pool.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS public_token text`);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS contracts_public_token_unique ON contracts(public_token) WHERE public_token IS NOT NULL`,
    );
    await pool.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS studio_signature_image_url text`);
    await pool.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS studio_signed_at timestamp`);
    await pool.query(
      `ALTER TABLE contracts ADD COLUMN IF NOT EXISTS studio_signed_by_id integer REFERENCES staff(id) ON DELETE SET NULL`,
    );
    await pool.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS signed_snapshot jsonb`);
    await pool.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS resign_requested_at timestamp`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contract_change_log (
        id            serial PRIMARY KEY,
        contract_id   integer NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        field_changed text NOT NULL,
        old_value     text,
        new_value     text,
        reason        text,
        changed_by_id integer REFERENCES staff(id) ON DELETE SET NULL,
        created_at    timestamp NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_contract_change_log_contract ON contract_change_log(contract_id, created_at DESC)`,
    );
    console.log("[migrations] contracts online-sign v2 OK");
  } catch (err) {
    console.error("[migrations] contracts online-sign v2:", err);
  }
}

async function runMigrations() {
  // Toàn bộ DDL startup (migrations này + các ensure*Schema trong routes/) đi qua
  // withStartupDdlLock: tắt được bằng SKIP_STARTUP_MIGRATIONS=1 khi deploy, và
  // tuần tự hoá giữa các instance Autoscale để hết "deadlock detected" lúc Promote.
  await withStartupDdlLock(runMigrationsUnlocked);
}

export default runMigrations;
