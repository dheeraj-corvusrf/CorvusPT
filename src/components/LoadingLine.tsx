import { Loader2 } from "lucide-react";

// A one-line "…working" indicator with a spinner — for the brief bare-text
// waits scattered around the app (reading a document, checking a property
// type, loading a file) that previously showed motionless text.
export function LoadingLine({ text, className }: { text: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-muted-foreground ${className ?? ""}`}>
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}
