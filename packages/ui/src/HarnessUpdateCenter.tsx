import { useEffect, useRef, useState } from "react";
import type { HarnessUpdateSnapshot, HarnessUpdateRequest, IPlatformService } from "@zcode/shared";
import { ArrowDownToLine, ArrowRight, Check, LoaderCircle, RefreshCw } from "lucide-react";
import stepLogo from "@/assets/step-app-icon.png";
import { Button } from "@/components/ui/button.js";
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel, AlertDialogAction, AlertDialogFooter } from "@/components/ui/alert-dialog.js";
import { harnessDownloadProgress } from "@/lib/harnessDownloadProgress.js";

export function HarnessUpdateCenter({ platform, initial, english }: { platform: IPlatformService; initial: HarnessUpdateSnapshot; english: boolean }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const t = (zh: string, en: string) => english ? en : zh;
  const action = async (request: HarnessUpdateRequest) => {
    if (busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try { const next = await platform.manageHarnessUpdate?.(request); if (next) setSnapshot(next); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busy.current = false; setWorking(false); }
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

  const item = snapshot.desktop, state = item.state;
  const checking = state.kind === "checking", downloading = state.kind === "download-progress";
  const ready = state.kind === "update-downloaded", available = state.kind === "update-available";
  const next = "version" in state ? state.version : undefined;
  const notes = "releaseNotes" in state ? state.releaseNotes?.markdown : "";
  const download = downloading ? harnessDownloadProgress(state, english) : undefined;
  const failure = error || (item.error === "HARNESS_DOWNLOAD_STALLED"
    ? t("下载暂时没有进展，请检查网络后重试。", "Download stalled. Check your connection and try again.")
    : item.error?.includes("404") || item.error?.includes("No published versions")
      ? t("暂未找到已发布版本，请稍后重试。", "No published release found. Please try again later.") : item.error);
  const title = checking ? t("正在检查更新", "Checking for updates")
    : downloading ? download?.label : ready ? t("更新已准备好", "Ready to update")
    : failure ? t("暂时无法完成更新", "Update couldn't be completed")
    : available ? t("发现新版本", "An update is available")
    : item.checked ? t("你已是最新版本", "You're up to date") : t("让体验保持最新", "Keep your app up to date");
  const description = ready ? t("重启软件即可完成更新。", "Restart the app to finish updating.")
    : available ? t("下载完成后，可选择合适的时间重启。", "Download now and restart when you're ready.")
    : checking ? t("正在连接更新服务…", "Connecting to the update service…")
    : item.checked ? t("下次有新版本时，会在这里提醒你。", "We'll let you know when a new version is ready.")
    : t("获取新功能、修复与体验改进。", "Get the latest features, fixes and improvements.");

  return <main data-testid="harness-update-center" className="h-screen overflow-y-auto bg-background px-6 pb-6 pt-12 font-sans text-foreground [scrollbar-width:none]">
    <div className="mx-auto flex min-h-full max-w-lg flex-col">
      <header className="flex items-center gap-3 border-b border-border pb-5">
        <img src={stepLogo} alt="" className="size-11 rounded-xl" />
        <div className="min-w-0 flex-1">
          <h1 className="text-ui-lg font-semibold tracking-tight">{t("软件更新", "Software update")}</h1>
          <p className="mt-1 text-ui-caption text-foreground-subtle">{t("阶跃星辰 Harness", "StepFun Harness")}</p>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2.5 py-1 font-mono text-ui-caption text-foreground-subtle">v{item.currentVersion}</span>
      </header>
      <section data-testid="harness-update-desktop" className="py-6">
        <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-accent text-icon-blue">
          {checking || downloading ? <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
            : ready || (item.checked && !available && !failure) ? <Check className="size-5" />
            : available ? <ArrowDownToLine className="size-5" /> : <RefreshCw className="size-5" />}
        </div>
        <h2 aria-live="polite" className="text-ui-xl font-semibold tracking-tight">{title}</h2>
        {next && <p className="mt-2 flex items-center gap-2 font-mono text-ui-caption text-foreground-subtle"><span>v{item.currentVersion}</span><ArrowRight className="size-3.5" /><span className="text-foreground">v{next}</span></p>}
        {failure ? <p role="alert" className="mt-3 break-words text-ui-caption text-destructive">{failure}</p>
          : !downloading && <p className="mt-2 text-ui-caption leading-relaxed text-foreground-subtle">{description}</p>}
        {download && <div className="mt-4">
          <div role="progressbar" aria-label={download.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={download.determinate ? download.percent : undefined} className="h-1.5 overflow-hidden rounded-full bg-border">
            <div className={`h-full rounded-full bg-icon-blue ${download.determinate ? "transition-[width] duration-300 motion-reduce:transition-none" : "w-1/3 animate-pulse motion-reduce:animate-none"}`} style={download.determinate ? { width: `${download.percent}%` } : undefined} />
          </div>
          <p data-testid="harness-update-desktop-bytes" className="mt-2 font-mono text-ui-caption text-foreground-subtle">{download.bytes}</p>
        </div>}
        <div className="mt-5 flex justify-start">
          {downloading ? <Button variant="outline" size="sm" disabled={working || download?.cancelling} onClick={() => void action({ action: "cancel", target: "desktop" })}>{t("取消下载", "Cancel download")}</Button>
            : <Button className="min-w-28" size="sm" variant={ready || available ? "default" : "outline"} disabled={working || checking} onClick={() => ready ? setConfirm(true) : void action({ action: available ? "download" : "check", target: "desktop" })}>
              {ready ? t("重启并更新", "Restart & update") : available ? t("下载更新", "Download update") : failure ? t("重试", "Try again") : t("检查更新", "Check for updates")}
            </Button>}
        </div>
      </section>
      {notes && <details className="mb-5 rounded-lg border border-border bg-surface px-3 py-2.5 text-ui-caption">
        <summary className="cursor-pointer select-none font-medium">{t("更新内容", "What's new")}</summary>
        <p className="mt-3 max-h-36 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-foreground-subtle">{notes}</p>
      </details>}
      <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent className="max-w-[calc(100vw-3rem)] font-sans">
        <AlertDialogTitle>{t("现在重启并更新？", "Restart and update now?")}</AlertDialogTitle>
        <AlertDialogDescription>{t("软件将关闭，请先完成正在进行的任务。", "The app will close. Finish any active tasks first.")}</AlertDialogDescription>
        <AlertDialogFooter><AlertDialogCancel size="sm">{t("稍后", "Later")}</AlertDialogCancel><AlertDialogAction size="sm" onClick={() => void action({ action: "install", target: "desktop" })}>{t("现在更新", "Update now")}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent></AlertDialog>
      <footer className="mt-auto border-t border-border pt-4 text-ui-caption text-foreground-subtlest">{t("更新会保留你的会话与个人设置。", "Your sessions and settings are kept when you update.")}</footer>
    </div>
  </main>;
}
