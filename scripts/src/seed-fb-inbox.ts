import { pool, db } from "@workspace/db";
import { crmLeadsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const TEST_LEADS = [
  {
    facebookUserId: "test_psid_001_nguyen_thi_lan",
    name: "Nguyễn Thị Lan",
    phone: "0901234561",
    status: "new",
    aiPerThreadEnabled: null as boolean | null,
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=lan&backgroundColor=b6e3f4",
    messages: [
      { direction: "incoming", message: "Cho mình hỏi studio chụp ảnh cưới giá bao nhiêu ạ?", createdAt: "2026-04-13T08:00:00Z" },
      { direction: "outgoing", message: "Dạ chào chị Lan! Studio Amazing hiện có nhiều gói chụp ảnh cưới. Bạn muốn xem gói nào ạ?", createdAt: "2026-04-13T08:02:00Z" },
      { direction: "incoming", message: "Mình muốn xem gói chụp ngoại cảnh ạ", createdAt: "2026-04-13T08:05:00Z" },
      { direction: "outgoing", message: "Gói ngoại cảnh của studio từ 8 triệu đến 20 triệu tùy địa điểm. Mình có thể tư vấn thêm không ạ?", createdAt: "2026-04-13T08:07:00Z" },
      { direction: "incoming", message: "Vậy gói 8 triệu bao gồm gì ạ?", createdAt: "2026-04-13T08:10:00Z" },
    ],
  },
  {
    facebookUserId: "test_psid_002_tran_van_minh",
    name: "Trần Văn Minh",
    phone: "0912345672",
    status: "chatting",
    aiPerThreadEnabled: true,
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=minh&backgroundColor=c0aede",
    messages: [
      { direction: "incoming", message: "Bên studio có còn lịch chụp tháng 5 không?", createdAt: "2026-04-12T10:00:00Z" },
      { direction: "outgoing", message: "Chào anh Minh! Tháng 5 studio còn một số slot cuối tuần. Anh dự định ngày nào ạ?", createdAt: "2026-04-12T10:02:00Z" },
      { direction: "incoming", message: "Mình muốn đặt ngày 18/5 được không?", createdAt: "2026-04-12T10:05:00Z" },
      { direction: "outgoing", message: "Ngày 18/5 là thứ 7, hiện còn 2 ca sáng (8h) và chiều (14h). Anh muốn ca nào ạ?", createdAt: "2026-04-12T10:08:00Z" },
      { direction: "incoming", message: "Cho mình ca sáng nhé. Cần đặt cọc bao nhiêu?", createdAt: "2026-04-12T10:10:00Z" },
    ],
  },
  {
    facebookUserId: "test_psid_003_le_thi_hoa",
    name: "Lê Thị Hoa",
    phone: "0923456783",
    status: "hot",
    aiPerThreadEnabled: false,
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=hoa&backgroundColor=ffdfbf",
    messages: [
      { direction: "incoming", message: "Ơi studio ơi mình cần chụp ảnh gấp cuối tuần này được không?", createdAt: "2026-04-13T09:30:00Z" },
      { direction: "outgoing", message: "Chào chị Hoa! Cuối tuần này (thứ 7 - CN) chúng mình còn slot. Chị muốn chụp loại ảnh gì ạ?", createdAt: "2026-04-13T09:32:00Z" },
      { direction: "incoming", message: "Chụp ảnh gia đình 4 người, studio nội thất thôi ạ", createdAt: "2026-04-13T09:35:00Z" },
      { direction: "outgoing", message: "Studio nội thất gói gia đình 4 người: 2.5 triệu/2h, bao gồm makeup và 50 ảnh đã edit. Chị xem thế nào ạ?", createdAt: "2026-04-13T09:38:00Z" },
      { direction: "incoming", message: "Ok, mình lấy ngay. Địa chỉ studio ở đâu ạ?", createdAt: "2026-04-13T09:40:00Z" },
    ],
  },
  {
    facebookUserId: "test_psid_004_pham_quoc_bao",
    name: "Phạm Quốc Bảo",
    phone: "0934567894",
    status: "lost",
    aiPerThreadEnabled: null as boolean | null,
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=bao&backgroundColor=d1f4e0",
    messages: [
      { direction: "incoming", message: "Studio có thể giảm giá không? Mình thấy chỗ khác rẻ hơn nhiều", createdAt: "2026-04-11T14:00:00Z" },
      { direction: "outgoing", message: "Chào anh Bảo! Studio luôn cam kết giá tốt nhất với chất lượng cao. Mình có thể cho anh xem portfolio để so sánh không?", createdAt: "2026-04-11T14:02:00Z" },
      { direction: "incoming", message: "Thôi mình đặt chỗ khác rồi, cảm ơn nhé", createdAt: "2026-04-11T14:30:00Z" },
      { direction: "outgoing", message: "Dạ anh ơi, chúc anh chụp được những bức ảnh đẹp! Nếu có dịp mình rất vui được phục vụ anh ạ.", createdAt: "2026-04-11T14:32:00Z" },
    ],
  },
  {
    facebookUserId: "test_psid_005_vo_thi_thu",
    name: "Võ Thị Thu",
    phone: "0945678905",
    status: "new",
    aiPerThreadEnabled: true,
    avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=thu&backgroundColor=ffd5dc",
    messages: [
      { direction: "incoming", message: "Cho mình hỏi chụp ảnh thẻ có nhận không?", createdAt: "2026-04-13T10:50:00Z" },
      { direction: "outgoing", message: "Dạ chào chị Thu! Studio có nhận chụp ảnh thẻ các loại: căn cước, hộ chiếu, visa... Giá 50-100k/set tùy size ạ.", createdAt: "2026-04-13T10:52:00Z" },
      { direction: "incoming", message: "Vậy làm trong ngày được không?", createdAt: "2026-04-13T10:55:00Z" },
    ],
  },
];

async function ensureFbInboxTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fb_inbox_messages (
      id SERIAL PRIMARY KEY,
      facebook_user_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
      message TEXT NOT NULL,
      sent_status TEXT NOT NULL DEFAULT 'received',
      ai_decision TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fb_inbox_user_created
    ON fb_inbox_messages (facebook_user_id, created_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_inbox_seed_unique
    ON fb_inbox_messages (facebook_user_id, direction, message, created_at)
  `);
}

async function seedLeads() {
  let inserted = 0;
  let skipped = 0;

  for (const lead of TEST_LEADS) {
    const existing = await db
      .select({ id: crmLeadsTable.id })
      .from(crmLeadsTable)
      .where(eq(crmLeadsTable.facebookUserId, lead.facebookUserId))
      .limit(1);

    if (existing.length > 0) {
      console.log(`  [SKIP] Lead đã tồn tại: ${lead.name} (${lead.facebookUserId})`);
      skipped++;
      continue;
    }

    const lastMsg = lead.messages[lead.messages.length - 1];
    await db.insert(crmLeadsTable).values({
      name: lead.name,
      phone: lead.phone,
      source: "facebook",
      facebookUserId: lead.facebookUserId,
      status: lead.status,
      avatarUrl: lead.avatarUrl,
      aiPerThreadEnabled: lead.aiPerThreadEnabled,
      lastMessage: lastMsg.message,
      lastMessageAt: new Date(lastMsg.createdAt),
    });

    console.log(`  [OK]   Đã thêm lead: ${lead.name} | status=${lead.status} | aiPerThread=${lead.aiPerThreadEnabled}`);
    inserted++;
  }

  console.log(`\nLeads: ${inserted} thêm mới, ${skipped} bỏ qua`);
}

async function seedMessages() {
  let inserted = 0;
  let skipped = 0;

  for (const lead of TEST_LEADS) {
    const psid = lead.facebookUserId;

    for (const msg of lead.messages) {
      const sentStatus = msg.direction === "incoming" ? "received" : "sent";
      const aiDecision = msg.direction === "outgoing" ? "manual_sent" : null;

      const result = await pool.query(
        `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (facebook_user_id, direction, message, created_at) DO NOTHING`,
        [psid, msg.direction, msg.message, sentStatus, aiDecision, msg.createdAt],
      );

      if ((result.rowCount ?? 0) > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }

    console.log(`  [MSG]  ${lead.name}: ${lead.messages.length} tin nhắn`);
  }

  console.log(`\nMessages: ${inserted} thêm mới, ${skipped} bỏ qua`);
}

async function main() {
  console.log("=== Seed FB Inbox Test Data ===\n");

  console.log("1. Đảm bảo bảng fb_inbox_messages tồn tại...");
  await ensureFbInboxTable();
  console.log("   Done\n");

  console.log("2. Seed crm_leads...");
  await seedLeads();

  console.log("\n3. Seed fb_inbox_messages...");
  await seedMessages();

  console.log("\n=== Hoàn thành! Truy cập /facebook-inbox-ai để kiểm tra. ===");
  await pool.end();
}

main().catch((err) => {
  console.error("Seed thất bại:", err);
  process.exit(1);
});
