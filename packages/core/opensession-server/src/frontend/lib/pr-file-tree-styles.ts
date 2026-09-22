/** Pierre renders in a shadow root, so its supported CSS hook owns these rules.
 * Keep complete names in the tree's horizontal scrollport, not two clipped halves.
 * Twelve-pixel levels preserve hierarchy without spending a glyph-width per level.
 */
export const REVIEW_TREE_CSS = `
  :host { --trees-padding-inline-override: 8px; }
  [data-file-tree-virtualized-list='true'] {
    width: max-content;
    min-width: 100%;
  }
  [data-item-section='content'] {
    flex: 0 0 auto;
    min-width: max-content;
    max-width: none;
    overflow: visible;
  }
  [data-item-section='spacing'] {
    flex-shrink: 0;
    padding-left: 0;
    margin-right: calc(-1 * var(--trees-item-row-gap));
  }
  [data-item-section='spacing-item'] {
    box-sizing: border-box;
    flex: 0 0 12px;
    margin: 0;
    transform: none;
  }
  [data-item-section='spacing-item'] + [data-item-section='spacing-item'] {
    margin-left: 0;
  }
`;
