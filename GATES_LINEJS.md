# LINEJS feature expansion acceptance gates

Scope: Wire supported Note/Timeline functionality into Liney's native engine/UI without touching authentication or stored message history.

- [ ] L1: Notes have room-specific authenticated list/read/create/edit/delete/reaction/comment RPC with validation and no raw token disclosure.
  CHECK: bun test engine/linejs/note.test.ts
  EXPECT: pass

- [ ] L2: Desktop UI exposes Note viewing and editing with guarded write actions and error states.
  CHECK: bun run web:build
  EXPECT: built

- [ ] L3: Native engine bundles the adapters with no missing exports.
  CHECK: bun run engine:build
  EXPECT: Built

- [ ] L4: Regression, lint and worktree formatting pass.
  CHECK: bun test engine/linejs/adapter.test.ts engine/sync/coordinator.test.ts && bun run lint && git diff --check
  EXPECT: pass

- [ ] L5: Live LINE account validation for Note, call features and VOOM performed without modifying user account without consent.
  MANUAL: Requires authorized test account; unverified until observed.
