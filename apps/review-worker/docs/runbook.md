# review-worker — runbook

## Common failures
- **Comments do not appear live**: the editor's WebSocket to the room did not open. Tickets last 60
  seconds and work once; the editor asks for a new one on every (re)connect. Check that api-edge
  passes the `…/room` upgrade straight through.
- **Everyone is read-only**: someone holds the edit lease. It ends 60 seconds after their last
  renewal, when they leave, or when someone who may share the document breaks it.
- **A thread shows as outdated**: its page or quote is not in the current version; it is kept, with
  its comments, and is not moved. Nothing to fix.
- **No mention email**: the mentioned address was not already in the conversation (by design).

## Data
Rows: `review_threads`, `review_comments`, `review_requests`, `review_request_reviewers` in the
shared D1 database. The room keeps only live state (tickets, the lease) in its own storage.
