import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DESKTOP_AUTOMATION_COMMAND,
  DESKTOP_AUTOMATION_DESCRIPTION,
} from "../desktop-automation.mjs";

const DESCRIPTION =
  "Desktop scheduled task: permanently persisted in the desktop task database and visible in the Scheduled Tasks UI. Uses the user's local time exactly, without native cron jitter or seven-day expiration. Existing desktop scheduler is the only execution owner. The app must be running for execution; shutdown never runs a model. Preserve the current session model and permission mode. Never edit trust.json or fall back to native cron when the desktop bridge fails.";

async function request(method, params, signal) {
  const root = process.env.STEPCODE_STORAGE_ROOT_DIR;
  if (!root || signal?.aborted)
    throw new Error("Desktop automation bridge is unavailable or cancelled");
  const bridge = JSON.parse(
    await readFile(join(root, "browser-bridges", `${process.pid}.json`), "utf8"),
  );
  const endpoint = new URL(bridge.endpoint);
  if (
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.protocol !== "http:" ||
    endpoint.pathname !== "/execute" ||
    typeof bridge.token !== "string" ||
    !bridge.token
  )
    throw new Error("Invalid desktop automation bridge binding");
  endpoint.pathname = "/desktop-automation";
  const post = async (body) => {
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || result?.ok === false)
      throw new Error(result?.error?.message ?? "Desktop automation request failed");
    return result;
  };
  const context = await post({ method: "context" });
  return post({ method, params, sessionId: context.sessionId, turnId: context.turnId });
}

export default function desktopAutomation(pi) {
  if (process.env.STEPCODE_TASK_MODE !== "desktop") return;
  if (process.env.STEP_DISABLE_CRON !== "1" || typeof pi.registerTool !== "function")
    throw new Error("Desktop automation requires native cron disabled and extension tool API");
  const string = { type: "string", minLength: 1 };
  for (const [name, method, properties, required] of [
    [
      "cron_create",
      "create",
      {
        cron: string,
        prompt: string,
        title: { type: "string" },
        recurring: { type: "boolean", default: true },
        durable: {
          type: "boolean",
          description: "Compatibility only: desktop tasks are always permanent",
        },
      },
      ["cron", "prompt"],
    ],
    ["cron_list", "list", {}, []],
    ["cron_delete", "delete", { id: string }, ["id"]],
  ])
    pi.registerTool({
      name,
      label: name,
      description: DESCRIPTION,
      parameters: { type: "object", properties, required, additionalProperties: false },
      async execute(_toolCallId, params, signal) {
        const result = await request(method, params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  pi.registerCommand(DESKTOP_AUTOMATION_COMMAND, {
    description: DESKTOP_AUTOMATION_DESCRIPTION,
    handler: async () => {},
  });
}
