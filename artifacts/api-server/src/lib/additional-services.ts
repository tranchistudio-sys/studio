import {
  validateAdditionalServices,
  calcLineTotalPrice,
  type AdditionalServiceLine,
  type AdditionalServiceStaff,
} from "@workspace/db/additional-services";
import { resolveStaffCastAmount } from "./resolve-staff-cast";

export {
  sanitizeAdditionalServices,
  validateAdditionalServices,
  calcAdditionalServicesTotal,
  calcLineTotalPrice,
  type AdditionalServiceLine,
  type AdditionalServiceStaff,
} from "@workspace/db/additional-services";

export class AdditionalServicesValidationError extends Error {
  statusCode = 400;
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "AdditionalServicesValidationError";
    this.errors = errors;
  }
}

export function assertAdditionalServicesValid(lines: AdditionalServiceLine[]): void {
  const result = validateAdditionalServices(lines);
  if (!result.ok) throw new AdditionalServicesValidationError(result.errors);
}

function slugTaskKey(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return s || "mac_dinh";
}

export async function normalizeAdditionalServicesCast(
  lines: AdditionalServiceLine[],
  packageId?: number | null,
): Promise<AdditionalServiceLine[]> {
  return Promise.all(
    lines.map(async (line) => {
      const taskKey = line.taskKey || slugTaskKey(line.title);
      const staffAssignments: AdditionalServiceStaff[] = [];

      for (const st of line.staffAssignments || []) {
        if (!st.staffId || !st.allocatedQty) continue;
        const resolved = await resolveStaffCastAmount({
          staffId: st.staffId,
          role: st.role,
          packageId: packageId ?? null,
          taskKey,
          staffName: st.staffName,
        });

        let castPerUnit = st.castPerUnit;
        if (resolved.amount != null && resolved.amount > 0) {
          castPerUnit = Math.round(resolved.amount);
        } else if (castPerUnit == null || castPerUnit <= 0) {
          castPerUnit =
            st.allocatedQty > 0
              ? Math.round((st.castAmount || 0) / st.allocatedQty)
              : 0;
        }

        staffAssignments.push({
          ...st,
          role: resolved.role,
          castPerUnit,
          castAmount: Math.round((castPerUnit || 0) * st.allocatedQty),
        });
      }

      return {
        ...line,
        taskKey,
        totalPrice: calcLineTotalPrice(line.qty, line.unitPrice),
        staffAssignments,
      };
    }),
  );
}
