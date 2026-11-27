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
import * as stylex from "@stylexjs/stylex";
import { sx } from "./sx";
import {
  color,
  corner,
  geometry,
  layer,
  media,
  radius,
  space,
  text,
  weight,
} from "./tokens.stylex";

const RULE = {
  borderBottomStyle: "solid",
  borderBottomWidth: geometry.hairline,
  borderBottomColor: color.divider,
} as const;

const styles = stylex.create({
  scroller: { minHeight: 0, minWidth: 0, flex: "1", overflow: "auto" },
  table: {
    width: "max-content",
    minWidth: "100%",
    borderCollapse: "collapse",
    fontSize: text.label,
  },
  head: {
    position: "sticky",
    top: space.s0,
    zIndex: layer.tableHead,
    backgroundColor: color.page,
  },
  headLabel: {
    display: "inline-flex",
    maxWidth: geometry.gridHeaderMax,
    alignItems: "center",
    gap: space.s4,
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  arrow: { flexShrink: 0 },
  th: {
    ...RULE,
    whiteSpace: "nowrap",
    paddingInline: space.s12,
    paddingBlock: space.s6,
    fontWeight: weight.medium,
    color: color.dim,
  },
  left: { textAlign: "left" },
  right: { textAlign: "right" },
  sort: {
    marginInline: `calc(-1 * ${space.s4})`,
    cursor: "pointer",
    borderRadius: radius.sm,
    ["cornerShape"]: corner.squircle,
    borderWidth: 0,
    backgroundColor: color.transparent,
    paddingInline: space.s4,
    paddingBlock: space.s2,
    color: {
      default: "inherit",
      ":hover": { default: null, [media.hover]: color.fg },
    },
  },
  row: {
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
    },
  },
  td: {
    ...RULE,
    maxWidth: geometry.gridCellMax,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingInline: space.s12,
    paddingBlock: space.s6,
    verticalAlign: "top",
    color: color.fg,
  },
  numeric: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
  null: { fontStyle: "italic", color: color.faint },
});
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
    <div {...sx(styles.scroller, className)}>
      <table {...stylex.props(styles.table)}>
        <thead {...stylex.props(styles.head)}>
          <tr>
            {columns.map((column, index) => {
              const active = sort?.column === column;
              const label = (
                <span {...stylex.props(styles.headLabel)}>
                  <span {...stylex.props(styles.truncate)}>{column}</span>
                  {active &&
                    (sort.dir === "asc" ? (
                      <IconArrowUp
                        size={14}
                        dense
                        {...stylex.props(styles.arrow)}
                      />
                    ) : (
                      <IconArrowDown
                        size={14}
                        dense
                        {...stylex.props(styles.arrow)}
                      />
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
                  {...stylex.props(
                    styles.th,
                    numeric[index] ? styles.right : styles.left,
                  )}
                >
                  {onSort ? (
                    <button
                      type="button"
                      {...stylex.props(styles.sort)}
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
            <tr key={rowIndex} {...stylex.props(styles.row)}>
              {row.map((cell, index) => (
                <td
                  key={index}
                  {...stylex.props(styles.td, numeric[index] && styles.numeric)}
                  title={cell === null ? undefined : String(cell)}
                >
                  {cell === null ? (
                    <span {...stylex.props(styles.null)}>NULL</span>
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
