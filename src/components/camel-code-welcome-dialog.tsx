import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WaveRibbon } from "@/components/wave-ribbon";

export function CamelCodeWelcomeDialog({
  open,
  onOpenChange,
  onSeePremiumModels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSeePremiumModels: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <div className="relative h-36">
          <WaveRibbon className="absolute inset-0" speed={2.5} scale={0.4} />
          <div className="absolute inset-0 flex items-center px-6">
            <p className="font-[family-name:var(--font-display)] text-3xl font-normal italic tracking-tight">
              Let&apos;s build something
            </p>
          </div>
        </div>
        <div className="space-y-4 px-6 pb-6">
          <DialogHeader className="text-center">
            <DialogTitle className="text-base">
              You&apos;re on camelCode
            </DialogTitle>
            <DialogDescription className="mx-auto max-w-[44ch] text-pretty text-sm/relaxed">
              <span className="block">
                Test out camelAI with camelCode, our free coding model. New chats use GPT-6.2 Sol.
                It&apos;s shared with other free users, so{" "}
                <span className="font-medium text-foreground">
                  replies can slow down at busy times.
                </span>
              </span>
              <span className="mt-2 block">
                Subscribe for premium models and priority access to camelCode.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-center">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                onSeePremiumModels();
              }}
            >
              See premium models
            </Button>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Start building free
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
