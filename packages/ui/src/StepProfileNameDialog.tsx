import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import stepLogo from "@/assets/step-app-icon.png";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export function StepProfileNameDialog({ open, onOpenChange, name }: { open: boolean; onOpenChange: (open: boolean) => void; name: string }) {
  const services = useOptionalServices();
  const { intl } = useZCodeIntl();
  // 跟随应用语言翻译整个弹窗，不只翻译侧边栏入口。
  const t = (key: string) => intl.formatMessage({ id: `sidebar.profile.stepCommunity.rename.${key}` });
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setValue(name); setError(""); } }, [open, name]);
  const length = Array.from(value.trim()).length;
  return (
    <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="max-w-sm gap-6 rounded-2xl p-6">
        <DialogHeader className="gap-2">
          <img src={stepLogo} alt="" className="mb-2 size-10 rounded-xl" />
          <DialogTitle className="text-ui-xl">{t("title")}</DialogTitle>
          <DialogDescription className="text-ui-base">{t("description")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-6" onSubmit={async event => {
          event.preventDefault();
          if (saving || length < 1 || length > 24 || !services?.stepCommunityService) return;
          setSaving(true); setError("");
          try {
            await services.stepCommunityService.setDisplayName({ displayName: value.trim() });
            window.dispatchEvent(new Event("step-community-profile-changed"));
            onOpenChange(false);
          } catch (e) { logger.warn("[step-profile] 保存用户名失败", e); setError("saveFailed"); }
          finally { setSaving(false); }
        }}>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-ui-caption text-foreground-subtle">
              <label htmlFor="step-profile-name">{t("label")}</label><span className="tabular-nums">{length} / 24</span>
            </div>
            <Input id="step-profile-name" value={value} onChange={event => setValue(event.target.value)} autoComplete="off" maxLength={48} disabled={saving} className="h-11 rounded-lg text-ui-base" />
            {error && <p role="alert" className="text-ui-caption text-destructive">{t(error)}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>{intl.formatMessage({ id: "common.cancel" })}</Button>
            <Button type="submit" disabled={saving || length < 1 || length > 24} className="min-w-20 rounded-lg">{saving && <Loader2 className="size-4 animate-spin" />}{intl.formatMessage({ id: "common.save" })}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
