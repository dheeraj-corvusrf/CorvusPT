import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
} from "pdf-lib";

// Generic AcroForm read/fill for ARBITRARY uploaded PDFs — the Documents
// tab's "Edit" for an editable PDF. (protest-documents.ts has its own,
// schema-driven fill for the two known Comptroller forms; this one has no
// schema and works off whatever fields the file actually declares.)

export type PdfFieldType = "text" | "checkbox" | "radio" | "dropdown" | "unsupported";

export type PdfFieldSpec = {
  name: string;
  type: PdfFieldType;
  value: string | boolean | null;
  options?: string[];
  readOnly: boolean;
};

// The value a caller passes back per field name: a string for text/dropdown/
// radio (the option to select), a boolean for a checkbox.
export type PdfFieldValues = Record<string, string | boolean | null | undefined>;

export function hasAcroForm(bytes: ArrayBuffer | Uint8Array): Promise<boolean> {
  return PDFDocument.load(bytes, { ignoreEncryption: true }).then((doc) => {
    try {
      return doc.getForm().getFields().length > 0;
    } catch {
      return false;
    }
  });
}

export async function readAcroForm(
  bytes: ArrayBuffer | Uint8Array,
): Promise<{ fields: PdfFieldSpec[] }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const fields: PdfFieldSpec[] = [];
  for (const field of form.getFields()) {
    const name = field.getName();
    const readOnly = safe(() => field.isReadOnly(), false);
    if (field instanceof PDFTextField) {
      fields.push({
        name,
        type: "text",
        value: safe(() => field.getText() ?? null, null),
        readOnly,
      });
    } else if (field instanceof PDFCheckBox) {
      fields.push({
        name,
        type: "checkbox",
        value: safe(() => field.isChecked(), false),
        readOnly,
      });
    } else if (field instanceof PDFRadioGroup) {
      fields.push({
        name,
        type: "radio",
        value: safe(() => field.getSelected() ?? null, null),
        options: safe(() => field.getOptions(), []),
        readOnly,
      });
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      fields.push({
        name,
        type: "dropdown",
        value: safe(() => field.getSelected()[0] ?? null, null),
        options: safe(() => field.getOptions(), []),
        readOnly,
      });
    } else {
      // Signature / button / anything pdf-lib can't plain-fill — surfaced so
      // the user sees it exists, but not editable here.
      fields.push({ name, type: "unsupported", value: null, readOnly: true });
    }
  }
  return { fields };
}

export async function fillAcroForm(
  bytes: ArrayBuffer | Uint8Array,
  values: PdfFieldValues,
  opts: { flatten?: boolean } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  for (const field of form.getFields()) {
    const v = values[field.getName()];
    if (v === undefined) continue;
    try {
      if (field instanceof PDFTextField) {
        field.setText(typeof v === "string" ? v : v == null ? "" : String(v));
      } else if (field instanceof PDFCheckBox) {
        if (v) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (typeof v === "string" && v) field.select(v);
      } else if (
        (field instanceof PDFDropdown || field instanceof PDFOptionList) &&
        typeof v === "string" &&
        v
      ) {
        field.select(v);
      }
    } catch {
      // One bad field shouldn't fail the whole save — mirrors
      // protest-documents.ts's own fail-soft fill.
    }
  }
  if (opts.flatten) {
    try {
      form.flatten();
    } catch {
      // Some forms with exotic widgets can't flatten cleanly — keep the
      // filled-but-live form rather than losing the values.
    }
  }
  return doc.save();
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
