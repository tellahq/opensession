/**
 * Autofill opt-out for the composers.
 *
 * A composer holds prose, not a saved value, so form autofill has nothing to
 * offer it: all it does is drop a menu of names, emails and logins over the
 * field the moment it takes focus, and a suggestion bar over the keyboard on
 * phones. `autoComplete` turns off the browser's own. The `data-*` attributes
 * are the per-extension opt-outs, because 1Password, LastPass, Bitwarden and
 * Dashlane each ignore `autocomplete="off"` and read their own attribute
 * instead.
 *
 * Spread onto the field itself. On a wrapper it does nothing.
 */
export const noAutofill = {
  autoComplete: "off",
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;
