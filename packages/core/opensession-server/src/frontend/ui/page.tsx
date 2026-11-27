import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { PageDescription, PageHeader, PageTitle } from "./page-header";
import { sx } from "./sx";
import { geometry, media, space } from "./tokens.stylex";

export type PageContentWidth = "narrow" | "default" | "wide" | "full";

const styles = stylex.create({
  scroller: { minHeight: 0, width: "100%", flex: "1", overflowY: "auto" },
  column: {
    marginInline: "auto",
    width: "100%",
    paddingInline: { default: space.s24, [media.narrow]: space.s14 },
    paddingBottom: { default: geometry.pageBottom, [media.narrow]: space.s48 },
    paddingTop: {
      default: geometry.pageTop,
      [media.narrow]: geometry.pageTopNarrow,
    },
  },
  section: { marginInline: "auto", width: "100%" },
  narrow: { maxWidth: geometry.pageNarrow },
  default: { maxWidth: geometry.pageDefault },
  wide: { maxWidth: geometry.pageWide },
  full: { maxWidth: "none" },
  actions: { width: { default: null, [media.phone]: "100%" } },
  filters: {
    marginTop: `calc(-1 * ${space.s6})`,
    marginBottom: geometry.pageFiltersGap,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s10,
  },
});

interface PageLayoutProps extends Omit<
  React.ComponentPropsWithoutRef<"div">,
  "title"
> {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  filters?: React.ReactNode;
  contentWidth?: PageContentWidth;
}

export function PageLayout({
  title,
  description,
  actions,
  filters,
  contentWidth = "default",
  className,
  children,
  ...props
}: PageLayoutProps) {
  return (
    <div
      // The scroller the app's top bar watches, so it can reveal the compact
      // title once this page has travelled under it. Read by App.tsx through
      // hooks/useScrollEdge.ts; it styles nothing.
      data-page-scroll
      {...sx(styles.scroller, className)}
      {...props}
    >
      <div {...stylex.props(styles.column, styles[contentWidth])}>
        <PageHeader>
          <div>
            <PageTitle>{title}</PageTitle>
            {description !== undefined && (
              <PageDescription>{description}</PageDescription>
            )}
          </div>
          {actions !== undefined && (
            <div {...stylex.props(styles.actions)}>{actions}</div>
          )}
        </PageHeader>
        {filters !== undefined && (
          <div {...stylex.props(styles.filters)}>{filters}</div>
        )}
        {children}
      </div>
    </div>
  );
}

interface PageSectionProps extends React.ComponentPropsWithoutRef<"div"> {
  contentWidth?: PageContentWidth;
}

export function PageSection({
  contentWidth = "default",
  className,
  ...props
}: PageSectionProps) {
  return (
    <div
      {...sx([styles.section, styles[contentWidth]], className)}
      {...props}
    />
  );
}
