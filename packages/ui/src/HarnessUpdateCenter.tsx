import { useEffect, useRef, useState } from "react";
import type { HarnessUpdateSnapshot, HarnessUpdateTarget, HarnessUpdateRequest, IPlatformService } from "@zcode/shared";
import { ArrowDownToLine, Check, Cpu, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import stepLogo from "@/assets/step-app-icon.png";
import { Button } from "@/components/ui/button.js";
import { harnessDownloadProgress } from "@/lib/harnessDownloadProgress.js";

export function HarnessUpdateCenter({ platform, initial, english }: { platform: IPlatformService; initial: HarnessUpdateSnapshot; english: boolean }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<HarnessUpdateTarget | null>(null);
  const busy = useRef(false);
  const t = (zh: string, en: string) => english ? en : zh;
  const action = async (request: HarnessUpdateRequest) => {
    if (busy.current) return;
    busy.current = true; setError("");
    try { const next = await platform.manageHarnessUpdate?.(request); if (next) setSnapshot(next); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busy.current = false; }
  };
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!busy.current) { const next = await platform.manageHarnessUpdate?.({ action: "snapshot" }); if (active && next) setSnapshot(next); }
      } catch (e) { if (active) setError(String(e)); }
      if (active) timer = setTimeout(poll, 750);
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [platform]);
  return <main data-testid="harness-update-center" className="min-h-screen bg-background px-6 pb-5 pt-12 text-foreground">
    <header className="mb-6 flex items-center gap-3">
      <img src={stepLogo} alt="" className="size-12 rounded-xl" />
      <div className="min-w-0"><h1 className="text-ui-xl font-semibold tracking-tight">{t("星辰更新", "Harness updates")}</h1><p className="mt-1 text-ui-caption text-foreground-subtle">StepFun Harness <span className="px-1 text-foreground-subtlest">/</span> {t("保持最新，继续创造", "Keep creating")}</p></div>
    </header>
    <div className="space-y-3">
      {(["desktop", "step"] as const).map(target => {
        const item = snapshot[target], state = item.state;
        const checking = state.kind === "checking", downloading = state.kind === "download-progress", ready = state.kind === "update-downloaded", available = state.kind === "update-available";
        const next = "version" in state ? state.version : undefined;
        const notes = "releaseNotes" in state ? state.releaseNotes?.markdown : "";
        const download = downloading ? harnessDownloadProgress(state, english) : undefined;
        const Icon = target === "desktop" ? Sparkles : Cpu;
        return <section key={target} data-testid={`harness-update-${target}`} className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-icon-blue"><Icon className="size-4" /></span>
            <div className="min-w-0 flex-1"><h2 className="text-ui-base font-semibold">{target === "desktop" ? t("阶跃星辰 Harness", "StepFun Harness") : t("Step Code 底座", "Step Code runtime")}</h2><p className="mt-1 text-ui-caption text-foreground-subtle">{target === "desktop" ? t("界面、交互与内置功能", "Interface, interactions and built-in features") : t("模型执行与工具运行", "Model execution and tools")}</p></div>
            <span className="font-mono text-ui-caption text-foreground-subtle">v{item.currentVersion}</span>
          </div>
          <div className="mt-4 flex min-h-8 items-center justify-between gap-3">
            <p aria-live="polite" className="flex items-center gap-1.5 text-ui-caption text-foreground-subtle">
              {checking || downloading ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : item.checked && !available && !ready && !item.error ? <Check className="size-3.5 text-icon-blue" /> : null}
              {checking ? t("正在检查…", "Checking…") : downloading ? download?.label : ready ? t("准备就绪", "Ready to install") : available ? `v${next} ${t("可更新", "available")}` : item.error ? t("检查未完成", "Check incomplete") : item.checked ? t("已是最新版本", "Up to date") : t("尚未检查", "Not checked yet")}
            </p>
            {downloading ? <Button variant="ghost" size="sm" disabled={download?.cancelling} onClick={() => void action({ action: "cancel", target })}>{t("取消", "Cancel")}</Button> :
              <Button size="sm" variant={ready || available ? "default" : "outline"} disabled={checking} onClick={() => ready ? setConfirm(target) : void action({ action: available ? "download" : "check", target })}>
                {available ? <ArrowDownToLine className="mr-1.5 size-3.5" /> : null}{ready ? t("重启并更新", "Restart & update") : available ? t("下载更新", "Download") : t("检查更新", "Check")}
              </Button>}
          </div>
          {download && <><p data-testid={`harness-update-${target}-bytes`} className="mt-1 font-mono text-ui-caption text-foreground-subtle">{download.bytes}</p><div role="progressbar" aria-label={download.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={download.determinate ? download.percent : undefined} className="mt-3 h-1 overflow-hidden rounded-full bg-border"><div className={`h-full rounded-full bg-icon-blue ${download.determinate ? "transition-[width] duration-300 motion-reduce:transition-none" : "w-1/3 animate-pulse motion-reduce:animate-none"}`} style={download.determinate ? { width: `${download.percent}%` } : undefined} /></div></>}
          {item.error && <p className="mt-2 break-words text-ui-caption text-destructive">{item.error === "HARNESS_DOWNLOAD_STALLED" ? t("下载连续 90 秒没有新进度，已停止。请检查网络后重试。", "No download progress for 90 seconds. Stopped; check your connection and retry.") : item.error.includes("404") || item.error.includes("No published versions") ? t("暂未找到已发布版本，可稍后重试。", "No published release found. Try again later.") : item.error}</p>}
          {notes && <details className="mt-3 border-t border-border pt-2 text-ui-caption text-foreground-subtle"><summary className="cursor-pointer select-none">{t("更新内容", "What's new")}</summary><p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words [scrollbar-width:none]">{notes}</p></details>}
        </section>;
      })}
    </div>
    {confirm && <div role="alertdialog" aria-label={t("确认更新", "Confirm update")} className="mt-4 rounded-xl border border-border bg-accent p-3"><p className="text-ui-caption">{t("更新会关闭软件，请先完成正在进行的任务。", "Updating closes the app. Finish active tasks first.")}</p><div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t("稍后", "Later")}</Button><Button size="sm" onClick={() => { const target = confirm; setConfirm(null); void action({ action: "install", target }); }}>{t("现在更新", "Update now")}</Button></div></div>}
    {error && <p role="alert" className="mt-3 text-ui-caption text-destructive">{error}</p>}
    <footer className="mt-5 flex items-center justify-between gap-2"><span className="text-ui-caption text-foreground-subtlest">{t("保留会话与个人设置", "Your sessions and settings stay with you")}</span><Button variant="ghost" size="sm" onClick={() => void action({ action: "check" })}><RefreshCw className="mr-1.5 size-3.5" />{t("检查全部", "Check all")}</Button></footer>
  </main>;
}
