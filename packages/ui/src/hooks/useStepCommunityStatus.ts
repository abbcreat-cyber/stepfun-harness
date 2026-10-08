import { useEffect, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { StepCommunityStatus } from "@zcode/services";
import { logger } from "@/logger.js";

export type StepCommunityUiStatus = "unknown" | "active" | "inactive";

export interface StepCommunityUiState {
  /** unknown = 查询未落定（本地 IPC 毫秒级）；inactive = 非社区模式或查询失败回落。 */
  status: StepCommunityUiStatus;
  displayName?: string;
  connectionMode?: "api" | "subscription";
  configuredKeyTails?: { api?: string; subscription?: string };
  keySource: StepCommunityStatus["keySource"] | "none";
  /** 已连接 key 的尾 4 位掩码（host 侧派生；key 不存在时为 undefined）。 */
  apiKeyTail?: string;
}

const INACTIVE_STATE: StepCommunityUiState = { status: "inactive", keySource: "none" };

/**
 * mount 时读取 Step-Code 社区后端状态（STEP_BACKEND=stepcode-local 时 active=true）。
 * 所有社区 UI 分支的唯一开关信号；查询失败/服务缺失一律回落 inactive（上游路径），
 * 不让社区查询失败挂掉宿主页面（LoginApiKeyForm 同款纪律）。
 * services 缺失（无 Provider 上下文）同样回落 inactive。
 */
export function useStepCommunityStatus(
  services: IServiceAccessor | null,
): StepCommunityUiState {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("step-community-profile-changed", refresh);
    return () => window.removeEventListener("step-community-profile-changed", refresh);
  }, []);
  const [state, setState] = useState<StepCommunityUiState>({ status: "unknown", keySource: "none" });
  useEffect(() => {
    if (!services?.stepCommunityService) {
      setState(INACTIVE_STATE);
      return;
    }
    let disposed = false;
    void services
      .stepCommunityService!.getStatus()
      .then((result) => {
        if (disposed) return;
        setState(
          result.active
            ? {
                status: "active",
                keySource: result.keySource,
                displayName: result.displayName,
                connectionMode: result.connectionMode,
                configuredKeyTails: result.configuredKeyTails,
                ...(result.apiKeyTail ? { apiKeyTail: result.apiKeyTail } : {}),
              }
            : INACTIVE_STATE,
        );
      })
      .catch((error: unknown) => {
        // 上游环境/旧 server wire 未注册该频道时回落官方路径，不让宿主页面挂掉。
        logger.warn("[StepCommunity] 社区后端状态读取失败，回落官方路径", { error });
        if (!disposed) setState(INACTIVE_STATE);
      });
    return () => {
      disposed = true;
    };
  }, [services?.stepCommunityService, revision]);
  return state;
}
