# Refactor

The structure changes. Behavior does not.

1. Pin the current contract with an existing test, characterization test, snapshot, or equivalence harness before moving structure.
2. Name the missing shape. Examples include a registry replacing repeated branching, a state machine replacing coupled booleans, or one owner replacing mirrored state.
3. State the target call graph and ownership. The refactor must reduce branches, invalid states, or reader load rather than add indirection.
4. Delete dead weight and collapse redundant wrappers before introducing the new shape.
5. Move in small steps that keep the contract green. Migrate all callers and remove the old internal API in the same wave unless external compatibility is required.
6. Run the pinned contract and a real smoke path. Compare old and new output when practical.
7. Confirm the final diff is behavior-preserving and easier to trace. Revert speculative cleanup that does not earn its place.

Report the contract held constant, the structural change, the equivalence proof, and the reader-load reduction.
