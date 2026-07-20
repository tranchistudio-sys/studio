/**
 * api-json.ts — đọc phản hồi API thành JSON một cách an toàn.
 *
 * Vì sao cần: nhiều endpoint trả 204 KHÔNG CÓ BODY khi thành công (ví dụ xoá
 * phiếu thu, xoá hợp đồng). Kiểu viết cũ `JSON.parse(await r.text())` sẽ VĂNG
 * ngay ở body rỗng, biến một lần xoá THÀNH CÔNG thành thông báo lỗi và màn hình
 * không tự làm mới — đúng nghịch đảo của thứ ta muốn.
 *
 * Thứ tự xử lý ở đây: body rỗng → xét r.ok trước; có body → parse rồi mới xét lỗi,
 * để lấy được câu lỗi tiếng Việt server gửi kèm.
 */
export function readApiJson(r: { ok: boolean; status: number }, text: string): unknown {
  // 204 / body rỗng: thành công thì trả null, thất bại thì báo theo mã.
  if (text.trim() === "") {
    if (r.ok) return null;
    throw new Error(httpMessage(r.status));
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Không phải JSON (trang lỗi HTML, proxy chặn…): báo theo mã, không ném rác ra UI.
    throw new Error(
      r.status === 404 ? "API chưa sẵn sàng — hãy restart server (port 3000)" : httpMessage(r.status),
    );
  }

  if (!r.ok) throw new Error((data as { error?: string })?.error || httpMessage(r.status));
  return data;
}

function httpMessage(status: number): string {
  if (status === 401) return "Phiên đăng nhập đã hết hạn — hãy đăng nhập lại";
  if (status === 403) return "Tài khoản không có quyền thực hiện việc này";
  return `Lỗi server (${status})`;
}
