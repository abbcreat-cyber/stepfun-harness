import { z } from "zod";

export const STEP_MINI_CHANNELS = {
  publish: "step-mini:publish",
  toggle: "step-mini:toggle",
  action: "step-mini:action",
  snapshot: "step-mini:snapshot",
  read: "step-mini:read",
  expand: "step-mini:expand",
  hide: "step-mini:hide",
  layout: "step-mini:layout",
} as const;
export const stepMiniTaskSchema = z.object({
  key: z.string().min(1).max(4096),
  taskId: z.string().min(1).max(500),
  workspacePath: z.string().min(1).max(2048),
  workspaceIdentity: z.string().max(2048).optional(),
  title: z.string().max(200),
  state: z.enum(["running", "attention", "completed", "failed", "idle"]),
  updatedAt: z.number().finite(),
});
export const stepMiniSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  dark: z.boolean(),
  locale: z.string().max(30),
  generation: z.string().max(100).optional(),
  fontSize: z.number().min(10).max(32).optional(),
  tasks: z.array(stepMiniTaskSchema).max(12),
  activeTaskKeys: z.array(z.string().min(1).max(4096)).max(10000).optional(),
  activeTaskCount: z.number().int().nonnegative().max(10000).optional(),
});
export type StepMiniSnapshot = z.infer<typeof stepMiniSnapshotSchema>;
export type StepMiniTask = z.infer<typeof stepMiniTaskSchema>;
export type StepMiniAction = { type: "new-task" } | { type: "open-task"; task: StepMiniTask };
