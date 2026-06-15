import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { contractsTable, customersTable, bookingsTable, notificationsTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import crypto from "node:crypto";
import { getPublicBaseUrl } from "../lib/publicUrl";

const router: IRouter = Router();

router.get("/contracts", async (req, res) => {
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  const bookingId = req.query.bookingId ? parseInt(req.query.bookingId as string) : undefined;
  const rows = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      bookingId: contractsTable.bookingId,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      totalValue: contractsTable.totalValue,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      notes: contractsTable.notes,
      createdAt: contractsTable.createdAt,
      bookingDeductions: bookingsTable.deductions,
      bookingSurcharges: bookingsTable.surcharges,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .leftJoin(bookingsTable, eq(contractsTable.bookingId, bookingsTable.id))
    .orderBy(desc(contractsTable.createdAt));

  let filtered = rows;
  if (customerId) filtered = filtered.filter(c => c.customerId === customerId);
  if (bookingId) filtered = filtered.filter(c => c.bookingId === bookingId);
  res.json(filtered);
});

router.post("/contracts", async (req, res) => {
  const { bookingId, customerId, title, content, status, signedAt, expiresAt, totalValue, notes } = req.body ?? {};
  const count = await db.select().from(contractsTable);
  const contractCode = `HD${String(count.length + 1).padStart(4, "0")}`;
  const [contract] = await db
    .insert(contractsTable)
    .values({ contractCode, bookingId: bookingId || null, customerId, title, content: content || "", status: status || "draft", signedAt: signedAt || null, expiresAt: expiresAt || null, totalValue: totalValue ? String(totalValue) : "0", notes })
    .returning();
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
  res.status(201).json({ ...contract, customerName: customer.name, customerPhone: customer.phone });
});

router.post("/contracts/:id/sign-link", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [row] = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .where(eq(contractsTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }

  const signUrl = `${getPublicBaseUrl()}/api/contracts/${id}/sign`;

  res.json({
    signUrl,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    contractCode: row.contractCode,
    title: row.title,
  });
});

router.get("/contracts/:id/sign", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [row] = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      content: contractsTable.content,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      totalValue: contractsTable.totalValue,
      notes: contractsTable.notes,
      signatureImageUrl: contractsTable.signatureImageUrl,
      signerName: contractsTable.signerName,
      signerPhone: contractsTable.signerPhone,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .where(eq(contractsTable.id, id));

  if (!row) {
    res.status(404).send("Không tìm thấy hợp đồng");
    return;
  }

  const alreadySigned = row.status === "signed";
  const signedTimeStr = row.signedAt ? new Date(row.signedAt).toLocaleString("vi-VN") : "";
  const sigImgUrl = row.signatureImageUrl ?? "";
  const sigName = row.signerName ?? row.customerName;
  const sigPhone = row.signerPhone ?? row.customerPhone ?? "";

  const html = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Ký xác nhận – ${row.contractCode}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:#faf7fb;color:#222;min-height:100vh}
    .wrap{max-width:600px;margin:0 auto;padding:28px 16px 40px}
    .header{text-align:center;margin-bottom:24px}
    .logo{font-size:22px;font-weight:800;color:#8B1A6B;margin-bottom:4px}
    .subtitle{font-size:14px;color:#999}
    .card{background:#fff;border:1px solid #eadcec;border-radius:18px;padding:26px;box-shadow:0 10px 30px rgba(139,26,107,.08);margin-bottom:16px}
    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:22px;padding-bottom:18px;border-bottom:1px solid #f0e0f0}
    .info-item label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#9b59b6;display:block;margin-bottom:3px}
    .info-item p{font-size:14px;font-weight:600;color:#222}
    .field-group{margin-bottom:16px}
    .field-group label{display:block;font-size:13px;font-weight:700;color:#6c3483;margin-bottom:7px}
    .field-group input{width:100%;border:1.5px solid #d0b8e0;border-radius:10px;padding:11px 14px;font-size:15px;outline:none;transition:border-color .2s;background:#fff}
    .field-group input:focus{border-color:#8B1A6B;box-shadow:0 0 0 3px rgba(139,26,107,.1)}
    .sig-section{margin-top:8px;margin-bottom:20px}
    .sig-section h3{font-size:13px;font-weight:700;color:#8B1A6B;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px}
    .sig-box{border:2px dashed #c9a0d6;border-radius:14px;background:#fdf8ff;padding:12px 12px 8px}
    canvas{width:100%;height:150px;border-bottom:1.5px solid #d0b8e0;display:block;cursor:crosshair;touch-action:none}
    .sig-hint{font-size:11px;color:#bbb;margin-top:7px;text-align:center}
    .actions{display:flex;gap:10px;margin-top:18px}
    .btn{border:0;border-radius:10px;padding:13px 20px;font-weight:700;cursor:pointer;font-size:14px;flex:1;transition:opacity .15s}
    .btn-clear{background:#f3e8f3;color:#6b2d63}
    .btn-reset{background:#fff3cd;color:#8a5a00}
    .btn-submit{background:#8B1A6B;color:#fff;box-shadow:0 4px 14px rgba(139,26,107,.3)}
    .btn-print{background:#065f46;color:#fff;border:0;border-radius:10px;padding:13px 20px;font-weight:700;cursor:pointer;font-size:14px;width:100%;margin-top:14px;transition:opacity .15s}
    .btn-back{background:#7f8c8d;color:#fff;border:0;border-radius:10px;padding:13px 20px;font-weight:700;cursor:pointer;font-size:14px;width:100%;margin-top:10px;transition:opacity .15s}
    .btn-print:hover{opacity:.88}
    .btn-back:hover{opacity:.88}
    .btn:hover{opacity:.88}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    #msg{margin-top:16px;padding:14px 16px;border-radius:12px;font-weight:700;font-size:14px;display:none;text-align:center;line-height:1.6}
    .msg-ok{background:#d1fae5;color:#065f46;border:1px solid #a7f3d0;display:block!important}
    .msg-err{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;display:block!important}
    .msg-info{background:#fdf4ff;color:#8B1A6B;border:1px solid #e8d0f0;display:block!important}
    .signed-section{background:#d1fae5;border:1.5px solid #6ee7b7;border-radius:18px;padding:28px}
    .signed-section h2{color:#065f46;margin-bottom:8px;font-size:18px;text-align:center}
    .signed-detail{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0;padding:16px;background:#fff;border-radius:12px;border:1px solid #a7f3d0}
    .signed-sig-wrap{margin-top:16px;text-align:center;padding:16px;background:#fff;border-radius:12px;border:1px solid #a7f3d0}
    .signed-sig-wrap p{font-size:11px;color:#6b7280;margin-bottom:8px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
    .signed-sig-wrap img{max-width:100%;max-height:120px;object-fit:contain;border-radius:8px;background:#fff;padding:8px;border:1px solid #e5e7eb}
    .contract-content{background:#fff;border-radius:14px;border:1px solid #e0d0ec;padding:20px;margin:16px 0;font-size:13px;line-height:1.7;color:#444;white-space:pre-wrap;word-break:break-word}
    .footer{text-align:center;color:#ccc;font-size:11px;margin-top:20px}
    .no-print{} 
    @media print {
      body{background:#fff}
      .no-print{display:none!important}
      .wrap{padding:0}
      .card,.signed-section{box-shadow:none;border:1px solid #ddd}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header no-print">
      <div class="logo">✨ Amazing Studio</div>
      <div class="subtitle">Ký xác nhận hợp đồng online</div>
    </div>

    <div id="signedView" style="${alreadySigned ? "" : "display:none"}">
      <div class="signed-section">
        <div style="font-size:36px;text-align:center;margin-bottom:10px">✅</div>
        <h2>Hợp đồng đã được ký xác nhận</h2>
        <p style="text-align:center;color:#047857;font-size:13px;margin-top:4px">Hợp đồng <strong>${row.contractCode}</strong> đã có chữ ký hợp lệ.</p>
        <div class="signed-detail">
          <div><div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Khách hàng</div><div style="font-weight:700;font-size:14px" id="viewName">${sigName}</div></div>
          <div><div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Số điện thoại</div><div style="font-weight:700;font-size:14px" id="viewPhone">${sigPhone}</div></div>
          <div><div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Dịch vụ</div><div style="font-size:13px;color:#374151">${row.title || "—"}</div></div>
          <div><div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Thời gian ký</div><div style="font-size:13px;color:#374151" id="viewTime">${signedTimeStr}</div></div>
        </div>
        <div class="signed-sig-wrap">
          <p>✍️ Chữ ký xác nhận</p>
          <img id="sigPreview" src="${sigImgUrl}" style="${sigImgUrl ? "" : "display:none"}" alt="Chữ ký" />
          <div id="noSigMsg" style="${sigImgUrl ? "display:none" : ""};font-size:12px;color:#9ca3af;font-style:italic">Chữ ký đã được lưu an toàn</div>
        </div>
        ${row.content ? `<div style="margin-top:16px"><div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Nội dung hợp đồng</div><div class="contract-content">${row.content.replace(/</g, "&lt;")}</div></div>` : ""}
        <button class="btn-print no-print" onclick="window.print()">🖨️ In / Lưu PDF hợp đồng có chữ ký</button>
        <button class="btn-back no-print" onclick="goBack()">↩ Quay lại trang trước</button>
      </div>
    </div>

    <div id="signForm" style="${alreadySigned ? "display:none" : ""}">
      <div class="card">
        <div class="info-grid">
          <div class="info-item"><label>Mã hợp đồng</label><p>${row.contractCode}</p></div>
          <div class="info-item"><label>Khách hàng</label><p>${row.customerName}</p></div>
          <div class="info-item"><label>Dịch vụ</label><p>${row.title || "—"}</p></div>
          <div class="info-item"><label>Tổng giá trị</label><p>${Number(row.totalValue || 0).toLocaleString("vi-VN")}đ</p></div>
        </div>

        ${row.content ? `<div style="margin-bottom:20px"><div style="font-size:12px;font-weight:700;color:#8B1A6B;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">📄 Nội dung hợp đồng</div><div class="contract-content" style="max-height:240px;overflow-y:auto">${row.content.replace(/</g, "&lt;")}</div></div>` : ""}

        <div class="field-group">
          <label>Họ và tên người ký *</label>
          <input type="text" id="signerName" placeholder="Nhập họ và tên đầy đủ" autocomplete="name" />
        </div>
        <div class="field-group">
          <label>Số điện thoại *</label>
          <input type="tel" id="signerPhone" placeholder="Nhập số điện thoại" autocomplete="tel" />
        </div>

        <div class="sig-section">
          <h3>✍️ Chữ ký của bạn</h3>
          <div class="sig-box">
            <canvas id="sigCanvas"></canvas>
            <div class="sig-hint">Dùng ngón tay hoặc chuột để ký tên vào ô trên</div>
          </div>
        </div>

        <div class="actions">
          <button class="btn btn-reset" id="btnReset" onclick="resetSign()">Ký lại từ đầu</button>
          <button class="btn btn-clear" id="btnClear" onclick="clearSig()">Xóa nét ký</button>
          <button class="btn btn-submit" id="btnSubmit" onclick="submitSign()">✅ Hoàn tất ký</button>
        </div>
        <div id="msg"></div>
      </div>
    </div>

    <div class="footer no-print">Amazing Studio · Hệ thống quản lý studio chuyên nghiệp</div>
  </div>

  <script>
    var c = document.getElementById('sigCanvas');
    if (c) {
      var ctx = c.getContext('2d');
      var drawing = false, last = null;
      function resize() {
        var r = c.getBoundingClientRect();
        c.width = r.width * devicePixelRatio;
        c.height = 150 * devicePixelRatio;
        ctx.scale(devicePixelRatio, devicePixelRatio);
      }
      resize();
      window.addEventListener('resize', resize);
      function getPos(e) {
        var r = c.getBoundingClientRect();
        var src = e.touches ? e.touches[0] : e;
        return [src.clientX - r.left, src.clientY - r.top];
      }
      c.addEventListener('pointerdown', function(e) { drawing = true; c.setPointerCapture(e.pointerId); last = getPos(e); });
      c.addEventListener('pointermove', function(e) {
        if (!drawing) return;
        var p = getPos(e);
        ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#1a1a2e';
        ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
        last = p;
      });
      c.addEventListener('pointerup', function() { drawing = false; last = null; });

      window.clearSig = function clearSig() { ctx.clearRect(0, 0, c.width, c.height); };
      window.resetSign = function resetSign() {
        document.getElementById('signerName').value = '';
        document.getElementById('signerPhone').value = '';
        window.clearSig();
        showMsg('Đã xóa toàn bộ thông tin, bạn có thể ký lại từ đầu.', 'info');
      };

      function showMsg(html, type) {
        var m = document.getElementById('msg');
        m.innerHTML = html;
        m.className = type === 'ok' ? 'msg-ok' : type === 'err' ? 'msg-err' : 'msg-info';
      }

      window.submitSign = async function submitSign() {
        var name = document.getElementById('signerName').value.trim();
        var phone = document.getElementById('signerPhone').value.trim();
        if (!name) { showMsg('⚠️ Vui lòng nhập họ và tên.', 'err'); return; }
        if (!phone) { showMsg('⚠️ Vui lòng nhập số điện thoại.', 'err'); return; }
        var empty = ctx.getImageData(0, 0, c.width, c.height).data.every(function(v) { return v === 0; });
        if (empty) { showMsg('⚠️ Vui lòng ký tên vào ô chữ ký.', 'err'); return; }

        showMsg('Đang lưu chữ ký...', 'info');
        document.getElementById('btnSubmit').disabled = true;
        document.getElementById('btnClear').disabled = true;

        try {
          var now = new Date();
          var sigData = c.toDataURL('image/png');
          var resp = await fetch(window.location.href.replace('/sign', '') + '/mark-signed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signedAt: now.toISOString(), signatureData: sigData, customerName: name, customerPhone: phone })
          });
          if (resp.ok) {
            var pad = function(n) { return String(n).padStart(2, '0'); };
            var timeStr = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ' ngày ' + pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear();
            // Show signed view with the actual signature image
            document.getElementById('viewName').textContent = name;
            document.getElementById('viewPhone').textContent = phone;
            document.getElementById('viewTime').textContent = timeStr;
            var prevImg = document.getElementById('sigPreview');
            prevImg.src = sigData;
            prevImg.style.display = '';
            document.getElementById('noSigMsg').style.display = 'none';
            document.getElementById('signForm').style.display = 'none';
            document.getElementById('signedView').style.display = '';
          } else {
            showMsg('❌ Lỗi khi lưu chữ ký. Vui lòng thử lại.', 'err');
            document.getElementById('btnSubmit').disabled = false;
            document.getElementById('btnClear').disabled = false;
          }
        } catch(e) {
          showMsg('❌ Lỗi kết nối. Vui lòng thử lại.', 'err');
          document.getElementById('btnSubmit').disabled = false;
          document.getElementById('btnClear').disabled = false;
        }
      };
      window.goBack = function goBack() {
        if (window.opener && !window.opener.closed) {
          window.close();
          return;
        }
        if (window.history.length > 1) {
          window.history.back();
          return;
        }
        window.location.href = window.location.href.replace('/sign', '');
      };
    }
  </script>
</body>
</html>`;

  res.type("html").send(html);
});

router.get("/contracts/:id/sync", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [contract] = await db
    .select({
      id: contractsTable.id,
      customerId: contractsTable.customerId,
      bookingId: contractsTable.bookingId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      totalValue: contractsTable.totalValue,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      notes: contractsTable.notes,
      content: contractsTable.content,
      contractCode: contractsTable.contractCode,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .where(eq(contractsTable.id, id));

  if (!contract) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }

  const [booking] = contract.bookingId
    ? await db.select().from(bookingsTable).where(eq(bookingsTable.id, contract.bookingId))
    : [];

  res.json({
    contract,
    booking: booking ?? null,
  });
});

router.get("/contracts/:id/public", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [row] = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      content: contractsTable.content,
      totalValue: contractsTable.totalValue,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      notes: contractsTable.notes,
      bookingId: contractsTable.bookingId,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .where(eq(contractsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  res.json(row);
});

router.post("/contracts/:id/mark-signed", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const { customerName, customerPhone, signedAt, signatureData } = req.body ?? {};
  const [existing] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }

  await db.update(contractsTable).set({
    status: "signed",
    signedAt: signedAt ?? new Date().toISOString(),
    ...(signatureData ? { signatureImageUrl: signatureData } : {}),
    ...(customerName ? { signerName: customerName } : {}),
    ...(customerPhone ? { signerPhone: customerPhone } : {}),
  }).where(eq(contractsTable.id, id));

  if (existing.customerId && (customerName !== undefined || customerPhone !== undefined)) {
    const customerUpdate: Record<string, unknown> = {};
    if (customerName !== undefined) customerUpdate.name = customerName;
    if (customerPhone !== undefined) customerUpdate.phone = customerPhone;
    if (Object.keys(customerUpdate).length) {
      await db.update(customersTable).set(customerUpdate).where(eq(customersTable.id, existing.customerId));
    }
  }

  if (existing.bookingId) {
    await db.update(bookingsTable).set({
      status: "completed",
    }).where(eq(bookingsTable.id, existing.bookingId));
  }

  // Tạo thông báo nội bộ
  const [customer] = existing.customerId
    ? await db.select({ name: customersTable.name }).from(customersTable).where(eq(customersTable.id, existing.customerId))
    : [null];
  await db.insert(notificationsTable).values({
    type: "contract_signed",
    title: "Khách ký hợp đồng online",
    body: `${customer?.name ?? "Khách hàng"} vừa ký hợp đồng ${existing.contractCode} online thành công.`,
    isRead: false,
  } as Record<string, unknown>).catch(() => null);

  res.json({ ok: true });
});

router.get("/customers/:customerId/contracts", async (req, res): Promise<void> => {
  const customerId = parseInt(req.params.customerId);
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
  if (!customer) {
    res.status(404).json({ error: "Không tìm thấy khách hàng" });
    return;
  }

  const rows = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      bookingId: contractsTable.bookingId,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      totalValue: contractsTable.totalValue,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      notes: contractsTable.notes,
      createdAt: contractsTable.createdAt,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .where(eq(contractsTable.customerId, customerId))
    .orderBy(desc(contractsTable.createdAt));

  res.json(rows);
});

router.put("/contracts/:id/sync", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const { customerName, customerPhone, title, totalValue, status, signedAt, expiresAt, notes, content } = req.body ?? {};

  const [existing] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }

  const update: Record<string, unknown> = {};
  if (title !== undefined) update.title = title;
  if (totalValue !== undefined) update.totalValue = String(totalValue);
  if (status !== undefined) update.status = status;
  if (signedAt !== undefined) update.signedAt = signedAt;
  if (expiresAt !== undefined) update.expiresAt = expiresAt;
  if (notes !== undefined) update.notes = notes;
  if (content !== undefined) update.content = content;

  await db.update(contractsTable).set(update).where(eq(contractsTable.id, id));

  if (existing.customerId && (customerName !== undefined || customerPhone !== undefined)) {
    const customerUpdate: Record<string, unknown> = {};
    if (customerName !== undefined) customerUpdate.name = customerName;
    if (customerPhone !== undefined) customerUpdate.phone = customerPhone;
    if (Object.keys(customerUpdate).length) {
      await db.update(customersTable).set(customerUpdate).where(eq(customersTable.id, existing.customerId));
    }
  }

  if (existing.bookingId && (title !== undefined || totalValue !== undefined)) {
    const bookingUpdate: Record<string, unknown> = {};
    if (title !== undefined) bookingUpdate.package_type = title;
    if (totalValue !== undefined) bookingUpdate.total_amount = String(totalValue);
    if (Object.keys(bookingUpdate).length) {
      await db.update(bookingsTable).set(bookingUpdate).where(eq(bookingsTable.id, existing.bookingId));
    }
  }

  res.json({ ok: true });
});

router.get("/contracts/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [row] = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      bookingId: contractsTable.bookingId,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      content: contractsTable.content,
      totalValue: contractsTable.totalValue,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      fileUrl: contractsTable.fileUrl,
      notes: contractsTable.notes,
      signatureImageUrl: contractsTable.signatureImageUrl,
      signerName: contractsTable.signerName,
      signerPhone: contractsTable.signerPhone,
      createdAt: contractsTable.createdAt,
      bookingDeductions: bookingsTable.deductions,
      bookingSurcharges: bookingsTable.surcharges,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .leftJoin(bookingsTable, eq(contractsTable.bookingId, bookingsTable.id))
    .where(eq(contractsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  res.json(row);
});

router.put("/contracts/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const { title, content, status, signedAt, expiresAt, totalValue, notes } = req.body;
  const update: Record<string, unknown> = {};
  if (title !== undefined) update.title = title;
  if (content !== undefined) update.content = content;
  if (status !== undefined) update.status = status;
  if (signedAt !== undefined) update.signedAt = signedAt;
  if (expiresAt !== undefined) update.expiresAt = expiresAt;
  if (totalValue !== undefined) update.totalValue = String(totalValue);
  if (notes !== undefined) update.notes = notes;
  const [contract] = await db.update(contractsTable).set(update).where(eq(contractsTable.id, id)).returning();
  if (!contract) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  res.json(contract);
});

router.delete("/contracts/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(contractsTable).where(eq(contractsTable.id, id));
  res.status(204).send();
});

export default router;
