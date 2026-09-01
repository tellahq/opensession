# Settings

Settings controls personal preferences and instance configuration. Users navigate sections, search settings, change a value, and confirm that it survives navigation or reload.

## Sub-features

- `settings-navigation` opens Account, Preferences, Setup, Providers, Connections, and other allowed sections.
- `settings-search` finds a section or control from the settings search field.
- `settings-personal` persists browser or user-scoped preferences such as composer and appearance behavior.
- `settings-instance` persists admin configuration such as repositories, providers, members, ingress, and integrations.
- `settings-phone` uses a section list and back navigation at phone width.

## How to get to it (user POV)

- Choose `Settings` in the sidebar or account menu.
- Open `/settings` for Account.
- Open a direct section route such as `/settings/preferences`, `/settings/providers`, or `/settings/connections`.
- Search within settings and choose a matching result.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- `/api/auth/status` reports `admin: true`, which doctor requires for this demo run. If an admin-only section is hidden, record that precondition instead of bypassing it.

- **Open Account.** Run `verify-opensession browser "$RUN_ID" open --route /settings --width 1440 --height 900`. The Account section opens as the desktop default.
- **Open a direct section.** Run `verify-opensession browser "$RUN_ID" open --route /settings/preferences --width 1440 --height 900`, then wait for heading `Preferences`. The settings rail marks the same section active.
- **Use search.** Return to `/settings`, take a snapshot to read the current search textbox name, fill it with `providers`, and choose the `Providers` result. The route becomes `/settings/providers` and the Providers heading appears.
- **Change a personal preference.** Choose the target control by its exact label, record its initial state from the accessibility snapshot, change it through the UI, navigate to another section, and return. Require the changed state to remain. Reload by opening `/settings/preferences` again and check once more.
- **Change instance configuration.** Use only the disposable demo instance. Save through the visible form, then read the matching read-only API response and revisit the section. Never copy live credentials into this run.
- **Check phone navigation.** Open `/settings` at 390x844. The settings section list appears first. Choose a section, then use its visible back action to return to the list.
- **Proof.** Capture the initial control state, action, persisted state after navigation, and the phone section flow. Add the read-only API response for instance mutations.

## Gotchas

- Personal preferences may live in browser local storage while instance configuration lives in the disposable state directory. Verify the correct side effect for the control under test.
- A direct route proves section rendering, not settings search or rail navigation.
- Bare `/settings` opens Account on desktop but stays at the settings section list on phone.
- Provider, connection, and integration forms can expose credential fields. Use synthetic values only and never include secrets in screenshots or snapshots.
- Some settings trigger external checks. In the isolated demo, prove validation and saved configuration, not a real external connection.
