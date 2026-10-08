import { useEffect, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { StepCommunityBalance } from "@zcode/services";
import { logger } from "@/logger.js";

export interface StepCommunityBalanceState {
  /** 请求在途 true；未发起请求（未连接/服务缺失）时保持 false。 */
  loading: boolean;
  /** host 投影结果；未落定/失败一律 null。不缓存、不跨浮层生命周期复用。 */
  balance: StepCommunityBalance | null;
}

const IDLE_STATE: StepCommunityBalanceState = { loading: false, balance: null };
const LOADING_STATE: StepCommunityBalanceState = { loading: true, balance: null };

/**
 * enabled 变为 true 时按需拉取一次阶跃星辰账户余额（docs/step-account-balance-spec.md 时序约束：
 * 每次浮层展开重新拉取、卸载即取消在途请求、无轮询无定时刷新）。
 *
 * 纪律与 useStepCommunityStatus 对齐：
 * - 仅社区态 active 且已接入 key（connected）时才调 getAccountBalance()，
 *   未接入 key / 非 api 连接模式（host 裁决 unsupported）不发界面可见请求；
 * - 卸载/关闭（disposed=true）丢弃迟回结果，不发生 setState；
 * - services 缺失或调用失败一律回落 { loading:false, balance:null }，不抛、不缓存、不落盘。
 */
export function useStepCommunityBalance(
  services: IServiceAccessor | null,
  enabled: boolean,
): StepCommunityBalanceState {
  const [state, setState] = useState<StepCommunityBalanceState>(IDLE_STATE);
  useEffect(() => {
    // 菜单 forceMount 会常驻挂载，必须由真正的 open 状态启动请求，重开才能刷新/重试。
    if (!enabled) {
      setState(IDLE_STATE);
      return;
    }
    if (!services?.stepCommunityService) {
      setState(IDLE_STATE);
      return;
    }
    let disposed = false;
    setState(LOADING_STATE);
    void services
      .stepCommunityService!.getAccountBalance()
      .then((result) => {
        if (disposed) return;
        setState({ loading: false, balance: result });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // 余额只读投影失败按 spec 静默回落（整行不渲染），不让宿主菜单挂掉；
        // 日志只记错误对象，绝不记录余额金额与完整 key。
        logger.warn("[StepCommunity] 账户余额读取失败，回落不渲染", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
        setState(IDLE_STATE);
      });
    return () => {
      disposed = true;
    };
  }, [services?.stepCommunityService, enabled]);
  return enabled ? state : IDLE_STATE;
}
