import { pgTable, serial, integer, text, timestamp, boolean, real, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const photoshopJobsTable = pgTable("photoshop_jobs", {
  id: serial("id").primaryKey(),
  jobCode: text("job_code").notNull(),
  bookingId: integer("booking_id"),
  customerName: text("customer_name").notNull().default(""),
  customerPhone: text("customer_phone").default(""),
  serviceName: text("service_name").default(""),
  assignedStaffId: integer("assigned_staff_id"),
  assignedStaffName: text("assigned_staff_name").default(""),
  shootDate: text("shoot_date").default(""),
  receivedFileDate: text("received_file_date").default(""),
  internalDeadline: text("internal_deadline").default(""),
  customerDeadline: text("customer_deadline").default(""),
  deadlineSystem: text("deadline_system"),
  status: text("status").notNull().default("chua_nhan"),
  progressPercent: real("progress_percent").notNull().default(0),
  totalPhotos: integer("total_photos").default(0),
  donePhotos: integer("done_photos").default(0),
  notes: text("notes").default(""),
  photoshopNote: text("photoshop_note").default(""),
  extraRetouchPrice: integer("extra_retouch_price").default(0),
  extraPhotosRequested: integer("extra_photos_requested"),
  driveLink: text("drive_link").default(""),
  printNotes: text("print_notes").default(""),
  daXuatIn: boolean("da_xuat_in").notNull().default(false),
  chiPhiPhatSinh: integer("chi_phi_phat_sinh").default(0),
  moTaPhatSinh: text("mo_ta_phat_sinh").default(""),
  detailPhotosCount: integer("detail_photos_count").default(0),
  detailPhotosRate: integer("detail_photos_rate").default(12000),
  partyPhotosCount: integer("party_photos_count").default(0),
  partyPhotosRate: integer("party_photos_rate").default(1000),
  isActive: boolean("is_active").notNull().default(true),
  completedBy: integer("completed_by"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({
  bookingActiveUnique: uniqueIndex("photoshop_jobs_booking_active_unique")
    .on(t.bookingId)
    .where(sql`is_active = true`),
}));
