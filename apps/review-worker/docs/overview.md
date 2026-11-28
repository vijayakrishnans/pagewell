# review-worker

Pagewell's review (milestone PW5): comment threads on a page of a document, review requests with
reminders, and the `DocRoom` Durable Object (one per document) for presence, the edit lease and
live comments.

- **Acts as the person.** Every access check goes to `files-worker` as the person asking (actor
  headers and verified email): read to see threads and requests, comment to write and resolve,
  write to remove another's comment, share to request a review or break an edit lease.
- **Anchors.** Listing threads carries each one made on an older version to the current version,
  once (`@saas/shared/anchors`: same page and its quote or text still there, else `outdated`,
  never moved), using the text the editor stores with each save (`GET …/versions/{n}/text`).
- **Review requests** share the document with each reviewer as a commenter (through the drive's
  own share, so guests are invited as usual), email them (`review.requested`), and close when
  everyone decided. A daily cron reminds reviewers who have not decided near and after the due date.
- **Mentions** (`@email` in a comment) email only people already in the conversation (earlier
  commenters, reviewers of an open request), so a mention never tells a stranger a document's name.
- **The room.** `POST …/room/ticket` (with access) returns a single-use ticket valid 60 seconds;
  the browser opens `GET …/room?ticket=` as a WebSocket. The room keeps presence, one edit lease
  per document (60 s, renewed; released on leave; broken by someone who may share), and fans out
  new and changed threads and new-version notices.

## Routes (under `/v1/organizations/{org}`)

| Method | Path | Needs |
|---|---|---|
| GET / POST | `/documents/{doc}/threads` | read / comment |
| POST | `/threads/{thr}/comments` | comment |
| PATCH | `/threads/{thr}` | comment |
| PATCH / DELETE | `/threads/{thr}/comments/{cmt}` | author / author or write |
| GET / POST | `/documents/{doc}/review-requests` | read / share |
| POST | `/review-requests/{rvr}/decision` | a named reviewer with read |
| DELETE | `/review-requests/{rvr}` | its creator, or share |
| POST | `/documents/{doc}/room/ticket` | read |
| GET | `/documents/{doc}/room?ticket=` | the ticket (WebSocket) |
