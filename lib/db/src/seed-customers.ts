import { db, pool } from "./index";
import { sql } from "drizzle-orm";

async function seedCustomers() {
  console.log("🌱 Bắt đầu seed khách hàng mẫu...");

  const customers = [
    {
      customCode: "KH001",
      name: "Nguyễn Thị Hồng",
      phone: "0901111001",
      email: "hong.nguyen@gmail.com",
      facebook: "fb.com/nguyenthihong",
      zalo: "0901111001",
      gender: "female",
      source: "facebook",
      tags: ["cô dâu", "vip"],
      notes: "Khách VIP, chụp cưới tháng 6",
    },
    {
      customCode: "KH002",
      name: "Trần Văn Bình",
      phone: "0912222002",
      email: "binh.tran@gmail.com",
      gender: "male",
      source: "referral",
      tags: ["gia đình", "returning"],
      notes: "Được giới thiệu bởi chị Lan",
    },
    {
      customCode: "KH003",
      name: "Lê Thị Mai",
      phone: "0923333003",
      email: "mai.le@gmail.com",
      facebook: "fb.com/lethimai",
      gender: "female",
      source: "walk-in",
      tags: ["sơ sinh", "new"],
      notes: "Muốn chụp ảnh bé mới sinh",
    },
    {
      customCode: "KH004",
      name: "Phạm Quốc Hùng",
      phone: "0934444004",
      gender: "male",
      source: "facebook",
      tags: ["cô dâu", "new"],
      notes: "Hỏi về gói chụp cưới ngoại cảnh",
    },
    {
      customCode: "KH005",
      name: "Vũ Thị Lan Anh",
      phone: "0945555005",
      email: "lananh.vu@gmail.com",
      zalo: "0945555005",
      gender: "female",
      source: "referral",
      tags: ["gia đình", "potential"],
      notes: "Quan tâm gói chụp gia đình cuối năm",
    },
    {
      customCode: "KH006",
      name: "Đặng Minh Khôi",
      phone: "0956666006",
      facebook: "fb.com/dangminhkhoi",
      gender: "male",
      source: "walk-in",
      tags: ["cô dâu", "converted"],
      notes: "Đã đặt cọc gói cưới cao cấp",
    },
    {
      customCode: "KH007",
      name: "Bùi Thị Thanh Hà",
      phone: "0967777007",
      email: "thanhha.bui@gmail.com",
      facebook: "fb.com/buithithanhha",
      zalo: "0967777007",
      gender: "female",
      source: "facebook",
      tags: ["sơ sinh", "vip"],
      notes: "Khách thân thiết, đã chụp 3 lần",
    },
    {
      customCode: "KH008",
      name: "Hoàng Văn Tú",
      phone: "0978888008",
      gender: "male",
      source: "other",
      tags: ["gia đình", "new"],
      notes: "Liên hệ qua Zalo",
    },
    {
      customCode: "KH009",
      name: "Ngô Thị Phương",
      phone: "0989999009",
      email: "phuong.ngo@gmail.com",
      facebook: "fb.com/ngothiphuong",
      gender: "female",
      source: "referral",
      tags: ["cô dâu", "potential"],
      notes: "Hỏi giá gói pre-wedding",
    },
    {
      customCode: "KH010",
      name: "Đinh Công Sơn",
      phone: "0990000010",
      email: "son.dinh@gmail.com",
      gender: "male",
      source: "walk-in",
      tags: ["gia đình", "returning"],
      notes: "Khách cũ, muốn chụp ảnh gia đình dịp Tết",
    },
  ];

  const result = await db.execute(sql`
    INSERT INTO customers (custom_code, name, phone, email, facebook, zalo, gender, source, tags, notes)
    VALUES
      ${sql.join(
        customers.map(
          (c) => sql`(
            ${c.customCode},
            ${c.name},
            ${c.phone},
            ${c.email ?? null},
            ${c.facebook ?? null},
            ${c.zalo ?? null},
            ${c.gender},
            ${c.source},
            ${JSON.stringify(c.tags)}::jsonb,
            ${c.notes ?? null}
          )`
        ),
        sql`, `
      )}
    ON CONFLICT (phone) DO NOTHING
  `);

  console.log(`✅ Đã seed khách hàng mẫu (bỏ qua nếu đã tồn tại theo số điện thoại)`);
  console.log("🎉 Hoàn tất seed khách hàng!");

  await pool.end();
}

seedCustomers().catch((e) => {
  console.error("❌ Lỗi:", e);
  process.exit(1);
});
