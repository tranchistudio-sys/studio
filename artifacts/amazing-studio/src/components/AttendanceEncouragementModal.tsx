import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  getAttendanceMessage,
  type AttendanceMessageResult,
  type PunchFeedback,
} from "@/lib/attendance-messages";
import { cn } from "@/lib/utils";
import { Sparkles, AlertTriangle, PartyPopper, ThumbsUp } from "lucide-react";

const TONE_ICON = {
  positive: ThumbsUp,
  neutral: Sparkles,
  warning: AlertTriangle,
  celebrate: PartyPopper,
} as const;

const TONE_RING = {
  positive: "border-emerald-200 bg-emerald-50/80",
  neutral: "border-slate-200 bg-slate-50/80",
  warning: "border-amber-200 bg-amber-50/80",
  celebrate: "border-violet-200 bg-violet-50/80",
} as const;

const TONE_TITLE = {
  positive: "text-emerald-800",
  neutral: "text-slate-800",
  warning: "text-amber-900",
  celebrate: "text-violet-800",
} as const;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  feedback: PunchFeedback | null;
  /** Precomputed message; if omitted, derived from feedback when open. */
  message?: AttendanceMessageResult | null;
};

export function AttendanceEncouragementModal({
  open,
  onOpenChange,
  feedback,
  message: messageProp,
}: Props) {
  const msg =
    messageProp ?? (feedback ? getAttendanceMessage(feedback) : null);
  if (!msg) return null;

  const Icon = TONE_ICON[msg.tone];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("sm:max-w-md z-[200]", TONE_RING[msg.tone])}
        onPointerDownOutside={e => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex flex-col items-center gap-3 pt-2 text-center">
            <div
              className={cn(
                "flex h-14 w-14 items-center justify-center rounded-full border-2",
                TONE_RING[msg.tone],
              )}
            >
              <Icon className={cn("h-7 w-7", TONE_TITLE[msg.tone])} />
            </div>
            <DialogTitle className={cn("text-xl", TONE_TITLE[msg.tone])}>
              {msg.title}
            </DialogTitle>
            {msg.statusLine && (
              <p className="text-sm font-medium text-muted-foreground">{msg.statusLine}</p>
            )}
            <p className="text-base leading-relaxed text-foreground/90">{msg.description}</p>
          </div>
        </DialogHeader>
        <DialogFooter className="sm:justify-center pt-2">
          <Button
            type="button"
            className="min-w-[120px] bg-gradient-to-r from-rose-500 to-purple-600 hover:from-rose-600 hover:to-purple-700"
            onClick={() => onOpenChange(false)}
          >
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
