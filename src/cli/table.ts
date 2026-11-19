import type { Evidence, Report } from "../domain/domain.ts";

export interface TabWriterOptions {
  minwidth?: number;
  padding?: number;
  padChar?: string;
}

function runeCount(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

/**
 * Formats tab-delimited text identically to Go's
 * `text/tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)`:
 * - Each `\t` terminates an aligned cell; text after the last `\t` is emitted verbatim with no trailing spaces.
 * - Lines without a `\t` at column `c` terminate that column's alignment block, so independent sections reset widths.
 * - Cell width is measured in Unicode code points (matching Go's utf8.RuneCountInString).
 */
export function formatTabWriter(input: string, options: TabWriterOptions = {}): string {
  if (input.length === 0) {
    return "";
  }
  const minwidth = options.minwidth ?? 0;
  const padding = options.padding ?? 2;
  const padChar = options.padChar ?? " ";

  const hasTrailingNewline = input.endsWith("\n");
  const rawLines = (hasTrailingNewline ? input.slice(0, -1) : input).split("\n");
  const rows = rawLines.map((line) => line.split("\t"));

  let maxCols = 0;
  for (const row of rows) {
    const cellCount = row.length - 1;
    if (cellCount > maxCols) {
      maxCols = cellCount;
    }
  }

  const widths: number[][] = rows.map((row) => new Array<number>(Math.max(0, row.length - 1)).fill(0));

  for (let col = 0; col < maxCols; col += 1) {
    let rowIdx = 0;
    while (rowIdx < rows.length) {
      const currentRow = rows[rowIdx];
      if (!currentRow || currentRow.length - 1 <= col) {
        rowIdx += 1;
        continue;
      }

      const start = rowIdx;
      let blockWidth = minwidth;
      while (rowIdx < rows.length) {
        const candidate = rows[rowIdx];
        if (!candidate || candidate.length - 1 <= col) {
          break;
        }
        const cell = candidate[col] ?? "";
        const width = runeCount(cell) + padding;
        if (width > blockWidth) {
          blockWidth = width;
        }
        rowIdx += 1;
      }

      for (let i = start; i < rowIdx; i += 1) {
        const rowWidths = widths[i];
        if (rowWidths) {
          rowWidths[col] = blockWidth;
        }
      }
    }
  }

  const formattedLines = rows.map((row, rowIdx) => {
    const cellCount = row.length - 1;
    if (cellCount === 0) {
      return row[0] ?? "";
    }
    const rowWidths = widths[rowIdx];
    let out = "";
    for (let col = 0; col < cellCount; col += 1) {
      const cell = row[col] ?? "";
      const targetWidth = rowWidths?.[col] ?? 0;
      const padCount = Math.max(0, targetWidth - runeCount(cell));
      out += cell + padChar.repeat(padCount);
    }
    out += row[cellCount] ?? "";
    return out;
  });

  return formattedLines.join("\n") + (hasTrailingNewline ? "\n" : "");
}

function formatCounts(counts: Record<string, number>): string {
  const keys = Object.keys(counts);
  if (keys.length === 0) {
    return "-";
  }
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys.map((key) => `${key}:${counts[key]}`).join(" ");
}

function formatEvidenceObservedAt(observedAt: string): string {
  // Go's time.RFC3339 omits fractional seconds while preserving timezone suffix.
  return observedAt.replace(/\.\d+(?=(?:Z|[+-]\d{2}:\d{2})$)/, "");
}

function appendEvidenceRows(
  lines: string[],
  repository: string,
  kind: string,
  condition: string,
  subject: string,
  evidence: readonly Evidence[],
): void {
  for (let i = 0; i < evidence.length; i += 1) {
    const e = evidence[i];
    if (!e) {
      continue;
    }
    lines.push(
      `${repository}\t${kind}\t${condition}\t${subject}\t${i + 1}\t${e.method}\t${e.confidence}\t${formatEvidenceObservedAt(e.observed_at)}\t${e.source}\t${e.description}\n`,
    );
  }
}

function appendJudgments(lines: string[], report: Report): void {
  let hasJudgments = false;
  for (const r of report.repositories) {
    if (r.findings.length > 0 || r.expected_updates.length > 0) {
      hasJudgments = true;
      break;
    }
  }
  if (!hasJudgments) {
    return;
  }

  lines.push("\nJUDGMENTS\n");
  lines.push("REPOSITORY\tKIND\tCONDITION\tSUBJECT\tCONFIDENCE\tPR AGE\tDETAIL\n");
  for (const r of report.repositories) {
    for (const f of r.findings) {
      lines.push(
        `${r.repository}\tfinding\t${f.type}\t${f.subject.kind}:${f.subject.id}\t${f.confidence}\t-\t${f.detail}\n`,
      );
    }
    for (const u of r.expected_updates) {
      const age =
        u.pr_age_days !== undefined
          ? `${Object.is(u.pr_age_days, -0) ? 0 : u.pr_age_days}d`
          : "-";
      lines.push(
        `${r.repository}\texpected_update\t${u.state}\t${u.manifest}:${u.dependency}\t${u.confidence}\t${age}\t${u.detail}\n`,
      );
    }
  }

  lines.push("\nEVIDENCE\n");
  lines.push("REPOSITORY\tKIND\tCONDITION\tSUBJECT\t#\tMETHOD\tCONFIDENCE\tOBSERVED AT\tSOURCE\tDESCRIPTION\n");
  for (const r of report.repositories) {
    for (const f of r.findings) {
      appendEvidenceRows(
        lines,
        r.repository,
        "finding",
        f.type,
        `${f.subject.kind}:${f.subject.id}`,
        f.evidence,
      );
    }
    for (const u of r.expected_updates) {
      appendEvidenceRows(
        lines,
        r.repository,
        "expected_update",
        u.state,
        `${u.manifest}:${u.dependency}`,
        u.evidence,
      );
    }
  }
}

/**
 * Projects a Report into the human-readable table view.
 * The JSON output is the primary contract; this view adds no information of its own.
 */
export function renderTable(report: Report): string {
  const lines: string[] = [];
  // The column is the rollup label, never "state": CONTEXT.md reserves
  // state for lifecycle positions. Scan errors are listed apart — the
  // inability to judge must not read like a judged condition.
  lines.push("REPOSITORY\tROLLUP\tCONDITIONS\n");
  for (const r of report.repositories) {
    lines.push(`${r.repository}\t${r.rollup.label}\t${formatCounts(r.rollup.counts)}\n`);
  }
  appendJudgments(lines, report);
  if (report.scan_errors.length > 0) {
    lines.push("\nSCAN ERRORS\n");
    for (const e of report.scan_errors) {
      lines.push(`${e.repository}\t${e.stage}\t${e.message}\n`);
    }
  }
  return formatTabWriter(lines.join(""), { minwidth: 0, padding: 2, padChar: " " });
}
