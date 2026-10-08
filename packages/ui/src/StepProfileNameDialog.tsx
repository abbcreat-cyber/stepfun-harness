import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import stepLogo from "@/assets/step-app-icon.png";

export function StepProfileNameDialog({ open, onOpenChange, name }: { open: boolean; onOpenChange: (open: boolean) => void; name: string }) {
  const services = useOptionalServices();
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
          <DialogTitle className="text-ui-xl">你的名字</DialogTitle>
          <DialogDescription className="text-ui-base">显示在侧边栏，仅保存在这台电脑。</DialogDescription>
        </DialogHeader>
        <form className="space-y-6" onSubmit={async event => {
          event.preventDefault();
          if (saving || length < 1 || length > 24 || !services?.stepCommunityService) return;
          setSaving(true); setError("");
          try {
            await services.stepCommunityService.setDisplayName({ displayName: value.trim() });
            window.dispatchEvent(new Event("step-community-profile-changed"));
            onOpenChange(false);
          } catch (e) { setError(e instanceof Error ? e.message : "保存失败，请重试"); }
          finally { setSaving(false); }
        }}>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-ui-caption text-foreground-subtle">
              <label htmlFor="step-profile-name">用户名</label><span className="tabular-nums">{length} / 24</span>
            </div>
            <Input id="step-profile-name" value={value} onChange={event => setValue(event.target.value)} autoComplete="off" maxLength={48} disabled={saving} className="h-11 rounded-lg text-ui-base" />
            {error && <p role="alert" className="text-ui-caption text-destructive">{error}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={saving || length < 1 || length > 24} className="min-w-20 rounded-lg">{saving && <Loader2 className="size-4 animate-spin" />}保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
