import { pool } from "@workspace/db";

/**
 * Follow-up khách cũ Facebook — "Khách cần chăm lại".
 *
 * AN TOÀN: CHỈ ĐỌC fb_inbox_messages + crm_leads + ai_follow_up_logs để tìm hội
 * thoại Fanpage bị bỏ quên, phân loại & gợi ý nội dung. KHÔNG tự gửi, KHÔNG đụng
 * booking/tài chính, KHÔNG sửa dữ liệu khách. Việc gửi do nhân viên/Hoa duyệt rồi
 * gọi endpoint gửi tay sẵn có. Tin gợi ý chỉ là bản nháp để admin sửa.
 */

export type ReengagePriority = "hot" | "warm" | "cold" | "skip";

export type ReengageCandidate = {
  facebookUserId: string;
  name: string | null;
  displayName: string;
  avatarUrl: string | null;
  phone: string | null;
  lastMessage: string | null;
  lastDirection: "incoming" | "outgoing" | null;
  lastInteractionAt: string | null;
  silenceDays: number;
  predictedNeed: string;        // nhãn nhu cầu dự đoán (tiếng Việt)
  priority: ReengagePriority;
  reason: string;               // lý do nên follow-up
  suggestedMessage: string;     // tin nhắn Hoa đề xuất (nháp)
  within24h: boolean;           // còn trong cửa sổ Messenger 24h?
  windowNote: string;           // ghi chú cửa sổ 24h
  optedOut: boolean;
};

// ─── Phát hiện nhu cầu từ nội dung khách từng nhắn ────────────────────────────

type NeedKey = "wedding" | "party" | "beauty" | "pregnancy" | "family" | "dress" | "album" | "schedule" | "price";

const NEED_PATTERNS: Array<{ key: NeedKey; label: string; re: RegExp; strong?: boolean }> = [
  { key: "party", label: "Chụp tiệc cưới", re: /ti[eệ]c c[uư][oơ]i|ph[oó]ng s[uự] c[uư][oơ]i|ti[eệ]c\b/i },
  { key: "wedding", label: "Chụp ảnh cưới", re: /[ảa]nh c[uư][oơ]i|ch[uụ]p c[uư][oơ]i|album c[uư][oơ]i|pre[\s-]?wedding/i },
  { key: "dress", label: "Thuê váy cưới", re: /v[áa]y c[uư][oơ]i|thu[eê] [đd][oồ]|thu[eê] v[áa]y|[áa]o d[àa]i c[uư][oơ]i/i },
  { key: "pregnancy", label: "Chụp bầu", re: /ch[uụ]p b[aầ]u|[ảa]nh b[aầ]u|mang thai|babymoon/i },
  { key: "beauty", label: "Chụp beauty / kỷ yếu", re: /beauty|k[yỷ] y[eế]u|th[oờ]i trang|ch[aâ]n dung|profile/i },
  { key: "family", label: "Chụp gia đình", re: /gia [đd][iì]nh|gia dinh|family|con nh[oỏ]|em b[eé]/i },
  { key: "album", label: "Album ảnh", re: /album|in [ảa]nh|tr[áa]ng g[uư][oơ]ng/i },
  { key: "schedule", label: "Hỏi lịch chụp", re: /l[iị]ch ch[uụ]p|c[oò]n l[iị]ch|đ[aặ]t l[iị]ch|ng[àa]y ch[uụ]p|book l[iị]ch/i, strong: true },
  { key: "price", label: "Hỏi giá / bảng giá", re: /gi[áa]|b[aả]ng gi[áa]|bao nhi[eê]u|nhi[eê]u ti[eề]n|combo|g[óo]i ch[uụ]p/i, strong: true },
];

const REFUSAL_RE = /kh[oô]ng quan t[aâ]m|kh[oô]ng c[aầ]n|đ[uừ]ng nh[aắ]n|kh[oô]ng nh[uắ]|stop|unsubscribe|h[uủ]y|spam/i;

function detectNeed(incomingText: string): { key: NeedKey | null; label: string; strong: boolean } {
  for (const p of NEED_PATTERNS) {
    if (p.re.test(incomingText)) return { key: p.key, label: p.label, strong: !!p.strong };
  }
  return { key: null, label: "Chưa rõ nhu cầu", strong: false };
}

function isGenericName(name: string | null | undefined): boolean {
  if (!name?.trim()) return true;
  return name.startsWith("Khách Facebook ") || /^Kh[áa]ch\s/i.test(name) || /^FB\s/i.test(name);
}

function displayName(name: string | null, psid: string): string {
  if (name && !isGenericName(name)) return name;
  return `FB …${psid.slice(-4)}`;
}

// ─── Tin nhắn gợi ý (nháp, giọng Hoa) theo nhu cầu ────────────────────────────

function suggestMessage(need: NeedKey | null, name: string | null): string {
  const greet = name && !isGenericName(name) ? `Dạ ${name} ơi` : "Dạ mình ơi";
  switch (need) {
    case "wedding":
      return `${greet}, hôm trước mình có hỏi gói chụp cưới bên em. Không biết mình còn cần em gửi lại bảng giá với mẫu album không ạ 😊`;
    case "party":
      return `${greet}, hôm trước mình có nhắn hỏi chụp tiệc cưới bên em. Mình tính tổ chức khoảng khi nào để em hỗ trợ kỹ hơn nha 😊`;
    case "beauty":
      return `${greet}, hôm trước mình có hỏi chụp beauty bên em. Em gửi thêm vài mẫu mới chụp cho mình xem nha 😊`;
    case "pregnancy":
      return `${greet}, hôm trước mình có hỏi chụp bầu bên em. Mình dự định chụp khoảng tuần bao nhiêu để em tư vấn concept hợp nha 😊`;
    case "family":
      return `${greet}, hôm trước mình có hỏi chụp gia đình bên em. Không biết mình còn cần em gửi mẫu với bảng giá không ạ 😊`;
    case "dress":
      return `${greet}, hôm trước mình có hỏi thuê váy cưới bên em. Mình cần cho ngày nào để em kiểm tra mẫu giúp mình nha 😊`;
    case "album":
      return `${greet}, hôm trước mình có hỏi album bên em. Em gửi lại vài mẫu album mới cho mình tham khảo nha 😊`;
    case "schedule":
      return `${greet}, hôm trước mình có hỏi lịch chụp bên em. Mình tính chụp khoảng khi nào để em kiểm tra rồi báo mình nha 😊`;
    case "price":
      return `${greet}, hôm trước mình có hỏi bảng giá bên em. Không biết mình còn cần em gửi lại thông tin gói chụp không ạ 😊`;
    default:
      return `${greet}, hôm trước mình có nhắn bên em. Không biết mình còn cần em hỗ trợ thêm thông tin gì không ạ 😊`;
  }
}

type ScanRow = {
  facebook_user_id: string;
  last_at: string;
  last_message: string | null;
  last_direction: "incoming" | "outgoing" | null;
  last_incoming_at: string | null;
  incoming_count: number;
  incoming_text: string | null;
  name: string | null;
  phone: string | null;
  avatar_url: string | null;
  customer_id: number | null;
  opted_out: boolean;
};

function classify(row: ScanRow, need: { key: NeedKey | null; strong: boolean }): { priority: ReengagePriority; reason: string } {
  const silenceDays = row.last_at
    ? Math.floor((Date.now() - new Date(row.last_at).getTime()) / 86400000)
    : 0;
  const hasPhone = !!(row.phone && row.phone.trim());
  const unanswered = row.last_direction === "incoming";
  const anyNeed = need.key !== null;

  if (row.opted_out || REFUSAL_RE.test(row.incoming_text ?? "")) {
    return { priority: "skip", reason: "Khách từng từ chối / không muốn nhận tin — không nên nhắn lại." };
  }
  if (row.customer_id != null) {
    return { priority: "skip", reason: "Đã là khách hàng — nên để nhân viên chăm trực tiếp." };
  }
  if (!anyNeed && !hasPhone && row.incoming_count <= 1) {
    return { priority: "skip", reason: "Khách chưa hỏi gì cụ thể — chưa đủ căn cứ để chăm lại." };
  }

  let score = 0;
  if (hasPhone) score += 2;
  if (need.strong) score += 2;
  if (anyNeed) score += 1;
  if (unanswered) score += 1;
  if (silenceDays >= 2 && silenceDays <= 7) score += 1;
  else if (silenceDays > 30) score -= 1;

  const bits: string[] = [];
  if (anyNeed) bits.push(`khách từng hỏi ${need.strong ? "giá/lịch" : "nhu cầu rõ"}`);
  if (hasPhone) bits.push("đã có SĐT");
  if (unanswered) bits.push("nhân viên chưa trả lời");
  bits.push(`im ${silenceDays} ngày`);
  const reason = bits.join(", ") + ".";

  if (score >= 4) return { priority: "hot", reason: `Ưu tiên cao: ${reason}` };
  if (score >= 2) return { priority: "warm", reason };
  return { priority: "cold", reason };
}

/**
 * Quét & phân loại hội thoại cần chăm lại. CHỈ ĐỌC. Không gửi gì.
 * @param minSilenceDays khách im tối thiểu bao nhiêu ngày (mặc định 2)
 */
export async function scanReengageCandidates(opts?: {
  limit?: number;
  minSilenceDays?: number;
  includeSkip?: boolean;
}): Promise<ReengageCandidate[]> {
  const limit = Math.min(500, Math.max(1, opts?.limit ?? 200));
  const minSilenceDays = Math.max(1, opts?.minSilenceDays ?? 2);
  const includeSkip = !!opts?.includeSkip;

  const res = await pool.query(
    `WITH agg AS (
       SELECT facebook_user_id,
              MAX(created_at) AS last_at,
              MAX(created_at) FILTER (WHERE direction = 'incoming') AS last_incoming_at,
              MAX(created_at) FILTER (WHERE direction = 'outgoing') AS last_outgoing_at,
              COUNT(*) FILTER (WHERE direction = 'incoming') AS incoming_count
       FROM fb_inbox_messages
       GROUP BY facebook_user_id
     )
     SELECT a.facebook_user_id,
            a.last_at::text AS last_at,
            a.last_incoming_at::text AS last_incoming_at,
            a.incoming_count::int AS incoming_count,
            (SELECT message FROM fb_inbox_messages m WHERE m.facebook_user_id = a.facebook_user_id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT direction FROM fb_inbox_messages m WHERE m.facebook_user_id = a.facebook_user_id ORDER BY created_at DESC LIMIT 1) AS last_direction,
            (SELECT string_agg(LEFT(message, 300), ' ')
               FROM (SELECT message, created_at FROM fb_inbox_messages m
                      WHERE m.facebook_user_id = a.facebook_user_id AND direction = 'incoming'
                      ORDER BY created_at DESC LIMIT 15) z) AS incoming_text,
            l.name, l.phone, l.avatar_url, l.customer_id,
            COALESCE(fl.is_opted_out, false) AS opted_out
       FROM agg a
       LEFT JOIN crm_leads l ON l.facebook_user_id = a.facebook_user_id
       LEFT JOIN ai_follow_up_logs fl ON fl.psid = a.facebook_user_id
      WHERE a.last_at < NOW() - ($1::int * INTERVAL '1 day')
      ORDER BY a.last_at DESC
      LIMIT $2`,
    [minSilenceDays, limit],
  );

  const out: ReengageCandidate[] = [];
  for (const r of res.rows as ScanRow[]) {
    const psid = r.facebook_user_id;
    if (!psid) continue;
    const incomingText = r.incoming_text ?? "";
    const need = detectNeed(incomingText);
    const { priority, reason } = classify(r, need);
    if (priority === "skip" && !includeSkip) continue;

    const silenceDays = r.last_at
      ? Math.floor((Date.now() - new Date(r.last_at).getTime()) / 86400000)
      : 0;
    // Cửa sổ Messenger 24h tính từ tin KHÁCH gửi gần nhất.
    const hoursSinceIncoming = r.last_incoming_at
      ? (Date.now() - new Date(r.last_incoming_at).getTime()) / 3600000
      : Infinity;
    const within24h = hoursSinceIncoming <= 24;

    out.push({
      facebookUserId: psid,
      name: r.name ?? null,
      displayName: displayName(r.name, psid),
      avatarUrl: r.avatar_url ?? null,
      phone: r.phone ?? null,
      lastMessage: r.last_message ?? null,
      lastDirection: r.last_direction ?? null,
      lastInteractionAt: r.last_at ?? null,
      silenceDays,
      predictedNeed: need.label,
      priority,
      reason,
      suggestedMessage: suggestMessage(need.key, r.name),
      within24h,
      windowNote: within24h
        ? "Trong 24h — có thể gửi qua tin nhắn thường."
        : "Ngoài 24h — Meta không cho gửi tin thường. Cần nhân viên xử lý thủ công hoặc dùng tag hợp lệ. KHÔNG spam hàng loạt.",
      optedOut: r.opted_out,
    });
  }

  // Sắp xếp: hot → warm → cold (→ skip), trong nhóm theo mới nhất.
  const rank: Record<ReengagePriority, number> = { hot: 0, warm: 1, cold: 2, skip: 3 };
  out.sort((a, b) => rank[a.priority] - rank[b.priority]);
  return out;
}
