# Goals

Goals resume one session across repeated wakes. Users inspect a goal and its ledger, create or edit its mission, pause or resume it, run a wake, and delete it.

## Sub-features

- `goal-list` shows the mission name, status, wake count, and latest activity.
- `goal-detail` opens the mission, configuration, and ledger.
- `goal-create` persists a named mission and wake limits.
- `goal-edit` changes configuration or deletes the goal.
- `goal-state` pauses, resumes, or starts a wake when execution is available.

## How to get to it (user POV)

- Choose `Goals` from settings tools.
- Open `/goals` or a shared `/goals/<id>` link.
- Choose `New goal` from the goals page.
- Choose a goal row to inspect its ledger and state actions.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The demo seed contains paused goal `Flaky-test burndown`.
- Set `GOAL_NAME="Verification goal $RUN_ID"` so this run's mutation is unambiguous.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /goals --width 1440 --height 900`, then `verify-opensession browser "$RUN_ID" wait --role heading --name "Goals"`. Capture the seeded list before changing it.
- **Open the form.** Run `verify-opensession browser "$RUN_ID" click --role button --name "New goal"`, then `verify-opensession browser "$RUN_ID" wait --role button --name "Create goal"`. A form titled `New goal` appears.
- **Enter the mission.** Run `verify-opensession browser "$RUN_ID" fill --role textbox --name "Name" --value "$GOAL_NAME"` and `verify-opensession browser "$RUN_ID" fill --role textbox --name "Mission" --value "Inspect the isolated demo state and record one verification result."`. Capture the filled form so the action is visible.
- **Save.** Run `verify-opensession browser "$RUN_ID" click --role button --name "Create goal"`. The form closes and the goals list returns.
- **Confirm stored state.** Run `verify-opensession api "$RUN_ID" /api/goals | jq --arg name "$GOAL_NAME" '.[] | select(.name == $name)'`. Require one object with the entered mission. Set `GOAL_ID="$(verify-opensession api "$RUN_ID" /api/goals | jq -r --arg name "$GOAL_NAME" '.[] | select(.name == $name) | .id')"`, then open `/goals/$GOAL_ID`. The detail view names the saved goal.
- **Check phone layout.** Open `/goals/$GOAL_ID` at 390x844. The saved detail appears with a visible `Goals` back action. Use that action to reach the phone list when list navigation is in scope.
- **Proof.** Save before, filled-form, and after snapshots and screenshots. Save the matching API object as `goals-api.json`.

## Gotchas

- Do not use `Run now`, `Resume`, or a wake as proof of engine behavior. The launcher disables goal scheduling and execution.
- `Flaky-test burndown` is paused and scheduled for 2099 so demo data cannot run.
- `Name` and `Mission` must both be non-empty before `Create goal` enables.
- Saving closes the form. A screenshot of filled inputs alone proves no persistence.
- Cleanup removes the created goal with the disposable state directory. It must not remove evidence.
