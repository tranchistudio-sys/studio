import { Router, type IRouter } from "express";
import monthlyRouter from "./monthly";
import byServiceRouter from "./by-service";
import warningsRouter from "./warnings";
import customRangeRouter from "./custom-range";
import statsRouter from "./stats";
import byPeriodRouter from "./by-period";
import bySaleRouter from "./by-sale";
import dailyCashflowRouter from "./daily-cashflow";
import evidenceRouter from "./evidence";

const router: IRouter = Router();

router.use(monthlyRouter);
router.use(evidenceRouter);
router.use(byServiceRouter);
router.use(warningsRouter);
router.use(customRangeRouter);
router.use(statsRouter);
router.use(byPeriodRouter);
router.use(bySaleRouter);
router.use(dailyCashflowRouter);

export default router;
export { buildBySaleRows, type BySaleBooking, type BySaleRow } from "./by-sale";
