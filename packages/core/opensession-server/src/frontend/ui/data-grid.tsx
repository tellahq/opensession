/**
 * A data grid: columns across the top, rows beneath, for tabular results the
 * person scans rather than reads. The Databases view shows a table's rows
 * and a query's result through it, which is the two surfaces that make it a
 * primitive rather than a component-local table.
 *
 * Deliberately small. It draws what it is given and reports a header click;
 * paging and sorting are the caller's, because the rows usually live on a
 * server that orders them. Numbers sit on the right in tabular figures, a
 * NULL is named rather than left blank, and long text truncates on the cell
 * with the whole value on hover, so a wide row never sets the page's width.
 */

import React from "react";
import { cn } from "./cn";
import { IconArrowDown, IconArrowUp } from "../components/icons";

export type DataGridCell = string | number | null;

export interface DataGridSort {
  column: string;
  dir: "asc" | "desc";
}

export function DataGrid({
  columns,
  rows,
  sort,
  onSort,
  className,
}: {
  columns: string[];
  rows: DataGridCell[][];
  /** The current server-side order, echoed on the header. */
  sort?: DataGridSort;
  /** Present when the caller can reorder; header cells become buttons. */
  onSort?: (sort: DataGridSort) => void;
  className?: string;
}) {
  // A column is numeric when every present value in it is a number, so a
  // column of ids lines up on the right and a column of names on the left.
  // A number is the one cell value equal to its own numeric coercion; a
  // string of digits is not, which keeps "007" on the left where text goes.
  const numeric = columns.map(
    (_, index) =>
      rows.some((row) => row[index] !== null) &&
      rows.every((row) => {
        const cell = row[index];
        return cell === null || Number(cell) === cell;
      }),
  );
  const toggle = (column: string) => {
    if (!onSort) return;
    onSort({
      column,
      dir: sort?.column === column && sort.dir === "asc" ? "desc" : "asc",
    });
  };
  return (
    <div className={cn("min-h-0 min-w-0 flex-1 overflow-auto", className)}>
      <table className="w-max min-w-full border-collapse text-label">
        <thead className="sticky top-0 z-[1] bg-surface">
          <tr>
            {columns.map((column, index) => {
              const active = sort?.column === column;
              const label = (
                <span className="inline-flex max-w-[320px] items-center gap-1">
                  <span className="truncate">{column}</span>
                  {active &&
                    (sort.dir === "asc" ? (
                      <IconArrowUp size={14} dense className="shrink-0" />
                    ) : (
                      <IconArrowDown size={14} dense className="shrink-0" />
                    ))}
                </span>
              );
              return (
                <th
                  key={column}
                  scope="col"
                  aria-sort={
                    active
                      ? sort.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className={cn(
                    "whitespace-nowrap border-b border-divider px-3 py-1.5 font-medium text-dim",
                    numeric[index] ? "text-right" : "text-left",
                  )}
                >
                  {onSort ? (
                    <button
                      type="button"
                      className="-mx-1 cursor-pointer rounded-sm border-0 bg-transparent px-1 py-0.5 text-inherit hover:text-fg"
                      onClick={() => toggle(column)}
                    >
                      {label}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-hover">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    "max-w-[420px] truncate whitespace-nowrap border-b border-divider px-3 py-1.5 align-top text-fg",
                    numeric[index] && "text-right tabular-nums",
                  )}
                  title={cell === null ? undefined : String(cell)}
                >
                  {cell === null ? (
                    <span className="italic text-faint">NULL</span>
                  ) : (
                    String(cell)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
