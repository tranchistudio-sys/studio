import { Router, type IRouter } from "express";
import { getCallerRole } from "./auth";
const router: IRouter = Router();
const bridgeUrl = () => (process.env.AMAZING_BRIDGE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
async function requireAdmin(req: any, res: any) { const role = await getCallerRole(req.headers.authorization); if (role !== "admin") { res.status(403).json({ error: "AI Codex chỉ dành cho chủ studio" }); return false; } return true; }
async function proxy(req: any, res: any, path: string, init: RequestInit = {}) { if (!(await requireAdmin(req,res))) return; const token=process.env.AMAZING_BRIDGE_TOKEN; if (!token) return res.status(503).json({error:"Amazing AI Bridge chưa được cấu hình"}); const r=await fetch(`${bridgeUrl()}${path}`,{...init,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"}}); res.status(r.status).type("application/json").send(await r.text()); }
router.post("/codex/tasks",(req,res)=>proxy(req,res,"/tasks",{method:"POST",body:JSON.stringify(req.body)}));
router.get("/codex/tasks/:id",(req,res)=>proxy(req,res,`/tasks/${encodeURIComponent(req.params.id)}`));
router.post("/codex/tasks/:id/approve",(req,res)=>proxy(req,res,`/tasks/${encodeURIComponent(req.params.id)}/approve`,{method:"POST"}));
router.post("/codex/tasks/:id/cancel",(req,res)=>proxy(req,res,`/tasks/${encodeURIComponent(req.params.id)}/cancel`,{method:"POST"}));
const enabled=()=>process.env.AI_CODEX_X20_SETTINGS_ENABLED === "true";
const status=()=>({configured:false,connection:"UNCONFIGURED",activeProvider:null,featureEnabled:enabled()});
router.get("/codex/provider/status",async(req,res)=>{if(!(await requireAdmin(req,res)))return;res.json(status());});
router.post("/codex/provider/test",async(req,res)=>{if(!(await requireAdmin(req,res)))return;if(!enabled())return res.json({ok:true,mock:true,message:"X20 mock connection OK; feature disabled"});res.status(501).json({error:"X20 connector not enabled"});});
router.put("/codex/provider/config",async(req,res)=>{if(!(await requireAdmin(req,res)))return;if(!enabled())return res.status(409).json({error:"FEATURE_DISABLED"});res.status(501).json({error:"X20 connector not enabled"});});
router.post("/codex/provider/activate",async(req,res)=>{if(!(await requireAdmin(req,res)))return;res.status(409).json({error:"FEATURE_DISABLED"});});
router.delete("/codex/provider/config",async(req,res)=>{if(!(await requireAdmin(req,res)))return;res.status(409).json({error:"FEATURE_DISABLED"});});
export default router;
