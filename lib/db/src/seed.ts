import { db, pool } from "./index";
import {
  customersTable, bookingsTable, staffTable, tasksTable, paymentsTable,
  servicesTable, quotesTable, transactionsTable, expensesTable,
  contractsTable, payrollsTable
} from "./schema";
import { sql } from "drizzle-orm";

async function seed() {
  console.log("🌱 Bắt đầu tạo dữ liệu mẫu...");

  await db.execute(sql`TRUNCATE payrolls, contracts, expenses, tasks, payments, bookings, quotes, customers, staff, services, transactions RESTART IDENTITY CASCADE`);

  // STAFF
  const [staff1] = await db.insert(staffTable).values({ name: "Nguyễn Văn Minh", phone: "0901234567", role: "photographer", email: "minh@studio.vn", salary: "8000000", salaryType: "fixed", joinDate: "2022-01-15", isActive: 1, notes: "Nhiếp ảnh gia chính" }).returning();
  const [staff2] = await db.insert(staffTable).values({ name: "Trần Thị Lan", phone: "0912345678", role: "editor", email: "lan@studio.vn", salary: "7000000", salaryType: "fixed", joinDate: "2022-03-20", isActive: 1, notes: "Biên tập viên" }).returning();
  const [staff3] = await db.insert(staffTable).values({ name: "Lê Văn Hùng", phone: "0923456789", role: "makeup", email: "hung@studio.vn", salary: "0", salaryType: "per_show", commissionRate: "15", joinDate: "2023-06-01", isActive: 1, notes: "Makeup artist" }).returning();
  const [staff4] = await db.insert(staffTable).values({ name: "Phạm Thị Mai", phone: "0934567890", role: "sale", email: "mai@studio.vn", salary: "5000000", salaryType: "commission", commissionRate: "5", joinDate: "2023-01-10", isActive: 1, notes: "Nhân viên sale" }).returning();
  const [staff5] = await db.insert(staffTable).values({ name: "Võ Minh Tuấn", phone: "0945678901", role: "photographer", email: "tuan@studio.vn", salary: "9000000", salaryType: "fixed", joinDate: "2021-08-01", isActive: 1, notes: "Nhiếp ảnh gia cao cấp" }).returning();

  console.log("✅ Tạo xong 5 nhân viên");

  // CUSTOMERS
  const customers = await db.insert(customersTable).values([
    { customCode: "KH001", name: "Hoàng Văn An", phone: "0901111222", email: "an@gmail.com", facebook: "fb.com/hoangvanan", zalo: "0901111222", source: "facebook", tags: ["vip", "new"], gender: "male", notes: "Khách VIP, hay giới thiệu bạn bè" },
    { customCode: "KH002", name: "Nguyễn Thị Lan", phone: "0912222333", email: "lan@gmail.com", facebook: "fb.com/nguyenthilan", source: "tiktok", tags: ["new", "potential"], gender: "female", notes: "Khách từ TikTok" },
    { customCode: "KH003", name: "Trần Văn Minh", phone: "0923333444", facebook: "fb.com/tranvanminh", source: "referral", tags: ["returning"], gender: "male", notes: "Khách cũ, đã chụp 2 lần" },
    { customCode: "KH004", name: "Lê Thị Hoa", phone: "0934444555", email: "hoa@gmail.com", source: "direct", tags: ["converted"], gender: "female" },
    { customCode: "KH005", name: "Phạm Văn Đức", phone: "0945555666", facebook: "fb.com/phamvanduc", source: "facebook", tags: ["new"], gender: "male" },
    { customCode: "KH006", name: "Vũ Thị Thu", phone: "0956666777", email: "thu@gmail.com", facebook: "fb.com/vuthithu", source: "instagram", tags: ["vip", "converted"], gender: "female", notes: "Khách VIP, chụp trọn gói" },
    { customCode: "KH007", name: "Đặng Văn Long", phone: "0967777888", source: "referral", tags: ["returning", "potential"], gender: "male" },
    { customCode: "KH008", name: "Bùi Thị Kim", phone: "0978888999", email: "kim@gmail.com", source: "tiktok", tags: ["new"], gender: "female" },
    { customCode: "KH009", name: "Đỗ Minh Khoa", phone: "0989999000", facebook: "fb.com/dominhkhoa", source: "facebook", tags: ["potential"], gender: "male" },
    { customCode: "KH010", name: "Ngô Thị Linh", phone: "0990000111", email: "linh@gmail.com", source: "returning", tags: ["vip", "returning"], gender: "female", notes: "Khách thân thiết 3 năm" },
  ]).returning();

  console.log("✅ Tạo xong 10 khách hàng");

  // SERVICES
  const services = await db.insert(servicesTable).values([
    { name: "Chụp ảnh cưới trọn ngày", code: "SV001", category: "wedding", price: "8000000", costPrice: "3000000", description: "Gói chụp cưới cả ngày, 2 nhiếp ảnh gia", isActive: 1 },
    { name: "Chụp beauty studio", code: "SV002", category: "beauty", price: "2500000", costPrice: "800000", description: "Chụp studio cá nhân", isActive: 1 },
    { name: "Chụp gia đình", code: "SV003", category: "family", price: "3500000", costPrice: "1200000", description: "Gói chụp gia đình 2h", isActive: 1 },
    { name: "Chụp pre-wedding", code: "SV004", category: "wedding", price: "5000000", costPrice: "2000000", description: "Chụp ngoại cảnh trước đám cưới", isActive: 1 },
    { name: "Makeup cô dâu", code: "SV005", category: "makeup", price: "1500000", costPrice: "500000", description: "Makeup chuyên nghiệp cho cô dâu", isActive: 1 },
    { name: "Album in cao cấp", code: "SV006", category: "album", price: "3000000", costPrice: "1500000", description: "Album 30x40 in cao cấp 60 trang", isActive: 1 },
  ]).returning();

  console.log("✅ Tạo xong 6 dịch vụ");

  const today = new Date();
  const d = (offset: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() + offset);
    return date.toISOString().split("T")[0];
  };

  // BOOKINGS
  const bookings = await db.insert(bookingsTable).values([
    { orderCode: "DH0001", customerId: customers[0].id, shootDate: d(2), shootTime: "08:00", serviceCategory: "wedding", packageType: "Gói VIP", location: "Nhà thờ Đức Bà, TP.HCM", status: "confirmed", totalAmount: "25000000", depositAmount: "10000000", paidAmount: "10000000", discountAmount: "2000000", items: [{ name: "Chụp cưới trọn ngày", qty: 1, unitPrice: 8000000, total: 8000000 }, { name: "Pre-wedding", qty: 1, unitPrice: 5000000, total: 5000000 }, { name: "Makeup cô dâu", qty: 2, unitPrice: 1500000, total: 3000000 }, { name: "Album cao cấp", qty: 2, unitPrice: 3000000, total: 6000000 }, { name: "Trang trí", qty: 1, unitPrice: 3000000, total: 3000000 }], assignedStaff: [staff1.id, staff3.id], notes: "Đám cưới ở nhà thờ, ánh sáng tự nhiên", internalNotes: "Khách VIP - ưu tiên" },
    { orderCode: "DH0002", customerId: customers[1].id, shootDate: d(6), shootTime: "09:00", serviceCategory: "wedding", packageType: "Gói VIP", location: "Vinhomes Central Park", status: "confirmed", totalAmount: "18000000", depositAmount: "8000000", paidAmount: "8000000", discountAmount: "0", items: [{ name: "Chụp cưới", qty: 1, unitPrice: 8000000, total: 8000000 }, { name: "Makeup", qty: 1, unitPrice: 1500000, total: 1500000 }, { name: "Album", qty: 1, unitPrice: 3000000, total: 3000000 }, { name: "Phụ phí", qty: 1, unitPrice: 5500000, total: 5500000 }], assignedStaff: [staff5.id, staff3.id], notes: "" },
    { orderCode: "DH0003", customerId: customers[2].id, shootDate: d(13), shootTime: "07:30", serviceCategory: "wedding", packageType: "Gói Nâng Cao", location: "Đà Lạt", status: "confirmed", totalAmount: "35000000", depositAmount: "15000000", paidAmount: "15000000", discountAmount: "0", items: [{ name: "Chụp cưới trọn ngày", qty: 1, unitPrice: 8000000, total: 8000000 }, { name: "Pre-wedding Đà Lạt", qty: 1, unitPrice: 15000000, total: 15000000 }, { name: "Makeup", qty: 2, unitPrice: 1500000, total: 3000000 }, { name: "Album VIP", qty: 2, unitPrice: 4500000, total: 9000000 }], assignedStaff: [staff1.id, staff2.id, staff3.id] },
    { orderCode: "DH0004", customerId: customers[3].id, shootDate: d(-7), shootTime: "14:00", serviceCategory: "beauty", packageType: "Chụp Beauty", location: "Studio", status: "completed", totalAmount: "2500000", depositAmount: "1000000", paidAmount: "2500000", discountAmount: "0", items: [{ name: "Chụp beauty studio", qty: 1, unitPrice: 2500000, total: 2500000 }], assignedStaff: [staff2.id] },
    { orderCode: "DH0005", customerId: customers[4].id, shootDate: d(-14), shootTime: "10:00", serviceCategory: "family", packageType: "Chụp Gia Đình", location: "Công viên Tao Đàn", status: "completed", totalAmount: "3500000", depositAmount: "1500000", paidAmount: "3500000", discountAmount: "500000", items: [{ name: "Chụp gia đình", qty: 1, unitPrice: 3500000, total: 3500000 }], assignedStaff: [staff1.id] },
    { orderCode: "DH0006", customerId: customers[5].id, shootDate: d(20), shootTime: "08:00", serviceCategory: "wedding", packageType: "Gói Premium", location: "Bình Dương", status: "pending", totalAmount: "20000000", depositAmount: "5000000", paidAmount: "5000000", discountAmount: "0", items: [], assignedStaff: [] },
    { orderCode: "DH0007", customerId: customers[6].id, shootDate: d(-30), shootTime: "09:00", serviceCategory: "wedding", packageType: "Gói VIP", status: "completed", totalAmount: "28000000", depositAmount: "12000000", paidAmount: "28000000", discountAmount: "0", items: [], assignedStaff: [staff1.id, staff3.id] },
    { orderCode: "DH0008", customerId: customers[7].id, shootDate: d(35), shootTime: "08:30", serviceCategory: "wedding", packageType: "Gói Cơ Bản", location: "Biên Hoà", status: "pending", totalAmount: "12000000", depositAmount: "3000000", paidAmount: "3000000", discountAmount: "0", items: [], assignedStaff: [] },
    { orderCode: "DH0009", customerId: customers[8].id, shootDate: d(-5), shootTime: "15:00", serviceCategory: "beauty", packageType: "Beauty Studio", status: "in_progress", totalAmount: "2500000", depositAmount: "1000000", paidAmount: "1500000", discountAmount: "0", items: [], assignedStaff: [staff2.id] },
    { orderCode: "DH0010", customerId: customers[9].id, shootDate: d(45), shootTime: "09:00", serviceCategory: "wedding", packageType: "Gói VIP+", location: "Hội An", status: "pending", totalAmount: "45000000", depositAmount: "20000000", paidAmount: "20000000", discountAmount: "5000000", items: [], assignedStaff: [] },
    { orderCode: "DH0011", customerId: customers[0].id, shootDate: d(-60), shootTime: "08:00", serviceCategory: "wedding", packageType: "Gói Chuẩn", status: "completed", totalAmount: "15000000", depositAmount: "6000000", paidAmount: "15000000", discountAmount: "0", items: [], assignedStaff: [staff1.id] },
    { orderCode: "DH0012", customerId: customers[2].id, shootDate: d(-45), shootTime: "10:00", serviceCategory: "family", packageType: "Gia Đình", status: "completed", totalAmount: "3500000", depositAmount: "1500000", paidAmount: "3500000", discountAmount: "0", items: [], assignedStaff: [staff2.id] },
    { orderCode: "DH0013", customerId: customers[1].id, shootDate: d(-20), shootTime: "08:00", serviceCategory: "beauty", packageType: "Beauty+", status: "completed", totalAmount: "4000000", depositAmount: "2000000", paidAmount: "4000000", discountAmount: "0", items: [], assignedStaff: [staff2.id] },
    { orderCode: "DH0014", customerId: customers[4].id, shootDate: d(60), shootTime: "07:00", serviceCategory: "wedding", packageType: "Gói Premium", status: "confirmed", totalAmount: "22000000", depositAmount: "10000000", paidAmount: "10000000", discountAmount: "2000000", items: [], assignedStaff: [staff5.id] },
    { orderCode: "DH0015", customerId: customers[6].id, shootDate: d(-90), shootTime: "09:00", serviceCategory: "wedding", packageType: "Gói VIP", status: "completed", totalAmount: "30000000", depositAmount: "15000000", paidAmount: "30000000", discountAmount: "0", items: [], assignedStaff: [staff1.id, staff3.id] },
  ]).returning();

  console.log("✅ Tạo xong 15 đơn hàng");

  // PAYMENTS
  await db.insert(paymentsTable).values([
    { bookingId: bookings[0].id, amount: "10000000", paymentMethod: "transfer", paymentType: "deposit", notes: "Cọc ban đầu" },
    { bookingId: bookings[1].id, amount: "8000000", paymentMethod: "transfer", paymentType: "deposit", notes: "Tiền cọc" },
    { bookingId: bookings[2].id, amount: "15000000", paymentMethod: "transfer", paymentType: "deposit", notes: "Cọc đặt lịch" },
    { bookingId: bookings[3].id, amount: "1000000", paymentMethod: "cash", paymentType: "deposit", notes: "Cọc" },
    { bookingId: bookings[3].id, amount: "1500000", paymentMethod: "transfer", paymentType: "payment", notes: "Thanh toán còn lại" },
    { bookingId: bookings[4].id, amount: "1500000", paymentMethod: "cash", paymentType: "deposit", notes: "Cọc" },
    { bookingId: bookings[4].id, amount: "2000000", paymentMethod: "transfer", paymentType: "payment", notes: "Thanh toán phần còn lại" },
    { bookingId: bookings[5].id, amount: "5000000", paymentMethod: "transfer", paymentType: "deposit", notes: "Tiền cọc" },
    { bookingId: bookings[6].id, amount: "12000000", paymentMethod: "transfer", paymentType: "deposit", notes: "Cọc" },
    { bookingId: bookings[6].id, amount: "16000000", paymentMethod: "transfer", paymentType: "payment", notes: "Thanh toán đủ" },
    { bookingId: bookings[8].id, amount: "1000000", paymentMethod: "cash", paymentType: "deposit", notes: "Cọc" },
    { bookingId: bookings[8].id, amount: "500000", paymentMethod: "transfer", paymentType: "partial", notes: "Thanh toán một phần" },
    { bookingId: bookings[9].id, amount: "20000000", paymentMethod: "transfer", paymentType: "deposit", notes: "Cọc VIP" },
    { bookingId: bookings[10].id, amount: "15000000", paymentMethod: "transfer", paymentType: "full", notes: "Thanh toán đầy đủ" },
    { bookingId: bookings[14].id, amount: "30000000", paymentMethod: "transfer", paymentType: "full", notes: "Thanh toán trọn gói" },
  ]);

  console.log("✅ Tạo xong 15 khoản thanh toán");

  // TASKS
  await db.insert(tasksTable).values([
    { title: "Chụp ảnh đám cưới Hoàng Văn An", category: "shooting", assigneeId: staff1.id, bookingId: bookings[0].id, priority: "high", status: "todo", dueDate: d(2), notes: "Địa điểm: Nhà thờ Đức Bà" },
    { title: "Makeup cô dâu - Hoàng Văn An", category: "makeup", assigneeId: staff3.id, bookingId: bookings[0].id, priority: "high", status: "todo", dueDate: d(2) },
    { title: "Chỉnh sửa ảnh DH0001", category: "editing", assigneeId: staff2.id, bookingId: bookings[0].id, priority: "medium", status: "todo", dueDate: d(9) },
    { title: "Chụp ảnh cưới Nguyễn Thị Lan", category: "shooting", assigneeId: staff5.id, bookingId: bookings[1].id, priority: "high", status: "todo", dueDate: d(6) },
    { title: "Makeup cô dâu - Nguyễn Thị Lan", category: "makeup", assigneeId: staff3.id, bookingId: bookings[1].id, priority: "high", status: "todo", dueDate: d(6) },
    { title: "Chỉnh sửa ảnh DH0002", category: "editing", assigneeId: staff2.id, bookingId: bookings[1].id, priority: "medium", status: "todo", dueDate: d(13) },
    { title: "Chụp pre-wedding Đà Lạt", category: "shooting", assigneeId: staff1.id, bookingId: bookings[2].id, priority: "high", status: "todo", dueDate: d(13) },
    { title: "Gọi xác nhận lịch - Trần Văn Minh", category: "call_confirm", assigneeId: staff4.id, bookingId: bookings[2].id, priority: "high", status: "in_progress", dueDate: d(1) },
    { title: "Thiết kế album cưới DH0007", category: "album_design", assigneeId: staff2.id, bookingId: bookings[6].id, priority: "high", status: "in_progress", dueDate: d(3) },
    { title: "In và đóng album DH0007", category: "printing", assigneeId: staff2.id, bookingId: bookings[6].id, priority: "medium", status: "todo", dueDate: d(7) },
    { title: "Giao ảnh cho Đặng Văn Long", category: "delivery", assigneeId: staff4.id, bookingId: bookings[6].id, priority: "medium", status: "todo", dueDate: d(10) },
    { title: "Báo giá cho Ngô Thị Linh (DH0010)", category: "other", assigneeId: staff4.id, bookingId: bookings[9].id, priority: "high", status: "todo", dueDate: d(1) },
    { title: "Chuẩn bị váy cô dâu DH0010", category: "prepare_dress", assigneeId: staff3.id, bookingId: bookings[9].id, priority: "medium", status: "todo", dueDate: d(40) },
    { title: "Chỉnh sửa ảnh beauty DH0009", category: "editing", assigneeId: staff2.id, bookingId: bookings[8].id, priority: "medium", status: "in_progress", dueDate: d(2) },
    { title: "Follow up khách hàng tiềm năng", category: "other", assigneeId: staff4.id, priority: "low", status: "todo", dueDate: d(3) },
    { title: "Cập nhật bảng giá mới Q2", category: "other", assigneeId: staff4.id, priority: "medium", status: "todo", dueDate: d(5) },
    { title: "Kiểm tra thiết bị máy ảnh", category: "other", assigneeId: staff1.id, priority: "high", status: "done", dueDate: d(-2), completedAt: new Date() },
    { title: "Xuất ảnh gốc cho khách DH0004", category: "delivery", assigneeId: staff2.id, bookingId: bookings[3].id, priority: "medium", status: "done", dueDate: d(-5), completedAt: new Date() },
    { title: "Gọi xác nhận lịch DH0001", category: "call_confirm", assigneeId: staff4.id, bookingId: bookings[0].id, priority: "high", status: "done", dueDate: d(-1), completedAt: new Date() },
    { title: "Làm hợp đồng DH0003 - Trần Văn Minh", category: "contract", assigneeId: staff4.id, bookingId: bookings[2].id, priority: "high", status: "in_progress", dueDate: d(2) },
  ]);

  console.log("✅ Tạo xong 20 tasks");

  // EXPENSES
  await db.insert(expensesTable).values([
    { type: "show_cost", category: "makeup", amount: "500000", description: "Chi phí makeup thuê ngoài DH0001", bookingId: bookings[0].id, paymentMethod: "cash", expenseDate: d(2), createdBy: "admin" },
    { type: "show_cost", category: "transport", amount: "300000", description: "Chi phí di chuyển DH0001", bookingId: bookings[0].id, paymentMethod: "cash", expenseDate: d(2), createdBy: "admin" },
    { type: "show_cost", category: "printing", amount: "1500000", description: "In album DH0007", bookingId: bookings[6].id, paymentMethod: "transfer", expenseDate: d(-5), createdBy: "admin" },
    { type: "show_cost", category: "transport", amount: "1200000", description: "Chi phí xe Đà Lạt DH0003", bookingId: bookings[2].id, paymentMethod: "cash", expenseDate: d(13), createdBy: "admin" },
    { type: "operational", category: "rent", amount: "15000000", description: "Tiền thuê mặt bằng tháng 3/2026", paymentMethod: "transfer", expenseDate: d(-25), createdBy: "admin" },
    { type: "operational", category: "utilities", amount: "2500000", description: "Tiền điện nước tháng 3/2026", paymentMethod: "cash", expenseDate: d(-20), createdBy: "admin" },
    { type: "operational", category: "advertising", amount: "5000000", description: "Chạy quảng cáo Facebook tháng 3", paymentMethod: "transfer", expenseDate: d(-15), createdBy: "admin" },
    { type: "operational", category: "equipment", amount: "3500000", description: "Mua đèn flash thêm", paymentMethod: "transfer", expenseDate: d(-10), createdBy: "admin" },
    { type: "show_cost", category: "food", amount: "400000", description: "Ăn uống ekip chụp DH0015", bookingId: bookings[14].id, paymentMethod: "cash", expenseDate: d(-90), createdBy: "admin" },
    { type: "operational", category: "other", amount: "1000000", description: "Mua vật tư văn phòng", paymentMethod: "cash", expenseDate: d(-8), createdBy: "admin" },
  ]);

  console.log("✅ Tạo xong 10 khoản chi phí");

  // QUOTES
  await db.insert(quotesTable).values([
    { customerId: customers[5].id, title: "Báo giá chụp cưới gói Premium", items: [{ name: "Chụp cưới trọn ngày", qty: 1, unitPrice: 8000000, total: 8000000 }, { name: "Makeup 2 lần", qty: 2, unitPrice: 1500000, total: 3000000 }, { name: "Album cao cấp", qty: 1, unitPrice: 5000000, total: 5000000 }], totalAmount: "16000000", discount: "1000000", finalAmount: "15000000", status: "sent", validUntil: d(30), notes: "Giảm 1 triệu cho khách thân thiết" },
    { customerId: customers[7].id, title: "Báo giá chụp cưới cơ bản", items: [{ name: "Chụp cưới 4h", qty: 1, unitPrice: 5000000, total: 5000000 }, { name: "Makeup 1 lần", qty: 1, unitPrice: 1500000, total: 1500000 }], totalAmount: "6500000", discount: "0", finalAmount: "6500000", status: "draft", validUntil: d(15), notes: "" },
    { customerId: customers[0].id, title: "Báo giá chụp gia đình", items: [{ name: "Chụp gia đình ngoại cảnh", qty: 1, unitPrice: 3500000, total: 3500000 }], totalAmount: "3500000", discount: "500000", finalAmount: "3000000", status: "approved", validUntil: d(7) },
  ]);

  // CONTRACTS
  await db.insert(contractsTable).values([
    {
      contractCode: "HD0001", bookingId: bookings[0].id, customerId: customers[0].id,
      title: "Hợp đồng chụp ảnh cưới - Hoàng Văn An",
      content: `HỢP ĐỒNG DỊCH VỤ CHỤP ẢNH CƯỚI

Bên A: AMAZING STUDIO
Địa chỉ: 123 Nguyễn Huệ, Q.1, TP.HCM
Điện thoại: 0901234567

Bên B: Hoàng Văn An
Điện thoại: 0901111222

Nội dung dịch vụ: Gói chụp ảnh cưới VIP
Ngày chụp: ${d(2)}
Tổng giá trị hợp đồng: 25,000,000đ
Tiền cọc: 10,000,000đ
Còn lại: 15,000,000đ

Hai bên đồng ý thực hiện đúng các điều khoản trên.`,
      status: "signed", signedAt: d(-5)
    },
    {
      contractCode: "HD0002", bookingId: bookings[2].id, customerId: customers[2].id,
      title: "Hợp đồng chụp cưới Đà Lạt - Trần Văn Minh",
      content: "Hợp đồng chụp ảnh cưới tại Đà Lạt...",
      status: "draft",
    },
  ]);

  // PAYROLLS
  await db.insert(payrollsTable).values([
    { staffId: staff1.id, month: 2, year: 2026, baseSalary: "8000000", showBonus: "2000000", commission: "0", bonus: "500000", deductions: "0", advance: "1000000", netSalary: "9500000", status: "paid", notes: "Tháng 2/2026" },
    { staffId: staff2.id, month: 2, year: 2026, baseSalary: "7000000", showBonus: "0", commission: "0", bonus: "0", deductions: "0", advance: "0", netSalary: "7000000", status: "paid" },
    { staffId: staff4.id, month: 2, year: 2026, baseSalary: "5000000", showBonus: "0", commission: "1200000", bonus: "0", deductions: "0", advance: "0", netSalary: "6200000", status: "paid" },
  ]);

  // TRANSACTIONS
  await db.insert(transactionsTable).values([
    { type: "income", category: "booking", amount: "10000000", description: "Thu cọc đơn DH0001", paymentMethod: "transfer", transactionDate: d(-5) },
    { type: "income", category: "booking", amount: "8000000", description: "Thu cọc đơn DH0002", paymentMethod: "transfer", transactionDate: d(-8) },
    { type: "expense", category: "salary", amount: "22700000", description: "Lương nhân viên tháng 2/2026", paymentMethod: "transfer", transactionDate: d(-25) },
    { type: "expense", category: "rent", amount: "15000000", description: "Tiền thuê mặt bằng T3/2026", paymentMethod: "transfer", transactionDate: d(-25) },
    { type: "income", category: "booking", amount: "20000000", description: "Thu cọc DH0010 - Ngô Thị Linh VIP", paymentMethod: "transfer", transactionDate: d(-3) },
  ]);

  console.log("✅ Tạo xong quotes, contracts, payrolls, transactions");
  console.log("🎉 Hoàn tất tạo dữ liệu mẫu!");
  await pool.end();
}

seed().catch(e => { console.error("❌ Lỗi:", e); process.exit(1); });
