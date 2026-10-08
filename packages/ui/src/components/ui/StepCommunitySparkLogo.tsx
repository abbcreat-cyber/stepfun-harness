import { cn } from "@/components/lib/utils.js";
import stepAppIcon from "@/assets/step-app-icon.png";

/**
 * Step-Code 社区模式的获批品牌标，与原生桌面图标使用同一画稿。
 *
 * 独立于上游 ZCodeAboutLogo（Z 字标，已恢复上游原样）：上游组件被引导页与登录页
 * 无条件复用，社区星标只能在本组件承载、由调用方以 getStatus().active 为条件选用，
 * 保证不设 STEP_BACKEND 时 logo 与上游完全一致（铁律 1）。
 */
export function StepCommunitySparkLogo({ className }: { className?: string }) {
  return (
    <img
      src={stepAppIcon}
      alt=""
      width="100"
      height="100"
      className={cn("shrink-0 object-contain", className)}
      aria-hidden="true"
    />
  );
}

/**
 * Step-Code 社区模式（阶跃星辰）的空态水印：浅色主题=太阳线框，深色主题=月牙+四角星。
 *
 * 替代上游 ZCodeEmptyStateLogo（Z 水印）在同一容器里的位置，由调用方以
 * useStepCommunityStatus().active 为条件选用，保证不设 STEP_BACKEND 时与上游一致。
 * 细线 currentColor、渐隐 mask 与透明度沿用容器既有的水印处理，不引入新色板；
 * 深色分支不走 mask（与上游"渐隐只属于浅色线框"的处理惯例一致）。
 */
export function StepCommunityCelestialWatermark({ className }: { className?: string }) {
  return (
    <>
      {/* 浅色：太阳（圆 + 八道光线）。 */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="400"
        height="320"
        viewBox="0 0 400 320"
        fill="none"
        className={cn(
          className,
          "opacity-70 dark:hidden",
          "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
          "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
          "[mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
          "[mask-repeat:no-repeat] [mask-size:100%_100%]",
        )}
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="200" cy="160" r="64" stroke="currentColor" strokeWidth="3" />
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <line x1="200" y1="72" x2="200" y2="44" />
          <line x1="200" y1="248" x2="200" y2="276" />
          <line x1="112" y1="160" x2="84" y2="160" />
          <line x1="288" y1="160" x2="316" y2="160" />
          <line x1="262.2" y1="97.8" x2="282" y2="78" />
          <line x1="137.8" y1="97.8" x2="118" y2="78" />
          <line x1="137.8" y1="222.2" x2="118" y2="242" />
          <line x1="262.2" y1="222.2" x2="282" y2="242" />
        </g>
      </svg>
      {/* 深色：月牙 + 两颗四角星（呼应品牌星标）。 */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="400"
        height="320"
        viewBox="0 0 400 320"
        fill="none"
        className={cn(className, "hidden dark:block opacity-60")}
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M240 70 A96 96 0 1 0 240 250 A72 72 0 0 0 240 70 Z"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path
          fill="currentColor"
          opacity="0.9"
          transform="translate(166 51) scale(0.65)"
          d="M206 28 C209 46 214 51 232 54 C214 57 209 62 206 80 C203 62 198 57 180 54 C198 51 203 46 206 28 Z"
        />
        <path
          fill="currentColor"
          opacity="0.6"
          transform="translate(189.6 22.4) scale(0.4)"
          d="M206 28 C209 46 214 51 232 54 C214 57 209 62 206 80 C203 62 198 57 180 54 C198 51 203 46 206 28 Z"
        />
      </svg>
    </>
  );
}
