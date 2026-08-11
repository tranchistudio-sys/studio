import { describe, expect, it } from "vitest";
import { transition } from "./x20-task-state";
const flow:any[] = [["ANALYZE"],["CODE"],["TEST"],["REVIEW"],["PREVIEW"],["REQUEST_MERGE_APPROVAL"],["APPROVE_MERGE","abc123"],["REQUEST_DEPLOY_APPROVAL"],["APPROVE_DEPLOY","abc123"],["HEALTH_CHECK_PASS"],["COMPLETE"]];
describe("X20 task state machine",()=>{
 it("enforces the complete gated flow",()=>{let c:any={state:"QUEUED"}; for(const [e,s] of flow){c=transition(c,e,s); } expect(c.state).toBe("COMPLETED"); expect(c.deploySha).toBe("abc123");});
 it("rejects deploy with a different SHA",()=>{let c:any={state:"WAITING_DEPLOY_APPROVAL",mergedSha:"abc"}; expect(()=>transition(c,"APPROVE_DEPLOY","def")).toThrow("DEPLOY_SHA_MISMATCH");});
 it("prevents coding from deploying",()=>{expect(()=>transition({state:"CODING"},"APPROVE_DEPLOY","abc")).toThrow("INVALID_TRANSITION");});
 it("supports rollback from deploy and health check",()=>{expect(transition({state:"DEPLOYING"},"ROLLBACK").state).toBe("ROLLED_BACK"); expect(transition({state:"HEALTH_CHECK"},"ROLLBACK").state).toBe("ROLLED_BACK");});
});