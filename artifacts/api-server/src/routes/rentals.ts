import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { rentalsTable, customersTable, dressesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const formatRental = (row: {
  id: number;
  customerId: number;
  customerName: string;
  customerPhone: string;
  dressId: number;
  dressCode: string;
  dressName: string;
  rentalDate: string;
  returnDate: string;
  actualReturnDate: string | null;
  rentalPrice: string;
  depositPaid: string;
  status: string;
  notes: string | null;
  createdAt: Date;
}) => ({
  ...row,
  rentalPrice: parseFloat(row.rentalPrice),
  depositPaid: parseFloat(row.depositPaid),
});

router.get("/rentals", async (req, res) => {
  const status = req.query.status as string | undefined;

  let query = db
    .select({
      id: rentalsTable.id,
      customerId: rentalsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      dressId: rentalsTable.dressId,
      dressCode: dressesTable.code,
      dressName: dressesTable.name,
      rentalDate: rentalsTable.rentalDate,
      returnDate: rentalsTable.returnDate,
      actualReturnDate: rentalsTable.actualReturnDate,
      rentalPrice: rentalsTable.rentalPrice,
      depositPaid: rentalsTable.depositPaid,
      status: rentalsTable.status,
      notes: rentalsTable.notes,
      createdAt: rentalsTable.createdAt,
    })
    .from(rentalsTable)
    .innerJoin(customersTable, eq(rentalsTable.customerId, customersTable.id))
    .innerJoin(dressesTable, eq(rentalsTable.dressId, dressesTable.id))
    .$dynamic();

  if (status) {
    query = query.where(eq(rentalsTable.status, status));
  }

  const rows = await query.orderBy(rentalsTable.rentalDate);
  res.json(rows.map(formatRental));
});

router.post("/rentals", async (req, res) => {
  const { customerId, dressId, rentalDate, returnDate, rentalPrice, depositPaid, notes } = req.body;

  const [rental] = await db
    .insert(rentalsTable)
    .values({
      customerId,
      dressId,
      rentalDate,
      returnDate,
      rentalPrice: String(rentalPrice),
      depositPaid: String(depositPaid),
      notes,
      status: "rented",
    })
    .returning();

  await db.update(dressesTable).set({ isAvailable: false }).where(eq(dressesTable.id, dressId));

  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
  const [dress] = await db.select().from(dressesTable).where(eq(dressesTable.id, dressId));

  res.status(201).json(
    formatRental({
      ...rental,
      customerName: customer.name,
      customerPhone: customer.phone,
      dressCode: dress.code,
      dressName: dress.name,
    })
  );
});

router.get("/rentals/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [row] = await db
    .select({
      id: rentalsTable.id,
      customerId: rentalsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      dressId: rentalsTable.dressId,
      dressCode: dressesTable.code,
      dressName: dressesTable.name,
      rentalDate: rentalsTable.rentalDate,
      returnDate: rentalsTable.returnDate,
      actualReturnDate: rentalsTable.actualReturnDate,
      rentalPrice: rentalsTable.rentalPrice,
      depositPaid: rentalsTable.depositPaid,
      status: rentalsTable.status,
      notes: rentalsTable.notes,
      createdAt: rentalsTable.createdAt,
    })
    .from(rentalsTable)
    .innerJoin(customersTable, eq(rentalsTable.customerId, customersTable.id))
    .innerJoin(dressesTable, eq(rentalsTable.dressId, dressesTable.id))
    .where(eq(rentalsTable.id, id));

  if (!row) return res.status(404).json({ error: "Rental not found" });
  res.json(formatRental(row));
});

router.put("/rentals/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, actualReturnDate, notes } = req.body;

  const updateData: Record<string, unknown> = {};
  if (status !== undefined) updateData.status = status;
  if (actualReturnDate !== undefined) updateData.actualReturnDate = actualReturnDate;
  if (notes !== undefined) updateData.notes = notes;

  const [rental] = await db
    .update(rentalsTable)
    .set(updateData)
    .where(eq(rentalsTable.id, id))
    .returning();

  if (!rental) return res.status(404).json({ error: "Rental not found" });

  if (status === "returned") {
    await db.update(dressesTable).set({ isAvailable: true }).where(eq(dressesTable.id, rental.dressId));
  }

  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, rental.customerId));
  const [dress] = await db.select().from(dressesTable).where(eq(dressesTable.id, rental.dressId));

  res.json(
    formatRental({
      ...rental,
      customerName: customer.name,
      customerPhone: customer.phone,
      dressCode: dress.code,
      dressName: dress.name,
    })
  );
});

export default router;
