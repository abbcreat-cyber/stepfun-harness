import type { UpdateStatePayload } from "@zcode/shared";

export function harnessDownloadProgress(state: Extract<UpdateStatePayload, { kind: "download-progress" }>, english: boolean) {
  const t = (zh: string, en: string) => english ? en : zh;
  const received = Math.max(0, state.transferredBytes ?? 0);
  const total = Math.max(0, state.totalBytes ?? 0);
  const phase = state.downloadPhase ?? (received > 0 ? "transferring" : "preparing");
  const percent = Math.max(0, Math.min(100, Number.parseFloat(state.progress) || 0));
  const determinate = phase === "transferring" && total > 0;
  const percentage = received > 0 && percent < 0.1 ? "<0.1" : String(Math.round(percent * 10) / 10);
  const label = phase === "preparing" ? t("正在连接并准备下载…", "Connecting and preparing download…")
    : phase === "verifying" ? t("下载完成，正在校验…", "Download complete, verifying…")
    : phase === "cancelling" ? t("正在取消…", "Cancelling…")
    : determinate ? `${t("下载中", "Downloading")} ${percentage}%` : t("正在接收更新…", "Receiving update…");
  const bytes = received > 0 || total > 0
    ? `${formatBytes(received)}${total > 0 ? ` / ${formatBytes(total)}` : ""}${state.bytesPerSecond && state.bytesPerSecond > 0 ? ` · ${formatBytes(state.bytesPerSecond)}/s` : ""}`
    : t("连接服务器和读取更新索引期间暂无百分比", "Waiting for the server and update index");
  return { label, bytes, determinate, percent, cancelling: phase === "cancelling" };
}

function formatBytes(value: number) {
  if (value < 1000) return `${Math.round(value)} B`;
  if (value < 1000000) return `${(value / 1000).toFixed(1)} KB`;
  return `${(value / 1000000).toFixed(2)} MB`;
}
