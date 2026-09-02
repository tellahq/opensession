import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type ShikiTransformer,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { z } from "zod";
import bash from "@shikijs/langs/bash";
import typescript from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import javascript from "@shikijs/langs/javascript";
import jsx from "@shikijs/langs/jsx";
import json from "@shikijs/langs/json";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import yaml from "@shikijs/langs/yaml";
import markdown from "@shikijs/langs/markdown";
import sql from "@shikijs/langs/sql";
import diff from "@shikijs/langs/diff";
import toml from "@shikijs/langs/toml";
import rust from "@shikijs/langs/rust";
import swift from "@shikijs/langs/swift";
import githubDark from "@shikijs/themes/github-dark-default";
import githubLight from "@shikijs/themes/github-light-default";
import rescriptGrammar from "./rescript.tmLanguage.json";
import { LANG_BY_EXT } from "./lang";

type GrammarRule = LanguageRegistration["patterns"][number];

const grammarRuleSchema: z.ZodType<GrammarRule> = z.lazy(() =>
  z.looseObject({
    include: z.string().optional(),
    name: z.string().optional(),
    contentName: z.string().optional(),
    match: z.union([z.string(), z.instanceof(RegExp)]).optional(),
    captures: z.record(z.string(), grammarRuleSchema).optional(),
    begin: z.union([z.string(), z.instanceof(RegExp)]).optional(),
    beginCaptures: z.record(z.string(), grammarRuleSchema).optional(),
    end: z.union([z.string(), z.instanceof(RegExp)]).optional(),
    endCaptures: z.record(z.string(), grammarRuleSchema).optional(),
    while: z.union([z.string(), z.instanceof(RegExp)]).optional(),
    whileCaptures: z.record(z.string(), grammarRuleSchema).optional(),
    patterns: z.array(grammarRuleSchema).optional(),
    repository: z.record(z.string(), grammarRuleSchema).optional(),
    applyEndPatternLast: z.boolean().optional(),
  }),
);

const languageRegistrationSchema: z.ZodType<LanguageRegistration> =
  z.looseObject({
    name: z.string(),
    scopeName: z.string(),
    patterns: z.array(grammarRuleSchema),
    repository: z.record(z.string(), grammarRuleSchema),
  });

const rescript = languageRegistrationSchema.parse({
  ...rescriptGrammar,
  name: "rescript",
});
let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubDark, githubLight],
      langs: [
        bash,
        typescript,
        tsx,
        javascript,
        jsx,
        json,
        css,
        html,
        yaml,
        markdown,
        sql,
        diff,
        toml,
        rust,
        swift,
        rescript,
      ],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

function splitGutter(content: string): { nums: string[]; code: string } | null {
  const lines = content.split("\n");
  const formats: { re: RegExp; sep?: string }[] = [
    { re: /^(\s*\d+)\t/ },
    { re: /^(\d+[-:])/, sep: "--" },
  ];
  for (const { re, sep } of formats) {
    const matches = lines.map((line) => line.match(re));
    const separators = lines.map((line) => sep !== undefined && line === sep);
    const nonEmpty = lines.filter(Boolean).length;
    const matched =
      matches.filter(Boolean).length + separators.filter(Boolean).length;
    if (matched === 0 || matched < nonEmpty * 0.8) continue;
    const width = Math.max(...matches.map((match) => match?.[1].length ?? 0));
    return {
      nums: lines.map((_, index) =>
        separators[index]
          ? sep!
          : matches[index]
            ? `${matches[index]![1].padStart(width)} `
            : "",
      ),
      code: lines
        .map((line, index) =>
          separators[index]
            ? ""
            : matches[index]
              ? line.slice(matches[index]![0].length)
              : line,
        )
        .join("\n"),
    };
  }
  return null;
}

function gutterTransformer(nums: string[]): ShikiTransformer {
  return {
    line(node, line) {
      node.children.unshift({
        type: "element",
        tagName: "span",
        properties: { class: "shiki-gutter" },
        children: [{ type: "text", value: nums[line - 1] ?? "" }],
      });
    },
  };
}

export interface ShikiRequest {
  code: string;
  lang: string;
  theme: "dark" | "light";
  gutter?: boolean;
  requireGutter?: boolean;
}

export async function renderShiki(
  request: ShikiRequest,
): Promise<string | null> {
  const highlighter = await getHighlighter();
  const resolved =
    LANG_BY_EXT[request.lang.toLowerCase()] ?? request.lang.toLowerCase();
  if (!highlighter.getLoadedLanguages().includes(resolved)) return null;
  const split = request.gutter ? splitGutter(request.code) : null;
  if (request.requireGutter && !split) return null;
  return highlighter.codeToHtml(split ? split.code : request.code, {
    lang: resolved,
    theme:
      request.theme === "light"
        ? "github-light-default"
        : "github-dark-default",
    transformers: split ? [gutterTransformer(split.nums)] : [],
  });
}
