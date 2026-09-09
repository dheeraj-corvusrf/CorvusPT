import { Fragment, type ReactNode } from "react";

// A deliberately small markdown renderer for the AI-review / assistant text
// fields (see BULLET_STYLE in supabase/functions/_shared/prose-style.ts).
// It covers exactly what those prompts are told to emit — "- " / "* " and
// "1." lists, GFM pipe tables, **bold**, `code`, and plain paragraphs —
// and nothing else. No dependency, no arbitrary HTML.

function renderInline(text: string, keyBase: string): ReactNode[] {
  // Split on **bold** and `code`, keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return (
        <strong key={`${keyBase}-${i}`} className="font-semibold text-foreground">
          {p.slice(2, -2)}
        </strong>
      );
    }
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <code key={`${keyBase}-${i}`} className="rounded bg-secondary px-1 text-[0.85em]">
          {p.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={`${keyBase}-${i}`}>{p}</Fragment>;
  });
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

export function MarkdownLite({ text, className }: { text: string; className?: string }) {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — block separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // GFM table: a header row, then a |---|---| separator row.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}.*\|/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-border">
                {header.map((h, c) => (
                  <th key={c} className="py-1.5 pr-3 font-semibold text-muted-foreground">
                    {renderInline(h, `th-${key}-${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-border/50 last:border-0">
                  {r.map((cell, ci) => (
                    <td key={ci} className="py-1.5 pr-3 align-top">
                      {renderInline(cell, `td-${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Unordered list.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="list-disc space-y-1 pl-5">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it, `li-${key}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="list-decimal space-y-1 pl-5">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it, `ol-${key}-${n}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-structural lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].includes("|")
    ) {
      para.push(lines[i].replace(/^#+\s*/, "")); // strip any stray heading markers
      i++;
    }
    if (para.length) {
      blocks.push(<p key={key++}>{renderInline(para.join(" "), `p-${key}`)}</p>);
    } else {
      i++;
    }
  }

  return <div className={`grid gap-2 ${className ?? ""}`}>{blocks}</div>;
}
