import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

// Portaled to document.body rather than rendered inline: PdfFormEditor opens
// a second Modal nested inside CaseDetailModal's own Modal (to review/fill a
// document mid-case), and without a portal the inner modal's `position:
// fixed` gets trapped by the outer modal's backdrop-blur-sm — backdrop-filter
// establishes a CSS containing block for fixed descendants, same as
// transform/filter would — shrinking and scroll-merging the inner modal into
// the outer one's box instead of covering the real viewport. Portaling to
// body sidesteps that regardless of how deeply a Modal is nested in the tree.
export function Modal({
  children,
  onClose,
  wide,
}: {
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  // Without this, the page behind the modal keeps scrolling along with it —
  // there's nothing else stopping wheel/touch input from reaching the body
  // underneath the fixed overlay. Restores whatever overflow value was already
  // on body (rather than assuming "") so nesting one Modal inside another (see
  // the portal comment below) doesn't have the inner modal's cleanup
  // incorrectly re-enable scroll while the outer one is still open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Real keyboard-dismiss path (previously the only way to close was mouse: the
  // backdrop click below, or tabbing all the way to the X button) — Escape is the
  // conventional, expected way to close any modal/dialog.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    // The backdrop itself is a deliberate exception to jsx-a11y's interactive-element
    // rules: it's a purely decorative dismiss convenience for mouse users, not the
    // only way to close this modal — real keyboard access is the Escape handler above
    // plus the focusable Close button below, both of which work regardless of the
    // backdrop. Adding a role/tabindex here would instead make the backdrop itself a
    // confusing, meaningless stop in the tab order.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4 bg-primary/60 backdrop-blur-sm backdrop-fade-in print:hidden"
      onClick={onClose}
    >
      {/* Stops a click inside the modal content from bubbling up to the backdrop's
          onClose above — not a real interactive element, just propagation
          management, hence the same justified exception. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        className={`relative overflow-hidden card-elev ${wide ? "w-[90vw] max-w-5xl" : "w-full max-w-lg"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute top-3 right-3 z-10 grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-all hover:scale-110 hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
        {/* overflow-x-hidden (not overflow-auto on both axes) is deliberate —
            modal content should always wrap/truncate to fit, never force a
            left-right scrollbar (a real regression this fixed: several
            shared row components — icon + AI-generated text in a flex row —
            were missing min-w-0 on the text child, so long text pushed the
            row, and the whole modal, wider instead of wrapping). This is a
            safety net on top of that real fix, not a substitute for it —
            content that still overflows horizontally now clips instead of
            becoming scrollable, which is a much more visible bug to catch. */}
        <div className="p-6 pr-12 max-h-[90vh] overflow-y-auto overflow-x-hidden">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
