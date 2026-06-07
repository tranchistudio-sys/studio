// File giữ lại để tương thích import cũ (`./revenue`, `./revenue.js`).
// Toàn bộ implementation đã được tách thành các module nhỏ trong thư mục `./revenue/`.
// Việc tách ngăn lỗi tái phát của Task #366: trước đây file này ~700 dòng,
// có 2 khai báo `getBookingDate`/`getPaymentDate` trùng tên ở top-level → esbuild
// fail im lặng, dist build ra dùng phiên bản sai → endpoint /api/revenue/by-sale
// không lọc theo from/to dù FE đã truyền đúng.
export { default } from "./revenue/index";
export { buildBySaleRows, type BySaleBooking, type BySaleRow } from "./revenue/by-sale";
