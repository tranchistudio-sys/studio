# Lulu clean pipeline plan

## Audit of the failing regression conversation

| Customer message | Previous Lulu response | Source file/function | Workflow/stage/action | Script node | Data source | Conclusion |
| --- | --- | --- | --- | --- | --- | --- |
| `hi` | Broad service list | `sale-brain-runner.ts` / `workflowControlledReply` | `GREETING` / `ASK_SERVICE` | `UNMAPPED_LLM_FALLBACK` | None | A hard-coded fallback was used instead of an approved greeting node. |
| `bên bạn có chụp cổng ko?` | Style question | `sale-brain-runner.ts` / `workflowControlledReply` | `DISCOVERY` / `ASK_DISCOVERY` | `UNMAPPED_LLM_FALLBACK` | Workflow slot configuration | The generic wedding-gate slot was `style`, so the service confirmation and gate-count node did not exist. |
| `nghĩa là sao ạ` | Duplicate sample images | `sale-brain-runner.ts` / `askClaudeForReply` plus `selectSampleImages` | Drifted from `DISCOVERY` | `UNMAPPED_LLM_FALLBACK` | Image store and Claude markers | No clarification node existed. Claude could request samples, and the image path was not tied to an explicit script node. |
| `giá nhiêu ạ` | Another style question | `sale-workflow.ts` / `evaluateSaleWorkflow`, then `askClaudeForReply` | Intended `SEND_PRICE_SHEET`; text could still come from Claude | `UNMAPPED_LLM_FALLBACK` | `service_groups`, package audit | The action could be price, but the non-deterministic text branch was still reachable. |
| `tinh tế` | “Em nhớ phần mình đã trao đổi rồi nha.” | `askClaudeForReply` / prompt assembled by `claude-sale.ts` | `CONTINUE_CONVERSATION` | `UNMAPPED_LLM_FALLBACK` | Prompt history | This was free-form model output, not an approved sale sentence. |
| `RỒI SAO NỮA` | Price sheet while trace showed follow-up | `sale-workflow.ts` + `sale-brain-runner.ts` | `FOLLOW_UP` / `CONTINUE_CONVERSATION` | `UNMAPPED_LLM_FALLBACK` | Price resolver and Claude output | Generic `CONTINUE_CONVERSATION` mixed stage choice with a later resource action. |

## Rebuilt active path

- `SALE_WEDDING_GATE` version `1` is the only active service script.
- All replies from that path resolve to a deterministic node, template, trace, state transition, validator list, and data-source list.
- The official price image and retail packages are still read at runtime through `sale-price-sheet.ts`; prices are never kept in script text.
- Other service groups are catalogued as drafts only. No new prompt is used to answer them.
- Real Messenger auto-reply remains blocked until `LULU_SALE_REBUILD_APPROVED=true` is explicitly set. The Brain Lab simulator remains available.

## Proposed persistence migration, not executed

No database migration or seed was run. When the script is approved, add the following tables through the normal migration process:

```sql
CREATE TABLE lulu_sale_scripts (
  id serial PRIMARY KEY,
  script_key text NOT NULL,
  service_group_id integer NULL,
  service_key text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lulu_sale_script_nodes (
  id serial PRIMARY KEY,
  script_id integer NOT NULL REFERENCES lulu_sale_scripts(id),
  node_key text NOT NULL,
  step_number integer NOT NULL,
  stage text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  reply_template text NOT NULL,
  data_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  validators jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  UNIQUE (script_id, node_key, version)
);

CREATE TABLE lulu_response_traces (
  id serial PRIMARY KEY,
  thread_id text NULL,
  message_id text NULL,
  customer_message text NOT NULL,
  detected_intent text NULL,
  service_key text NULL,
  script_key text NOT NULL,
  node_key text NOT NULL,
  script_version integer NOT NULL,
  template_before_render text NOT NULL,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  pricing_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  final_response text NOT NULL,
  validator_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  state_before jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_after jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Manual nodes must always win over any future generated synchronization.
