// TEMP test harness for formatLuluHumanChatMessages — not part of the build (delete after).
import { formatLuluHumanChatMessages } from "./lib/sale-human-chat";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, extra ?? ""); }
}
function emojiCount(s: string): number {
  const m = s.match(/\p{Extended_Pictographic}/gu); return m ? m.length : 0;
}
function hasFakeMarker(s: string): boolean { return /[{}]|\[(typing|delay|pause)/i.test(s); }

console.log("CASE 1: greeting run-on (hi)");
const c1 = formatLuluHumanChatMessages("Dạ hi anh 😊 Em là Hoa bên Amazing Studio nha. Anh đang quan tâm dịch vụ nào bên em ạ, chụp cưới, beauty, chụp gia đình hay thuê trang phục cưới nè anh");
c1.forEach((c, i) => console.log(`   [${i}] (${c.delayMs}ms) ${c.text}`));
check("≥2 bubbles", c1.length >= 2, c1.length);
check("≤1 emoji total", c1.reduce((n, c) => n + emojiCount(c.text), 0) <= 1);
check("no fake markers", !c1.some((c) => hasFakeMarker(c.text)));
check("delays in range", c1.every((c, i) => i === 0 ? c.delayMs >= 700 && c.delayMs <= 1300 : c.delayMs >= 1400 && c.delayMs <= 3000));

console.log("CASE 2: price block kept intact");
const c2 = formatLuluHumanChatMessages("Dạ gói chụp cổng bên em nha anh\n\n[CG-IL19] GÓI CHỤP CỔNG IN LỤA 1tr9 — 1.900.000đ. Gồm: chụp cổng tại studio, 5 hình in lụa\n* 1 saree\n* 1 vest 😊");
c2.forEach((c, i) => console.log(`   [${i}] (${c.delayMs}ms) ${JSON.stringify(c.text)}`));
check("block stays one bubble (has 1.900.000đ + bullets)", c2.some((c) => c.text.includes("1.900.000đ") && c.text.includes("* 1 saree")));
check("no emoji in price block bubble", c2.filter((c) => /1\.900\.000đ/.test(c.text)).every((c) => emojiCount(c.text) === 0));

console.log("CASE 3: exact_reply, allowEmoji=false");
const c3 = formatLuluHumanChatMessages("Dạ em chào anh ạ 😊. Bên em chuyên chụp gia đình nha. Anh muốn em tư vấn gói nào cho nhà mình ạ?", { allowEmoji: false });
c3.forEach((c, i) => console.log(`   [${i}] (${c.delayMs}ms) ${c.text}`));
check("≥2 bubbles", c3.length >= 2, c3.length);
check("0 emoji (allowEmoji=false)", c3.reduce((n, c) => n + emojiCount(c.text), 0) === 0);
check("wording preserved (no words dropped)", c3.map((c) => c.text).join(" ").includes("chuyên chụp gia đình"));

console.log("CASE 4: pseudo-markers stripped");
const c4 = formatLuluHumanChatMessages("Dạ anh {delay 3s} [typing] em là Hoa nha {xuống dòng- chậm 1s}");
c4.forEach((c, i) => console.log(`   [${i}] ${JSON.stringify(c.text)}`));
check("no fake markers leaked", !c4.some((c) => hasFakeMarker(c.text)));

console.log("CASE 5: many emojis capped to 1");
const c5 = formatLuluHumanChatMessages("Dạ anh 😊😍 Em là Hoa 🥰✨ bên studio nha");
c5.forEach((c, i) => console.log(`   [${i}] ${c.text}`));
check("≤1 emoji total", c5.reduce((n, c) => n + emojiCount(c.text), 0) <= 1, c5.reduce((n, c) => n + emojiCount(c.text), 0));

console.log("CASE 6: empty/whitespace");
check("empty → []", formatLuluHumanChatMessages("   ").length === 0);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
