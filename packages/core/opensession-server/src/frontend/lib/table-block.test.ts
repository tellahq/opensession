import { describe, expect, test } from "bun:test";
import { REPLACED_FENCE_SELECTOR, fenceUpgraderFor } from "./fence-upgraders";
import {
  MAX_COLUMNS,
  detectDelimiter,
  filterRows,
  isNumericColumn,
  parseDelimited,
  parseNumber,
  parseTable,
  rowCountLabel,
  sortRows,
  tableUpgrader,
  toCsv,
} from "./table-block";

describe("parseDelimited", () => {
  test("splits fields and records", () => {
    expect(parseDelimited("a,b,c\n1,2,3\n", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  test("CRLF ends a record like LF", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("a quoted field keeps the delimiter, doubled quotes and line breaks", () => {
    expect(
      parseDelimited('name,note\n"Smith, J","said ""hi""\nthen left"\n', ","),
    ).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
    ]);
  });

  test("an unquoted field is trimmed, a quoted one is not", () => {
    expect(parseDelimited('a , " b "\n', ",")).toEqual([["a", " b "]]);
  });

  test("a quote inside an unquoted field is literal", () => {
    expect(parseDelimited('size,part\n5" pipe,x\n', ",")).toEqual([
      ["size", "part"],
      ['5" pipe', "x"],
    ]);
  });

  test("a trailing delimiter is an empty last field; no trailing newline is fine", () => {
    expect(parseDelimited("a,b,\n1,2", ",")).toEqual([
      ["a", "b", ""],
      ["1", "2"],
    ]);
  });

  test("a backslash escapes a pipe, and only a pipe", () => {
    expect(parseDelimited("a \\| b|c", "|")).toEqual([["a | b", "c"]]);
    expect(parseDelimited("a \\| b,c", ",")).toEqual([["a \\| b", "c"]]);
    expect(parseDelimited("a\\b|c", "|")).toEqual([["a\\b", "c"]]);
  });

  test("tabs delimit a tsv", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("detectDelimiter", () => {
  test("picks the most frequent candidate on the first non-empty line", () => {
    expect(detectDelimiter("\na;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a,b,c\n")).toBe(",");
    expect(detectDelimiter("a\tb\n")).toBe("\t");
    expect(detectDelimiter("| a | b |\n")).toBe("|");
  });

  test("a tab beats a comma in prose-like cells", () => {
    expect(detectDelimiter("name\tcity, state\n")).toBe("\t");
  });

  test("an escaped pipe does not count as one", () => {
    expect(detectDelimiter("a \\| b, c \\| d, e")).toBe(",");
  });

  test("null when nothing delimits", () => {
    expect(detectDelimiter("just words\nmore words")).toBeNull();
  });
});

describe("parseTable", () => {
  test("csv: first row is the header, numeric columns are flagged", () => {
    const t = parseTable("name,qty,price\nA,2,$1,200\nB,10,$3.50\n", "csv");
    expect(t).not.toBeNull();
    expect(t!.header).toEqual(["name", "qty", "price"]);
    expect(t!.rows).toEqual([
      ["A", "2", "$1,200"],
      ["B", "10", "$3.50"],
    ]);
    expect(t!.numeric).toEqual([false, true, true]);
  });

  test("table: auto-detects the delimiter", () => {
    expect(parseTable("a;b\n1;2\n", "table")!.rows).toEqual([["1", "2"]]);
    expect(parseTable("a\tb\n1\t2\n", "table")!.rows).toEqual([["1", "2"]]);
  });

  test("table: a GitHub pipe table drops its edges and the rule", () => {
    const t = parseTable("| a | b |\n|---|:-:|\n| 1 | 2 |\n", "table");
    expect(t!.header).toEqual(["a", "b"]);
    expect(t!.rows).toEqual([["1", "2"]]);
  });

  test("table: only the rule under the header is dropped; dashes below are data", () => {
    const t = parseTable(
      "|key|value|\n|---|---|\n|first|ok|\n|---|---|\n|last|ok|\n",
      "table",
    );
    expect(t!.rows).toEqual([
      ["first", "ok"],
      ["---", "---"],
      ["last", "ok"],
    ]);
  });

  test("table: escaped pipes are literal cell content, not columns", () => {
    const lines = ["| name | expr |", "|---|---|"];
    for (let i = 0; i < 10; i++) lines.push(`| r${i} | A \\| B |`);
    lines.push("| tail | ends \\|");
    const t = parseTable(lines.join("\n"), "table");
    expect(t!.header).toEqual(["name", "expr"]);
    expect(t!.rows).toHaveLength(11);
    expect(t!.rows[0]).toEqual(["r0", "A | B"]);
    expect(t!.rows[10]).toEqual(["tail", "ends |"]);
  });

  test("blank lines are skipped", () => {
    expect(parseTable("a,b\n\n1,2\n\n", "csv")!.rows).toEqual([["1", "2"]]);
  });

  test("fewer than two rows declines", () => {
    expect(parseTable("a,b\n", "csv")).toBeNull();
    expect(parseTable("", "csv")).toBeNull();
  });

  test("a one-column header declines", () => {
    expect(parseTable("a\n1\n2\n", "csv")).toBeNull();
    expect(parseTable("prose\nmore prose\n", "table")).toBeNull();
  });

  test("a header wider than MAX_COLUMNS declines; one at the limit renders", () => {
    const wide = (cols: number) => {
      const row = Array.from({ length: cols }, (_, i) => String(i)).join(",");
      return `${row}\n${row}\n`;
    };
    expect(parseTable(wide(MAX_COLUMNS), "csv")!.header).toHaveLength(
      MAX_COLUMNS,
    );
    expect(parseTable(wide(MAX_COLUMNS + 1), "csv")).toBeNull();
    // A line of 120,000 commas fits an asset preview and is not a table.
    const commas = ",".repeat(120_000);
    expect(parseTable(`${commas}\n${commas}\n`, "csv")).toBeNull();
    // Long rows past the header still fold into the last cell within the
    // tolerance, so the cap is on the header alone.
    const long = `a,b\n1,2\n${",".repeat(MAX_COLUMNS + 5)}\n`;
    expect(parseTable(long, "csv")!.rows[1]).toHaveLength(2);
  });

  test("one short row in ten is padded (the row still streaming)", () => {
    const t = parseTable("a,b,c\n1,2,3\n4,5", "csv");
    expect(t!.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", ""],
    ]);
  });

  test("one long row folds its overflow into the last cell", () => {
    const t = parseTable("a,b\n1,2\n3,4,5,6\n", "csv");
    expect(t!.rows).toEqual([
      ["1", "2"],
      ["3", "4,5,6"],
    ]);
  });

  test("ragged rows past the tolerance decline", () => {
    const lines = ["a,b,c"];
    for (let i = 0; i < 10; i++) lines.push(`${i},x,y`);
    // 13 body rows allow ceil(13 / 10) = 2 ragged ones; 12 allow 2 as well.
    lines.push("ragged", "ragged", "ragged");
    expect(parseTable(lines.join("\n"), "csv")).toBeNull();
    lines.pop();
    expect(parseTable(lines.join("\n"), "csv")).not.toBeNull();
  });
});

describe("parseNumber", () => {
  test("plain, signed, decimal, thousands, currency, percent", () => {
    expect(parseNumber("42")).toBe(42);
    expect(parseNumber("-3.5")).toBe(-3.5);
    expect(parseNumber("+7")).toBe(7);
    expect(parseNumber("1,234,567.89")).toBe(1234567.89);
    expect(parseNumber("$1,200")).toBe(1200);
    expect(parseNumber("-$12")).toBe(-12);
    expect(parseNumber("€9.99")).toBe(9.99);
    expect(parseNumber("12.5%")).toBe(12.5);
    expect(parseNumber(".5")).toBe(0.5);
    expect(parseNumber(" 8 ")).toBe(8);
  });

  test("not numbers", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("-")).toBeNull();
    expect(parseNumber("$")).toBeNull();
    expect(parseNumber("1,2")).toBeNull();
    expect(parseNumber("1.2.3")).toBeNull();
    expect(parseNumber("12px")).toBeNull();
    expect(parseNumber("2024-01-02")).toBeNull();
    expect(parseNumber("1e5")).toBeNull();
  });
});

describe("isNumericColumn", () => {
  const rows = [
    ["a", "1", ""],
    ["b", "2.5", ""],
    ["3", "", ""],
  ];
  test("every non-empty cell must parse; empties are ignored", () => {
    expect(isNumericColumn(rows, 0)).toBe(false);
    expect(isNumericColumn(rows, 1)).toBe(true);
  });
  test("an all-empty column is not numeric", () => {
    expect(isNumericColumn(rows, 2)).toBe(false);
  });
});

describe("sortRows", () => {
  const rows = [
    ["b", "10"],
    ["a", "9"],
    ["", "1,000"],
    ["C", ""],
    ["a", "2"],
  ];

  test("numeric columns sort as numbers, empties last", () => {
    expect(sortRows(rows, 1, "asc", true).map((r) => r[1])).toEqual([
      "2",
      "9",
      "10",
      "1,000",
      "",
    ]);
    expect(sortRows(rows, 1, "desc", true).map((r) => r[1])).toEqual([
      "1,000",
      "10",
      "9",
      "2",
      "",
    ]);
  });

  test("text columns sort case-insensitively, stable, empties last", () => {
    expect(sortRows(rows, 0, "asc", false)).toEqual([
      ["a", "9"],
      ["a", "2"],
      ["b", "10"],
      ["C", ""],
      ["", "1,000"],
    ]);
    expect(sortRows(rows, 0, "desc", false).map((r) => r[0])).toEqual([
      "C",
      "b",
      "a",
      "a",
      "",
    ]);
  });

  test("text sort is natural for embedded numbers", () => {
    const named = [["file10"], ["file2"], ["file1"]];
    expect(sortRows(named, 0, "asc", false).map((r) => r[0])).toEqual([
      "file1",
      "file2",
      "file10",
    ]);
  });

  test("does not mutate its input", () => {
    const copy = rows.map((r) => [...r]);
    sortRows(rows, 0, "asc", false);
    expect(rows).toEqual(copy);
  });
});

describe("filterRows", () => {
  const rows = [
    ["Alice", "Paris"],
    ["Bob", "Berlin"],
    ["Carol", "paris"],
  ];
  test("substring across all cells, case-insensitive", () => {
    expect(filterRows(rows, "PAR").map((r) => r[0])).toEqual([
      "Alice",
      "Carol",
    ]);
    expect(filterRows(rows, "bob").map((r) => r[0])).toEqual(["Bob"]);
  });
  test("blank query keeps everything", () => {
    expect(filterRows(rows, "  ")).toEqual(rows);
  });
});

describe("toCsv", () => {
  test("quotes only what needs it and round-trips", () => {
    const header = ["name", "note"];
    const rows = [
      ["plain", "x"],
      ["with, comma", 'say "hi"'],
      ["multi\nline", ""],
    ];
    const csv = toCsv(header, rows);
    expect(csv).toBe(
      'name,note\nplain,x\n"with, comma","say ""hi"""\n"multi\nline",',
    );
    expect(parseDelimited(csv, ",")).toEqual([header, ...rows]);
  });
});

describe("rowCountLabel", () => {
  test("counts and narrows", () => {
    expect(rowCountLabel(1, 1)).toBe("1 row");
    expect(rowCountLabel(20, 20)).toBe("20 rows");
    expect(rowCountLabel(3, 20)).toBe("3 of 20 rows");
    expect(rowCountLabel(0, 20)).toBe("0 of 20 rows");
  });

  test("says when the grid shows fewer rows than match", () => {
    expect(rowCountLabel(3000, 3000, 500)).toBe("first 500 of 3,000 rows");
    expect(rowCountLabel(1200, 3000, 500)).toBe("first 500 of 1,200 matches");
    expect(rowCountLabel(400, 3000, 400)).toBe("400 of 3,000 rows");
  });
});

describe("registry", () => {
  test("csv, tsv and table fences are claimed by the table upgrader", () => {
    for (const lang of ["csv", "tsv", "table", "CSV"]) {
      expect(fenceUpgraderFor(lang)).toBe(tableUpgrader);
    }
  });

  test("the block replaces the fence, so the copy control leaves it alone", () => {
    for (const lang of ["csv", "tsv", "table"]) {
      expect(REPLACED_FENCE_SELECTOR).toContain(
        `code[class~="language-${lang}"]`,
      );
    }
  });
});
