import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { listProperties, type PropertyRecord } from "@/lib/properties";
import {
  listDocuments,
  getDocumentUrl,
  deleteDocument,
  analyzeDocument,
  renameDocument,
  docCategory,
  sourceLabel,
  standardDocName,
  previewKind,
  verdictMeta,
  type DocumentRecord,
} from "@/lib/documents";
import {
  classifyAndUpload,
  classifyAndUploadToProperty,
  assignAndUpload,
  type CategorizedUpload,
} from "@/lib/document-categorize";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ChevronDown, Eye, Download, Trash2 } from "lucide-react";

export const Route = createFileRoute("/dashboard/_layout/documents")({
  component: Documents,
});

function Documents() {
  const { user } = useAuth();
  const [properties, setProperties] = useState<PropertyRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploads, setUploads] = useState<CategorizedUpload[]>([]);
  const [uploadingPropertyId, setUploadingPropertyId] = useState<string | null>(null);
  const [viewDoc, setViewDoc] = useState<DocumentRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;
    Promise.all([listProperties(user.id), listDocuments(user.id)])
      .then(([props, docs]) => {
        setProperties(props);
        setDocuments(docs);
      })
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  }, [user]);

  async function handleDownload(doc: DocumentRecord) {
    try {
      const url = await getDocumentUrl(doc.storagePath);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open this document.");
    }
  }

  async function handleDelete(doc: DocumentRecord) {
    if (!window.confirm(`Delete "${doc.fileName}"? This can't be undone.`)) return;
    setDeletingId(doc.id);
    try {
      await deleteDocument(doc);
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      if (viewDoc?.id === doc.id) setViewDoc(null);
      toast.success("Document deleted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete this document.");
    } finally {
      setDeletingId(null);
    }
  }

  function patchDoc(id: string, patch: Partial<DocumentRecord>) {
    setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    setViewDoc((v) => (v && v.id === id ? { ...v, ...patch } : v));
  }

  async function handleAnalyze(doc: DocumentRecord): Promise<void> {
    setAnalyzingIds((prev) => new Set(prev).add(doc.id));
    try {
      const a = await analyzeDocument(doc.id);
      patchDoc(doc.id, {
        category: a.category,
        source: a.source,
        aiVerdict: a.verdict,
        aiNotes: a.notes,
        aiCrossRefs: a.crossRefs.join("\n") || null,
        aiCheckedAt: a.aiCheckedAt,
        suggestedName: a.suggestedName,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not analyze this document.");
    } finally {
      setAnalyzingIds((prev) => {
        const next = new Set(prev);
        next.delete(doc.id);
        return next;
      });
    }
  }

  // Sequential (not Promise.all) — one Gemini call per file at a time, same
  // reasoning as every other bulk action here.
  async function handleAnalyzeAll(docs: DocumentRecord[]): Promise<void> {
    for (const doc of docs) {
      if (!doc.aiCheckedAt) await handleAnalyze(doc);
    }
  }

  async function handleRename(doc: DocumentRecord, name: string) {
    try {
      await renameDocument(doc.id, name);
      patchDoc(doc.id, { fileName: name });
      toast.success("Renamed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rename this document.");
    }
  }

  // One classify-then-upload call per file, sequentially — not Promise.all,
  // same reasoning as every other bulk action this session (Bulk Invite,
  // bulk delete): a slow or failing file shouldn't race every other file's
  // AI call at once, and each row's status updates as its own turn finishes
  // instead of the whole batch going from "processing" to "done" together.
  async function handleFilesSelected(files: File[]) {
    if (!user || files.length === 0) return;
    const pending: CategorizedUpload[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      file,
      status: "classifying",
      extraction: null,
      matchedProperty: null,
      document: null,
      error: null,
    }));
    setUploads((prev) => [...pending, ...prev]);

    for (const file of files) {
      const result = await classifyAndUpload(user.id, properties, file);
      setUploads((prev) => prev.map((u) => (u.id === result.id ? result : u)));
      if (result.status === "done" && result.document) {
        setDocuments((prev) => [result.document!, ...prev]);
      }
    }
  }

  async function handleAssignProperty(upload: CategorizedUpload, propertyId: string) {
    if (!user) return;
    const property = properties.find((p) => p.id === propertyId);
    if (!property) return;
    setUploads((prev) => prev.map((u) => (u.id === upload.id ? { ...u, status: "uploading" } : u)));
    const result = await assignAndUpload(user.id, property, upload);
    setUploads((prev) => prev.map((u) => (u.id === result.id ? result : u)));
    if (result.status === "done" && result.document) {
      setDocuments((prev) => [result.document!, ...prev]);
    }
  }

  function dismissUpload(id: string) {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }

  // Property already known (this is the upload button right on that
  // property's own row), so there's no matching step — straight to
  // classify-and-upload for each file, sequentially like the other upload
  // paths above. Toasts a combined result instead of adding to the
  // top-of-page `uploads` list, since these never need a "needs-property"
  // resolution — they're either done or failed.
  async function handleUploadToProperty(property: PropertyRecord, files: File[]) {
    if (!user || files.length === 0) return;
    setUploadingPropertyId(property.id);
    let succeeded = 0;
    const failures: string[] = [];
    for (const file of files) {
      const result = await classifyAndUploadToProperty(user.id, property, file);
      if (result.status === "done" && result.document) {
        setDocuments((prev) => [result.document!, ...prev]);
        succeeded++;
      } else {
        failures.push(result.error ?? `${file.name} — failed`);
      }
    }
    setUploadingPropertyId(null);
    if (failures.length === 0) {
      toast.success(`${succeeded} document${succeeded === 1 ? "" : "s"} uploaded.`);
    } else if (succeeded > 0) {
      toast.error(`${succeeded} uploaded, ${failures.length} failed: ${failures.join("; ")}`);
    } else {
      toast.error(`Could not upload: ${failures.join("; ")}`);
    }
  }

  // Grouped by property — a flat list with the address buried in each
  // row's caption made it genuinely hard to tell at a glance which
  // documents belong to which property, especially for staff reviewing a
  // customer's account with several properties. One card per property,
  // including properties with zero documents yet — each row carries its
  // own Upload button now, so an empty property still needs to be visible
  // to actually use it.
  const groups: { label: string; docs: DocumentRecord[]; property: PropertyRecord | null }[] =
    properties.map((property) => ({
      label: property.address,
      docs: documents.filter((d) => d.propertyId === property.id),
      property,
    }));
  // Documents whose property was since removed still need to be reachable
  // — never silently dropped just because the grouping key no longer
  // resolves to a live property. No Upload button for this one (property
  // is null) — there's no live property left to attach a new file to.
  const orphanedDocs = documents.filter((d) => !properties.some((p) => p.id === d.propertyId));
  if (orphanedDocs.length > 0) {
    groups.push({ label: "Property removed", docs: orphanedDocs, property: null });
  }

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">Documents</h1>
      <p className="text-muted-foreground text-sm">
        Documents you upload during property intake land here automatically — or upload several at
        once below and AI sorts each one to the right property. Run an AI check on any file to
        classify it, confirm it belongs to that property, flag anything off, and get a suggested
        name.
      </p>

      <div className="mt-6 card-elev p-6">
        <h2 className="font-semibold">Upload Documents</h2>
        <p className="text-sm text-muted-foreground">
          Select any number of appraisal notices, tax bills, or other property tax documents — no
          need to sort them first. AI reads each one and matches it to the right property by its
          account number or address.
        </p>
        <label
          className={`btn-primary btn-primary-hover mt-3 inline-flex w-fit cursor-pointer text-sm ${
            !user ? "pointer-events-none opacity-60" : ""
          }`}
        >
          Choose Files
          <input
            type="file"
            accept="application/pdf,image/*"
            multiple
            disabled={!user}
            className="hidden"
            onChange={(e) => {
              const selected = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = "";
              if (selected.length > 0) handleFilesSelected(selected);
            }}
          />
        </label>

        {uploads.length > 0 && (
          <div className="mt-4 grid gap-2">
            {uploads.map((upload) => (
              <UploadRow
                key={upload.id}
                upload={upload}
                properties={properties}
                onAssign={(propertyId) => handleAssignProperty(upload, propertyId)}
                onDismiss={() => dismissUpload(upload.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-6">
        {loading ? (
          <div className="grid gap-4">
            {[0, 1].map((i) => (
              <div key={i} className="card-elev p-4">
                <Skeleton className="h-5 w-56" />
                <div className="mt-3 grid gap-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : groups.length > 0 ? (
          <div className="grid gap-4">
            {groups.map((group) => (
              <PropertyDocGroup
                key={group.label}
                group={group}
                onView={setViewDoc}
                onDownload={handleDownload}
                onDelete={handleDelete}
                onAnalyze={handleAnalyze}
                onAnalyzeAll={handleAnalyzeAll}
                onRename={handleRename}
                deletingId={deletingId}
                analyzingIds={analyzingIds}
                onUpload={(files) =>
                  group.property && handleUploadToProperty(group.property, files)
                }
                uploading={uploadingPropertyId === group.property?.id}
                defaultExpanded={groups.length === 1}
              />
            ))}
          </div>
        ) : (
          <div className="card-elev p-8 text-center">
            <h3 className="font-serif text-xl font-semibold">No documents yet.</h3>
            <p className="text-muted-foreground mt-1">
              Documents you upload during property intake are stored here automatically.
            </p>
          </div>
        )}
      </div>

      <DocumentViewerModal
        doc={viewDoc}
        onClose={() => setViewDoc(null)}
        onDownload={handleDownload}
        onAnalyze={handleAnalyze}
        onRename={handleRename}
        analyzing={viewDoc ? analyzingIds.has(viewDoc.id) : false}
      />
    </div>
  );
}

function VerdictBadge({ doc }: { doc: DocumentRecord }) {
  const m = verdictMeta(doc.aiVerdict);
  const cls =
    m.tone === "success"
      ? "badge-soft"
      : m.tone === "destructive"
        ? "badge-soft text-destructive"
        : "badge-soft-warning";
  return <span className={cls}>{doc.aiVerdict ? `AI: ${m.label}` : "AI: not checked"}</span>;
}

function DocumentViewerModal({
  doc,
  onClose,
  onDownload,
  onAnalyze,
  onRename,
  analyzing,
}: {
  doc: DocumentRecord | null;
  onClose: () => void;
  onDownload: (doc: DocumentRecord) => void;
  onAnalyze: (doc: DocumentRecord) => void;
  onRename: (doc: DocumentRecord, name: string) => void;
  analyzing: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const kind = doc ? previewKind(doc.fileName) : "none";

  useEffect(() => {
    if (!doc) {
      setUrl(null);
      setError(false);
      return;
    }
    let cancelled = false;
    setUrl(null);
    setError(false);
    getDocumentUrl(doc.storagePath)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[92vw] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{doc?.fileName}</DialogTitle>
          {doc && (
            <DialogDescription>
              {standardDocName(doc, null)} · uploaded{" "}
              {new Date(doc.uploadedAt).toLocaleDateString()}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="bg-secondary/40 grid min-h-[45vh] place-items-center overflow-hidden rounded-lg">
          {error ? (
            <p className="text-destructive p-6 text-sm">Couldn't load this document.</p>
          ) : !url ? (
            <p className="text-muted-foreground p-6 text-sm">Loading…</p>
          ) : kind === "pdf" ? (
            <iframe title={doc?.fileName ?? "Document"} src={url} className="h-[60vh] w-full" />
          ) : kind === "image" ? (
            <img
              src={url}
              alt={doc?.fileName ?? "Document"}
              className="max-h-[60vh] w-auto object-contain"
            />
          ) : (
            <p className="text-muted-foreground p-6 text-sm">
              No inline preview for this file type — use Download.
            </p>
          )}
        </div>

        {doc && (
          <div className="border-border rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">AI check</span>
              <button
                onClick={() => onAnalyze(doc)}
                disabled={analyzing}
                className="btn-outline text-xs disabled:opacity-60"
              >
                {analyzing ? "Analyzing…" : doc.aiCheckedAt ? "Re-check" : "Run check"}
              </button>
            </div>
            {doc.aiCheckedAt ? (
              <div className="mt-2 grid gap-2">
                <VerdictBadge doc={doc} />
                {doc.aiNotes && <p className="text-muted-foreground text-xs">{doc.aiNotes}</p>}
                {doc.aiCrossRefs && (
                  <ul className="text-muted-foreground grid gap-1 text-xs">
                    {doc.aiCrossRefs.split("\n").map((line, i) => (
                      <li key={i}>· {line}</li>
                    ))}
                  </ul>
                )}
                {doc.suggestedName && doc.suggestedName !== doc.fileName && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Suggested name:</span>
                    <code className="bg-secondary rounded px-1.5 py-0.5">{doc.suggestedName}</code>
                    <button
                      onClick={() => onRename(doc, doc.suggestedName!)}
                      className="btn-outline text-xs"
                    >
                      Apply
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground mt-2 text-xs">
                Not checked yet — run a check to classify it, confirm it belongs to this property,
                and get a suggested name.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {doc && (
            <button onClick={() => onDownload(doc)} className="btn-outline text-sm">
              Download
            </button>
          )}
          <button onClick={onClose} className="btn-primary btn-primary-hover text-sm">
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UploadRow({
  upload,
  properties,
  onAssign,
  onDismiss,
}: {
  upload: CategorizedUpload;
  properties: PropertyRecord[];
  onAssign: (propertyId: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-md bg-secondary/40 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{upload.file.name}</div>
          {upload.status === "done" && upload.matchedProperty && (
            <div className="text-xs text-success">
              Matched to {upload.matchedProperty.address}
              {upload.extraction?.documentType ? ` — ${upload.extraction.documentType}` : ""}
            </div>
          )}
          {upload.status === "error" && (
            <div className="text-xs text-destructive">{upload.error}</div>
          )}
          {upload.status === "needs-property" && (
            <div className="text-xs text-muted-foreground">
              AI couldn't tell which property this belongs to — pick one below.
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(upload.status === "classifying" || upload.status === "uploading") && (
            <span className="text-xs text-muted-foreground">
              {upload.status === "classifying" ? "Reading…" : "Uploading…"}
            </span>
          )}
          {upload.status === "done" && <span className="text-xs text-success">✓ Uploaded</span>}
          {(upload.status === "done" || upload.status === "error") && (
            <button
              type="button"
              onClick={onDismiss}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
      {upload.status === "needs-property" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) onAssign(e.target.value);
            }}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          >
            <option value="" disabled>
              Choose a property…
            </option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.address}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

function PropertyDocGroup({
  group,
  onView,
  onDownload,
  onDelete,
  onAnalyze,
  onAnalyzeAll,
  onRename,
  deletingId,
  analyzingIds,
  onUpload,
  uploading,
  defaultExpanded,
}: {
  group: { label: string; docs: DocumentRecord[]; property: PropertyRecord | null };
  onView: (doc: DocumentRecord) => void;
  onDownload: (doc: DocumentRecord) => void;
  onDelete: (doc: DocumentRecord) => void;
  onAnalyze: (doc: DocumentRecord) => void;
  onAnalyzeAll: (docs: DocumentRecord[]) => void;
  onRename: (doc: DocumentRecord, name: string) => void;
  deletingId: string | null;
  analyzingIds: Set<string>;
  onUpload: (files: File[]) => void;
  uploading: boolean;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded && group.docs.length > 0);
  const hasDocs = group.docs.length > 0;
  const checked = group.docs.filter((d) => d.aiCheckedAt);
  const issues = group.docs.filter((d) => d.aiVerdict === "issues" || d.aiVerdict === "invalid");
  const unchecked = group.docs.filter((d) => !d.aiCheckedAt);
  const anyAnalyzing = group.docs.some((d) => analyzingIds.has(d.id));
  const summary = hasDocs
    ? [
        `${checked.length}/${group.docs.length} checked`,
        issues.length > 0 ? `${issues.length} need${issues.length === 1 ? "s" : ""} a look` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div className="card-elev p-4">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => hasDocs && setExpanded((e) => !e)}
          disabled={!hasDocs}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          {hasDocs && (
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          )}
          <span className="min-w-0">
            <h2 className="truncate font-semibold">{group.label}</h2>
            {summary && <span className="text-muted-foreground text-xs">{summary}</span>}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-3">
          {hasDocs && unchecked.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setExpanded(true);
                onAnalyzeAll(group.docs);
              }}
              disabled={anyAnalyzing}
              className="btn-outline text-xs disabled:opacity-60"
            >
              {anyAnalyzing ? "Checking…" : `Check ${unchecked.length}`}
            </button>
          )}
          {group.property && (
            <label
              className={`btn-outline text-xs cursor-pointer ${uploading ? "pointer-events-none opacity-60" : ""}`}
            >
              {uploading ? "Uploading…" : "Upload"}
              <input
                type="file"
                accept="application/pdf,image/*"
                multiple
                disabled={uploading}
                className="hidden"
                onChange={(e) => {
                  const selected = e.target.files ? Array.from(e.target.files) : [];
                  e.target.value = "";
                  if (selected.length > 0) {
                    setExpanded(true);
                    onUpload(selected);
                  }
                }}
              />
            </label>
          )}
          <span className="text-xs text-muted-foreground">
            {group.docs.length} document{group.docs.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 grid gap-2">
          {group.docs.map((doc) => {
            const cat = docCategory(doc);
            const analyzing = analyzingIds.has(doc.id);
            return (
              <div
                key={doc.id}
                className="row-hover flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md px-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {standardDocName(doc, group.property?.accountNumber ?? null)}
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="truncate">{doc.fileName}</span>
                    <span aria-hidden="true">·</span>
                    <span>{new Date(doc.uploadedAt).toLocaleDateString()}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <span className="badge-soft">{cat.label}</span>
                    <span className="badge-soft bg-secondary text-muted-foreground">
                      {sourceLabel(cat.source)}
                    </span>
                    {cat.feeds && (
                      <span className="badge-soft bg-secondary text-muted-foreground">
                        Feeds: {cat.feeds}
                      </span>
                    )}
                    <VerdictBadge doc={doc} />
                  </div>
                  {doc.aiVerdict && doc.aiVerdict !== "valid" && doc.aiNotes && (
                    <p className="text-muted-foreground mt-1 text-xs">{doc.aiNotes}</p>
                  )}
                  {doc.suggestedName && doc.suggestedName !== doc.fileName && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">Rename to</span>
                      <code className="bg-secondary rounded px-1 py-0.5">{doc.suggestedName}</code>
                      <button
                        onClick={() => onRename(doc, doc.suggestedName!)}
                        className="text-accent-foreground underline underline-offset-2"
                      >
                        Apply
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => onAnalyze(doc)}
                    disabled={analyzing}
                    className="btn-outline text-sm disabled:opacity-60"
                    aria-label={`AI check ${doc.fileName}`}
                  >
                    {analyzing ? "Checking…" : doc.aiCheckedAt ? "Re-check" : "Check"}
                  </button>
                  <button
                    onClick={() => onView(doc)}
                    className="btn-outline text-sm"
                    aria-label={`View ${doc.fileName}`}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    View
                  </button>
                  <button
                    onClick={() => onDownload(doc)}
                    className="btn-outline text-sm"
                    aria-label={`Download ${doc.fileName}`}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => onDelete(doc)}
                    disabled={deletingId === doc.id}
                    className="btn-outline text-destructive text-sm disabled:opacity-50"
                    aria-label={`Delete ${doc.fileName}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
