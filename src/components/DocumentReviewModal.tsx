import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { verdictMeta, type DocumentRecord } from "@/lib/documents";
import { reviewDocument, askDocument } from "@/lib/document-review";
import { getErrorMessage } from "@/lib/error-message";
import { LoadingLine } from "@/components/LoadingLine";
import { MarkdownLite } from "@/components/MarkdownLite";

// AI Review for one document — the verdict + notes from analyze-document, the
// long-form explanation from review-document, and a Q&A box grounded in the
// file (same shape as Module 8's Ask-AI box).
export function DocumentReviewModal({
  doc,
  onClose,
  onExplanation,
}: {
  doc: DocumentRecord | null;
  onClose: () => void;
  onExplanation: (id: string, explanation: string) => void;
}) {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loadingExplanation, setLoadingExplanation] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [thread, setThread] = useState<{ q: string; a: string }[]>([]);
  // The document id we've already kicked off a review fetch for — so a
  // parent re-render (new onExplanation identity) never re-fires the call.
  const fetchedFor = useRef<string | null>(null);
  const onExplanationRef = useRef(onExplanation);
  onExplanationRef.current = onExplanation;

  const docId = doc?.id ?? null;

  useEffect(() => {
    setThread([]);
    setQuestion("");
    if (!doc) {
      setExplanation(null);
      return;
    }
    setExplanation(doc.aiExplanation ?? null);
    if (doc.aiExplanation || fetchedFor.current === doc.id) return;
    fetchedFor.current = doc.id;
    let cancelled = false;
    setLoadingExplanation(true);
    reviewDocument(doc.id)
      .then((r) => {
        if (cancelled) return;
        setExplanation(r.explanation);
        onExplanationRef.current(doc.id, r.explanation);
      })
      .catch((err) => {
        if (!cancelled) toast.error(getErrorMessage(err, "Could not generate the AI review."));
      })
      .finally(() => {
        if (!cancelled) setLoadingExplanation(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  async function submit() {
    const q = question.trim();
    if (!q || !doc || asking) return;
    setAsking(true);
    try {
      const a = await askDocument(doc.id, q);
      setThread((prev) => [...prev, { q, a }]);
      setQuestion("");
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not get an answer. Please retry."));
    } finally {
      setAsking(false);
    }
  }

  const m = verdictMeta(doc?.aiVerdict);

  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[92vw] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">AI Review — {doc?.fileName}</DialogTitle>
          <DialogDescription>
            AI reads the document itself. Answers below are grounded in what it actually says.
          </DialogDescription>
        </DialogHeader>

        {doc && (
          <div className="grid gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  m.tone === "success"
                    ? "badge-soft"
                    : m.tone === "destructive"
                      ? "badge-soft text-destructive"
                      : "badge-soft-warning"
                }
              >
                {doc.aiVerdict ? `Check: ${m.label}` : "Not checked yet"}
              </span>
            </div>
            {doc.aiNotes && <p className="text-muted-foreground">{doc.aiNotes}</p>}

            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Explanation
              </div>
              {loadingExplanation ? (
                <LoadingLine text="Reading the document…" />
              ) : explanation ? (
                <MarkdownLite text={explanation} className="text-foreground/90" />
              ) : (
                <p className="text-muted-foreground">No explanation available.</p>
              )}
            </div>

            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Ask about this document
              </div>
              {thread.length > 0 && (
                <div className="mb-2 grid gap-2">
                  {thread.map((t, i) => (
                    <div key={i} className="rounded-md bg-secondary/40 p-2">
                      <p className="text-xs font-medium">{t.q}</p>
                      <MarkdownLite text={t.a} className="text-muted-foreground mt-1 text-xs" />
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder="e.g. what account number is on this?"
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <button
                  onClick={submit}
                  disabled={asking || !question.trim()}
                  className="btn-primary btn-primary-hover text-sm disabled:opacity-60"
                >
                  {asking ? "…" : "Ask"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={onClose} className="btn-outline text-sm">
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
