export const X20_PROVIDER = Object.freeze({ provider: "wiseai_provider", name: "AMAZINGSTUDIO", baseUrl: "https://llm.14k7-homelab.io.vn/v1", family: "responses", model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
export function createTaskMetadata(input) {
  const allowed = ["taskId", "baseSha", "branch", "worktree", "mode", "status"];
  const metadata = { provider: X20_PROVIDER.provider, model: X20_PROVIDER.model, reasoningEffort: X20_PROVIDER.reasoningEffort };
  for (const key of allowed) if (input?.[key] !== undefined) metadata[key] = input[key];
  if (metadata.worktree?.startsWith("/opt/amazing-studio/app")) throw new Error("PRODUCTION_PATH_REJECTED");
  if (metadata.branch === "main") throw new Error("MAIN_BRANCH_REJECTED");
  return Object.freeze(metadata);
}

export function normalizeResponsesOutput(response) {
  const parts = [];
  if (typeof response?.output_text === "string") parts.push(response.output_text);
  for (const item of Array.isArray(response?.output) ? response.output : []) for (const content of Array.isArray(item?.content) ? item.content : []) {
    if (typeof content?.text === "string") parts.push(content.text);
    if (typeof content?.output_text === "string") parts.push(content.output_text);
  }
  if (typeof response?.choices?.[0]?.message?.content === "string") parts.push(response.choices[0].message.content);
  if (typeof response?.choices?.[0]?.text === "string") parts.push(response.choices[0].text);
  return parts.join("").trim();
}
