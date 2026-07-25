# P2 Implementation Plan: Session Tab Groups

### Task 1: Manifest
- [x] Add `tabGroups` permission

### Task 2: Extension
- [x] Helpers: ensure/update group, add tabs to group
- [x] `open_tab` default `active: false`; optional `groupId`
- [x] Tools: `name_session` (title/color/groupId), `group_tabs`, enrich `get_tabs`
- [x] `close_tab` batch `tabIds` for finalize

### Task 3: Broker
- [x] Session fields: name, groupId
- [x] Claim fields: origin, mark
- [x] Ops: `name_session`, `mark_tab`, `finalize`
- [x] Intercept `open_tab`: default active false, origin agent, attach group
- [x] `claim_tab`: origin user, no group move
- [x] `list_claims` / `status` expose new fields
- [x] `wantsTab` exclude new ops as needed

### Task 4: Plugin
- [x] `browser_name_session`, `browser_mark_tab`, `browser_finalize`
- [x] Update open_tab / claim descriptions
- [x] agent-backend stubs

### Task 5: Docs + verify
- [x] README roadmap + session section
- [x] build + `node bin/cli.js update` + broker restart
- [x] Live smoke (broker session):
  - name_session → groupId
  - two open_tab same group, active:false, foreground stays extensions
  - claim_tab origin=user, groupId unchanged
  - mark handoff + finalize: close unmarked agent, keep handoff, release user
