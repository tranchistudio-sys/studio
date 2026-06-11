import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { servicesTable, serviceJobSplitsTable } from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";

const router: IRouter = Router();

const ROLES = ["photographer", "makeup", "sale", "photoshop", "assistant"];

const fmtService = (s: { price: string; costPrice: string; isActive: number; [key: string]: unknown }) => ({
  ...s,
  price: parseFloat(s.price),
  costPrice: parseFloat(s.costPrice ?? "0"),
  isActive: Boolean(s.isActive),
});

const fmtSplit = (sp: { amount: string; [key: string]: unknown }) => ({
  ...sp,
  amount: parseFloat(sp.amount),
});

// Fetch splits for given serviceIds → map of serviceId → splits[]
async function fetchSplitsMap(serviceIds: number[]) {
  if (serviceIds.length === 0) return {};
  const splits = await db
    .select()
    .from(serviceJobSplitsTable)
    .orderBy(asc(serviceJobSplitsTable.serviceId));
  const map: Record<number, Array<{ role: string; amount: number; rateType: string; notes: string | null }>> = {};
  for (const sp of splits) {
    if (!serviceIds.includes(sp.serviceId)) continue;
    if (!map[sp.serviceId]) map[sp.serviceId] = [];
    map[sp.serviceId].push({
      role: sp.role,
      amount: parseFloat(sp.amount),
      rateType: sp.rateType,
      notes: sp.notes,
    });
  }
  return map;
}

// ─── GET /services ─────────────────────────────────────────────────────────────
router.get("/services", async (_req, res) => {
  try {
  const services = await db.select().from(servicesTable).orderBy(asc(servicesTable.sortOrder), asc(servicesTable.createdAt));
  const ids = services.map(s => s.id);
  const splitsMap = await fetchSplitsMap(ids);
  res.json(services.map(s => ({ ...fmtService(s), splits: splitsMap[s.id] || [] })));
  } catch (e) { res.status(500).json({ error: "Lỗi hệ thống" }); }
});

// ─── GET /services/:id ─────────────────────────────────────────────────────────
router.get("/services/:id", async (req, res) => {
  try {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, id));
  if (!service) return res.status(404).json({ error: "Service not found" });
  const splitsMap = await fetchSplitsMap([id]);
  res.json({ ...fmtService(service), splits: splitsMap[id] || [] });
  } catch (e) { res.status(500).json({ error: "Lỗi hệ thống" }); }
});

// ─── POST /services ────────────────────────────────────────────────────────────
router.post("/services", async (req, res) => {
  try {
  const { name, code, category, description, type, price, costPrice, duration, includes, sortOrder, isActive, splits } = req.body;
  const [service] = await db
    .insert(servicesTable)
    .values({
      name, code, category: category ?? "other", description,
      type: type ?? "package",
      price: String(price ?? 0),
      costPrice: String(costPrice ?? 0),
      duration, includes: (includes as string[]) ?? [],
      sortOrder: sortOrder ?? 0,
      isActive: isActive !== false ? 1 : 0,
    })
    .returning();

  // Insert splits if provided
  if (Array.isArray(splits) && splits.length > 0) {
    await db.insert(serviceJobSplitsTable).values(
      splits.filter((sp: { role: string; amount: number }) => sp.role && sp.amount > 0).map((sp: { role: string; amount: number; rateType?: string; notes?: string }) => ({
        serviceId: service.id,
        role: sp.role,
        amount: String(sp.amount),
        rateType: sp.rateType || "fixed",
        notes: sp.notes || null,
      }))
    );
  }

  const splitsMap = await fetchSplitsMap([service.id]);
  res.status(201).json({ ...fmtService(service), splits: splitsMap[service.id] || [] });
  } catch (e) { res.status(500).json({ error: "Lỗi hệ thống" }); }
});

// ─── PUT /services/:id ─────────────────────────────────────────────────────────
router.put("/services/:id", async (req, res) => {
  try {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const { name, code, category, description, type, price, costPrice, duration, includes, sortOrder, isActive, splits } = req.body;

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (code !== undefined) updateData.code = code;
  if (category !== undefined) updateData.category = category;
  if (description !== undefined) updateData.description = description;
  if (type !== undefined) updateData.type = type;
  if (price !== undefined) updateData.price = String(price);
  if (costPrice !== undefined) updateData.costPrice = String(costPrice);
  if (duration !== undefined) updateData.duration = duration;
  if (includes !== undefined) updateData.includes = includes as string[];
  if (sortOrder !== undefined) updateData.sortOrder = sortOrder;
  if (isActive !== undefined) updateData.isActive = isActive ? 1 : 0;

  const [service] = await db.update(servicesTable).set(updateData).where(eq(servicesTable.id, id)).returning();
  if (!service) return res.status(404).json({ error: "Service not found" });

  // Replace splits if provided
  if (Array.isArray(splits)) {
    await db.delete(serviceJobSplitsTable).where(eq(serviceJobSplitsTable.serviceId, id));
    if (splits.length > 0) {
      await db.insert(serviceJobSplitsTable).values(
        splits.filter((sp: { role: string; amount: number }) => sp.role && sp.amount > 0).map((sp: { role: string; amount: number; rateType?: string; notes?: string }) => ({
          serviceId: id,
          role: sp.role,
          amount: String(sp.amount),
          rateType: sp.rateType || "fixed",
          notes: sp.notes || null,
        }))
      );
    }
  }

  const splitsMap = await fetchSplitsMap([id]);
  res.json({ ...fmtService(service), splits: splitsMap[id] || [] });
  } catch (e) { res.status(500).json({ error: "Lỗi hệ thống" }); }
});

// ─── DELETE /services/:id ──────────────────────────────────────────────────────
router.delete("/services/:id", async (req, res) => {
  try {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  await db.delete(servicesTable).where(eq(servicesTable.id, id));
  res.status(204).send();
  } catch (e) { res.status(500).json({ error: "Lỗi hệ thống" }); }
});

// ─── GET /service-splits?serviceId=X ──────────────────────────────────────────
// Lookup splits for a specific service (used by job-earnings compute)
router.get("/service-splits", async (req, res) => {
  try {
  const serviceId = req.query.serviceId ? parseInt(req.query.serviceId as string) : undefined;
  if (!serviceId) return res.json([]);
  const splits = await db.select().from(serviceJobSplitsTable).where(eq(serviceJobSplitsTable.serviceId, serviceId));
  res.json(splits.map(fmtSplit));
  } catch (e) { res.status(500).json({ error: "Lỗi hệ thống" }); }
});

export { ROLES };
export default router;
