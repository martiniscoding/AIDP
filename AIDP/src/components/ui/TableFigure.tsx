import { cn } from "@/lib/cn";
import type { TableView } from "@/lib/ingest/documents";
import { gridColumns, tableGrid } from "@/lib/ingest/parsed-tables";

/**
 * A table from a document, drawn as the document drew it.
 *
 * One component for every place a stored table surfaces — the parsed view, a
 * finding's evidence, a coverage gap — because the alternative is three
 * renderings that drift until the same table reads three ways.
 *
 * Everything it shows comes from `TableBlock`, which keeps the headers, every
 * row, and every empty cell as an explicit null. The flattened line text that
 * these places used to print — "Category: Programming Languages | Comments:
 * V 11" — is the parser's reading transcript, and it drops a row's empty cells,
 * so a five-column row arrives with three columns missing and nothing saying so.
 *
 * `highlightRows` is for evidence: a chunk of kind `table_row` is one row, and
 * showing the whole table without saying which row was cited would answer a
 * question nobody asked. The rows are marked, the rest is context. It takes
 * several because one finding routinely cites two rows of the same table, and
 * drawing that table twice to mark one row each time asks the reviewer to spot
 * the difference between two pictures.
 */
export function TableFigure({
  table,
  bare = false,
  highlightRows,
  caption,
}: {
  table: TableView;
  /** Quieter border, for a table sitting inside another bordered block. */
  bare?: boolean;
  /** The rows this table was cited for. Empty when it was cited whole. */
  highlightRows?: number[];
  /** Overrides the caption line. */
  caption?: string;
}) {
  const columns = gridColumns(table.columns, table.rows);
  const body = tableGrid(columns, table.rows);
  const highlighted = new Set(highlightRows ?? []);
  return (
    <figure
      className={cn(
        "overflow-hidden rounded-md bg-card",
        bare ? "border border-line-soft" : "border border-line",
      )}
    >
      <figcaption className="flex flex-wrap items-baseline gap-2 border-b border-line-soft px-2.5 py-1.5 text-[11.5px] text-ink/70">
        <span className="min-w-0 flex-1">
          {caption ?? table.caption ?? `Table ${table.ordinal}`}
        </span>
        {/* Below 1 the parser was unsure of the shape — a merged cell, a row
            that ran over a page break. Shown, because a table silently
            reshaped is the worst kind of parse error. */}
        {table.confidence < 1 && (
          <span className="text-warn">
            shape uncertain · {Math.round(table.confidence * 100)}%
          </span>
        )}
        {table.pageStart != null && (
          <span className="tabular-nums text-ink/55">p{table.pageStart}</span>
        )}
      </figcaption>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11.5px]">
          {columns.length > 0 && (
            <thead>
              <tr>
                {columns.map((column, index) => (
                  <th
                    key={index}
                    scope="col"
                    className="border-b border-line-soft px-2 py-1 text-left align-bottom font-medium text-ink/72"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((row, rowIndex) => {
              const cited = highlighted.has(rowIndex);
              return (
                <tr key={rowIndex} className={cn(cited && "bg-royal/10")}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={cn(
                        "border-b border-line-soft px-2 py-1 align-top",
                        cited ? "text-ink/92" : "text-ink/78",
                        // A blank cell is content: Tier 4's RPO is blank on
                        // purpose and must not read as Tier 3's.
                        cell === "" && !cited && "bg-canvas-sunk/70",
                      )}
                    >
                      {/* The document's own line breaks inside a cell are part
                          of the value — "v5.7.28 / 8.0" is two versions. */}
                      {cell === "" ? (
                        <span className="text-ink/40">—</span>
                      ) : (
                        <span className="whitespace-pre-wrap">{cell}</span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {body.length === 0 && (
        <p className="px-2.5 py-2 text-[11.5px] text-warn">
          Columns were found but no rows were extracted.
        </p>
      )}
    </figure>
  );
}
