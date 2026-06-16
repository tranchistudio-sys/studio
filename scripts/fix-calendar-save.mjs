import fs from "fs";
import path from "path";

const calendarPath = path.resolve(
  import.meta.dirname,
  "../artifacts/amazing-studio/src/pages/calendar.tsx",
);

let cal = fs.readFileSync(calendarPath, "utf8");

cal = cal.replace(
  `        const extrasValidation = validateAdditionalServicesForm(subDrafts.flatMap(s => s.additionalServices || []).filter(l => (l.title || "").trim());
    if (!extrasValidation.ok) { setError(extrasValidation.errors[0]); return; }
const isMulti = subDrafts.length >= 2;`,
  `    const extrasValidation = validateAdditionalServicesForm(
      subDrafts.flatMap(s => s.additionalServices || []).filter(l => (l.title || "").trim()),
    );
    if (!extrasValidation.ok) { setError(extrasValidation.errors[0]); return; }
    const isMulti = subDrafts.length >= 2;`,
);

fs.writeFileSync(calendarPath, cal, "utf8");
console.log("fixed");
