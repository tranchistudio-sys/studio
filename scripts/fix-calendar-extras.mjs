import fs from "fs";
import path from "path";

const calendarPath = path.resolve(
  import.meta.dirname,
  "../artifacts/amazing-studio/src/pages/calendar.tsx",
);

let cal = fs.readFileSync(calendarPath, "utf8");

cal = cal.replace(
  `    const extrasFormValidation = validateAdditionalServicesForm(subDrafts.flatMap(s => s.additionalServices || []).filter(l => (l.title || "").trim());
const depositNum`,
  `  const extrasFormValidation = validateAdditionalServicesForm(
    subDrafts.flatMap(s => s.additionalServices || []).filter(l => (l.title || "").trim()),
  );
  const depositNum`,
);

cal = cal.replace(
  `<div className="flex justify-between items-center
justify-between items-center">`,
  `<div className="flex justify-between items-center">`,
);

const insertAfter = `                        <button
                          type="button"
                          onClick={() => updateSubDraft(sub.id, { items: [...sub.items, emptyOrderLine()] })}
                          className="text-xs text-primary hover:underline"
                        >
                          + Thêm gói trong cùng ngày
                        </button>
                      </div>
                    </div>`;

const insertBlock = `${insertAfter}
                    <AdditionalServicesSection
                      lines={sub.additionalServices || []}
                      onChange={lines => updateSubDraft(sub.id, { additionalServices: lines })}
                      staffOptions={allStaff.map(s => ({ id: s.id, name: s.name, roles: s.roles || [] }))}
                      allCastRates={allCastRates}
                      allStaffRates={allStaffRates}
                      formatVND={formatVND}
                    />`;

if (!cal.includes("<AdditionalServicesSection")) {
  if (cal.includes(insertAfter)) {
    cal = cal.replace(insertAfter, insertBlock);
    console.log("Inserted AdditionalServicesSection");
  } else {
    console.warn("Insert anchor not found");
  }
} else {
  console.log("AdditionalServicesSection already in file");
}

fs.writeFileSync(calendarPath, cal, "utf8");
console.log("Patched calendar.tsx");
