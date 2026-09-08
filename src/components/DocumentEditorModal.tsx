import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getDocumentUrl, uploadDocument, type DocumentRecord } from "@/lib/documents";
import { invokeEdgeFunction } from "@/lib/edge-functions";
import { getErrorMessage } from "@/lib/error-message";
import {
  readAcroForm,
  fillAcroForm,
  type PdfFieldSpec,
  type PdfFieldValues,
} from "@/lib/pdf-forms";
import { docxToText, textToPdf, textToDocx } from "@/lib/docx-edit";
import type { PropertyRecord } from "@/lib/properties";

// Which uploaded files the Documents tab offers an in-place "Edit" for.
export function isEditableDoc(doc: { fileName: string }): boolean {
  return /\.(pdf|docx)$/i.test(doc.fileName);
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

type Kind = "loading" | "pdf" | "docx" | "pdf-noform" | "error";

export function DocumentEditorModal({
  doc,
  userId,
  property,
  onClose,
  onSaved,
}: {
  doc: DocumentRecord;
  userId: string;
  property: PropertyRecord | null;
  onClose: () => void;
  onSaved: (newDoc: DocumentRecord) => void;
}) {
  const [kind, setKind] = useState<Kind>("loading");
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [fields, setFields] = useState<PdfFieldSpec[]>([]);
  const [values, setValues] = useState<PdfFieldValues>({});
  const [text, setText] = useState("");
  const [autofilling, setAutofilling] = useState(false);
  const [autofillNote, setAutofillNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setKind("loading");
    (async () => {
      try {
        const url = await getDocumentUrl(doc.storagePath);
        const buf = await (await fetch(url)).arrayBuffer();
        if (cancelled) return;
        setBytes(buf);
        if (/\.docx$/i.test(doc.fileName)) {
          setText(await docxToText(buf));
          if (!cancelled) setKind("docx");
          return;
        }
        const { fields: f } = await readAcroForm(buf);
        if (cancelled) return;
        const editable = f.filter((x) => x.type !== "unsupported" && !x.readOnly);
        if (editable.length === 0) {
          setKind("pdf-noform");
          return;
        }
        setFields(f);
        setValues(
          Object.fromEntries(
            f.map((x) => [x.name, x.type === "checkbox" ? !!x.value : (x.value ?? "")]),
          ),
        );
        setKind("pdf");
      } catch (err) {
        if (!cancelled) {
          setKind("error");
          console.error(err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  async function autofill() {
    setAutofilling(true);
    setAutofillNote(null);
    try {
      if (kind === "docx") {
        const { filledText, notes } = await invokeEdgeFunction<{
          filledText: string;
          notes: string;
        }>("suggest-doc-fields", { documentId: doc.id, text });
        setText(filledText);
        setAutofillNote(notes || "Filled from this property's data.");
      } else {
        const editableNames = fields
          .filter((x) => x.type !== "unsupported" && !x.readOnly)
          .map((x) => x.name);
        const { suggestions, notes } = await invokeEdgeFunction<{
          suggestions: { name: string; value: string }[];
          notes: string;
        }>("suggest-doc-fields", { documentId: doc.id, fields: editableNames });
        setValues((prev) => {
          const next = { ...prev };
          for (const s of suggestions) {
            const spec = fields.find((f) => f.name === s.name);
            if (!spec) continue;
            next[s.name] =
              spec.type === "checkbox" ? /^(true|yes|x|checked)$/i.test(s.value) : s.value;
          }
          return next;
        });
        setAutofillNote(
          notes || `Filled ${suggestions.length} field(s) from this property's data.`,
        );
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not autofill from AI."));
    } finally {
      setAutofilling(false);
    }
  }

  async function save(format: "pdf" | "docx") {
    if (!property) {
      toast.error("This document's property is no longer available.");
      return;
    }
    setSaving(true);
    try {
      let out: Uint8Array;
      let fileName: string;
      let mime: string;
      if (kind === "pdf" && bytes) {
        out = await fillAcroForm(bytes, values);
        fileName = `${baseName(doc.fileName)} (edited).pdf`;
        mime = "application/pdf";
      } else if (format === "docx") {
        out = await textToDocx(text);
        fileName = `${baseName(doc.fileName)} (edited).docx`;
        mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      } else {
        out = await textToPdf(text);
        fileName = `${baseName(doc.fileName)} (edited).pdf`;
        mime = "application/pdf";
      }
      // .slice() → a Uint8Array<ArrayBuffer> the File constructor's BlobPart
      // type accepts (pdf-lib's save() is typed against ArrayBufferLike).
      const file = new File([out.slice()], fileName, { type: mime });
      const newDoc = await uploadDocument(userId, property.id, file, doc.documentType, doc.id);
      onSaved(newDoc);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save the edited document."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[92vw] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">Edit — {doc.fileName}</DialogTitle>
          <DialogDescription>
            AI autofill uses this property&apos;s real data. Saving creates a new document — the
            original is kept, and the new copy is AI-checked automatically.
          </DialogDescription>
        </DialogHeader>

        {kind === "loading" && <p className="text-muted-foreground text-sm">Loading the file…</p>}
        {kind === "error" && (
          <p className="text-destructive text-sm">Couldn&apos;t open this file for editing.</p>
        )}
        {kind === "pdf-noform" && (
          <p className="text-muted-foreground text-sm">
            This PDF has no fillable form fields, so there&apos;s nothing to edit here. Use Download
            to edit it in another app.
          </p>
        )}

        {kind === "pdf" && (
          <div className="grid gap-3">
            <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-border p-3">
              <div className="grid gap-3">
                {fields.map((f) => (
                  <PdfFieldInput
                    key={f.name}
                    field={f}
                    value={values[f.name]}
                    onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
                  />
                ))}
              </div>
            </div>
            {autofillNote && <p className="text-accent text-xs">{autofillNote}</p>}
          </div>
        )}

        {kind === "docx" && (
          <div className="grid gap-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-[50vh] w-full rounded-lg border border-input bg-background p-3 text-sm font-mono"
            />
            {autofillNote && <p className="text-accent text-xs">{autofillNote}</p>}
            <p className="text-muted-foreground text-xs">
              Word formatting isn&apos;t preserved — the text is rebuilt on save.
            </p>
          </div>
        )}

        {(kind === "pdf" || kind === "docx") && (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              onClick={autofill}
              disabled={autofilling || saving}
              className="btn-outline text-sm disabled:opacity-60"
            >
              {autofilling ? "Filling…" : "AI autofill"}
            </button>
            <button onClick={onClose} className="btn-outline text-sm">
              Cancel
            </button>
            {kind === "docx" && (
              <button
                onClick={() => save("docx")}
                disabled={saving}
                className="btn-outline text-sm disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save as Word"}
              </button>
            )}
            <button
              onClick={() => save("pdf")}
              disabled={saving}
              className="btn-primary btn-primary-hover text-sm disabled:opacity-60"
            >
              {saving ? "Saving…" : kind === "docx" ? "Save as PDF" : "Save"}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PdfFieldInput({
  field,
  value,
  onChange,
}: {
  field: PdfFieldSpec;
  value: string | boolean | null | undefined;
  onChange: (v: string | boolean) => void;
}) {
  if (field.type === "unsupported") {
    return (
      <div className="text-muted-foreground text-xs">
        {field.name} — not editable here (signature or button)
      </div>
    );
  }
  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span className="min-w-0 break-words">{field.name}</span>
      </label>
    );
  }
  if ((field.type === "radio" || field.type === "dropdown") && field.options?.length) {
    return (
      <label className="grid gap-1 text-sm">
        <span className="text-xs text-muted-foreground break-words">{field.name}</span>
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1.5"
          disabled={field.readOnly}
        >
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-xs text-muted-foreground break-words">{field.name}</span>
      <input
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        readOnly={field.readOnly}
        className="rounded-md border border-input bg-background px-2 py-1.5"
      />
    </label>
  );
}
