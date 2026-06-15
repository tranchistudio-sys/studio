# Workspace

## Overview
This project is a pnpm workspace monorepo using TypeScript, designed for "Amazing Studio," a wedding photography studio and wedding dress rental management system. Its purpose is to streamline operations, enhance customer management, and provide comprehensive tools for staff, bookings, inventory, and financial tracking. The system aims to offer an elegant, intuitive interface with robust backend capabilities to manage all aspects of the studio's business.

Key capabilities include:
- **Comprehensive Booking & Contract Management**: Handles single and multi-service contracts with detailed scheduling and staff assignments.
- **Customer Relationship Management (CRM)**: Full CRUD for customer data with unique phone number enforcement.
- **Inventory & Rental Management**: Manages wedding dress inventory and rental processes.
- **Staff & HR Management**: Includes staff profiles, attendance tracking with QR/GPS, leave requests, and a new package-based staff cast system for payroll.
- **Financial Tracking**: Manages payments, expenses, and provides detailed revenue insights. Revenue module (v2) calculates real profit = collected payments - staff cast costs - direct expenses - operating expenses. Supports monthly breakdown, custom date range filtering (Từ ngày → Đến ngày), and per-service category listing. **Recurring fixed costs** (mặt bằng, lương cứng, điện, internet…) are entered via the "Chi phí cố định" modal on the Revenue page (table `fixed_costs`, route `/api/fixed-costs`); active items are auto-added to operatingExpenses for every month in the filter window so realProfit reflects them without manual re-entry.
- **Object Storage for Media**: Integrates image uploads for concept images, staff avatars, and dress photos.
- **Real-time Analytics**: Dashboard with key performance indicators and upcoming events.
- **Post-production Workflow**: Tracks photoshop jobs with statuses, deadlines, and progress.
- **Realtime Notifications**: SSE-based push notifications with sound alerts. Bell icon in header shows unread count badge, dropdown with priority-colored items (urgent/high/warning/normal). Auto-emits on booking create/update/cancel, payment, photoshop job changes, staff assignment. Hourly deadline checker for overdue photoshop jobs. Sound toggle (localStorage). SSE reconnect with exponential backoff. Auth via Bearer token, ownership check on mark-read. **Web Push**: Service Worker (`sw.js`) + Web Push API (VAPID) gửi notification ra ngoài màn hình điện thoại kể cả khi không mở web. DB table `push_subscriptions` lưu device token per user. Nút "Bật Push" trong dropdown chuông. Auto-register khi login. Click notification mở đúng trang (calendar/payments/photoshop-jobs). Admin nhận tất cả, nhân viên chỉ nhận job mình.

## User Preferences

I prefer iterative development. I want to be asked before major architectural changes or significant feature removals are made. Use clear and concise language in all explanations. When making changes, please detail the impact on existing functionalities.

## System Architecture

The project is structured as a pnpm workspace monorepo.

**Frontend (`amazing-studio`)**:
-   **Technology**: React with Vite.
-   **UI/UX**: Features a Vietnamese language UI with an elegant rose, gold, and cream color scheme.
-   **Core Components**:
    -   **Authentication**: JWT-based login, token stored in `localStorage`, role-based access control (`admin`, `staff`). Default passwords are phone numbers for staff and "admin123" for the admin account. Passwords are bcryptjs hashed.
    -   **Calendar**: Google Calendar-style interface with Month, Week, Day, and Detail views. Bookings are color-coded by the **sale staff member** (assignedStaff.sale). `STAFF_PALETTE` of 10 colors (sky, indigo, violet, emerald, amber, rose, orange, slate, teal, pink) — Month chips use solid color; Day/Week cards use pastel. Admin can customize each staff's color via "Màu lịch" popover button in Month View header. Staff color legend appears in footer for staff with bookings in the current month. Staff colors persisted in `staff.color` column (DB). Optimistic UI updates on color change. Supports multi-service contracts where parent bookings are abstract and children bookings are displayed on the calendar. Includes a role toggle ("Admin/Nhân viên") for view customization.
    -   **Staff Management**: `StaffAvatar` component provides standardized display of staff with role-based colors and status dots. Staff profiles (`/staff/:id`) show basic info, monthly work, salary, job history, leave requests, and personal pricing. Access to profiles is role-dependent.
    -   **Pricing Catalog**: Manages service groups, packages, and surcharges. Service groups have unique icons and color themes. Supports inline editing of package details.
    -   **Object Storage Integration**: Custom image upload via presigned URLs for concept images, staff avatars, and dress photos.
    -   **SmartSearch**: Global search bar for bookings, debounced and linking to calendar entries.
    -   **Photoshop Jobs (Hậu kỳ)**: Module for tracking post-production work. Statuses: `chua_nhan`, `dang_pts`, `da_pts`, `da_fix`, `da_gui_in`, `xong_show`, `tam_hoan`. Features: 7-tab filter (Chưa xong, Của tôi, Chưa nhận, Đang PTS, Đã PTS, Tạm hoãn, Xong show), deadline urgency bars (fire/red/yellow/green), print management block (drive_link, print_notes, da_xuat_in checkbox + "Chưa in" badge on card), chi phí phát sinh (syncs to booking_items type="incident"), setQueryData immediate cache patch after PUT, progress formula: done/(total_photos+extra_photos_requested).
    -   **Attendance**: Full attendance module with QR code and GPS check-in/out, geofencing. Includes "My" tab for staff and "Admin" tab for overview, rules, and adjustments.
    -   **ServiceSearchBox**: Reusable component for selecting packages with live filtering and smart suggestions.
    -   **SurchargeEditor**: Reusable component for managing multi-line surcharges on bookings.
    -   **Báo giá tạm tính (`/quotes`)**: Module báo giá nháp dùng cho tham khảo, không chiếm lịch và không tính doanh thu. Form đầy đủ: khách (chọn có sẵn hoặc nhập SĐT/tên mới), 1 dịch vụ (gói hoặc tự nhập), phụ thu, giảm trừ (admin only — enforce cả FE + BE), giảm giá, ngày/giờ dự kiến, cọc tham khảo, ghi chú. Trạng thái: draft, sent, considering, converted, cancelled. POST/PUT chặn set `status=converted` thủ công (chỉ qua endpoint convert). Nút "Chuyển qua booking" gọi `POST /api/quotes/:id/convert-to-booking` (atomic + race-safe: dùng `db.transaction` + `SELECT ... FOR UPDATE` lock hàng + conditional update). Idempotent — 409 nếu đã chuyển, trả bookingId hiện có. Sau khi chuyển → quote.status="converted", convertedBookingId, convertedAt; tạo booking thật + payment cọc nếu có; điều hướng tới `/calendar?bookingId=N`. **QUAN TRỌNG (mapping tiền)**: `booking.totalAmount = quote.finalAmount` (đã trừ deductions + discount), `booking.discountAmount = 0` để tránh trừ discount 2 lần (vì công thức booking remaining = totalAmount − discountAmount − paidAmount). Internal notes của booking lưu lại total/deductions/discount gốc để truy vết. NOTE kỹ thuật: hiện tại `quotes.tsx` dùng QuoteForm riêng (single-service) thay vì tách `ShowFormPanel` từ `calendar.tsx` — rủi ro regression của 600-line component quá cao. Future refactor: tách BookingForm dùng chung khi cần thiết.
    -   **Sidebar đã bỏ "/contracts" ("Hóa đơn dịch vụ")** khỏi `ALL_NAV_ITEMS` (file & route vẫn còn để rollback nhanh nếu cần).

**Backend (`api-server`)**:
-   **Technology**: Express 5.
-   **Database Interaction**: Utilizes Drizzle ORM with PostgreSQL.
-   **API Design**: RESTful API structure with routes for customers, bookings, dresses, rentals, payments, staff, attendance, photoshop jobs, and storage.
-   **Data Validation**: Zod for schema validation.
-   **Architectural Decisions**:
    -   Atomic creation of parent and child bookings for multi-service contracts.
    -   Deletion of parent bookings cascades to children.
    -   Database-level unique constraints for critical fields like customer phone numbers and service group names.
    -   Object storage handled via Google Cloud Storage (GCS) client wrapper, with presigned URLs for secure uploads.
    -   New `staff_cast_rates` table for package-based staff cost calculation, superseding older `staff_rate_prices` for certain scenarios.
    -   Automated job earnings generation upon booking completion based on assigned staff and their rates.
    -   **Revenue routes (`/api/revenue/*`)**: tách thành thư mục `src/routes/revenue/` (helpers, data, monthly, by-service, warnings, custom-range, stats, by-period, by-sale). File `routes/revenue.ts` cũ giờ chỉ là re-export để giữ tương thích import. Build có thêm guard `scripts/check-duplicate-functions.mjs` chặn duplicate top-level declaration (root cause Task #366); `build.mjs` in banner đỏ rõ ràng khi fail.

**Shared Libraries (`lib/`)**:
-   **`api-spec`**: OpenAPI specification for API documentation and client generation.
-   **`api-client-react`**: Generated React Query hooks for API interaction.
-   **`api-zod`**: Generated Zod schemas from the OpenAPI spec for client-side validation.
-   **`db`**: Drizzle ORM schema and database connection setup. Manages schema definitions for customers, bookings, dresses, rentals, payments, staff, attendance, and photoshop jobs.
-   **Monorepo Tooling**: pnpm workspaces for managing dependencies and inter-package references.
-   **TypeScript**: Version 5.9, with composite projects extending a base `tsconfig.json`.

## External Dependencies

-   **Database**: PostgreSQL
-   **ORM**: Drizzle ORM
-   **Cloud Storage**: Google Cloud Storage (GCS) for object storage.
-   **API Client Generation**: Orval (uses OpenAPI spec)
-   **QR Code Scanning**: `jsQR` library
-   **Date Manipulation**: `date-fns`
-   **UI Libraries**: Recharts (charting), react-hook-form (form management), framer-motion (animations)