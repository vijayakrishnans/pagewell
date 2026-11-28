-- 230_files_link_lockout
-- Share-link password lockout (PW-26, OWASP A07; closes risk PW-O)
-- Bounded context: files
--
-- A link with a password counts wrong passwords; after 10 in a row it is locked for 15 minutes
-- (answers 429), whichever client address the guesses come from. A right password resets the
-- count. The edge's per-address rate limit stays in front of this.

ALTER TABLE files_links ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files_links ADD COLUMN locked_until TEXT;

-- column files_links.failed_attempts: Wrong passwords since the last right one or the last lock.
-- column files_links.locked_until: Until when the link refuses every request after too many wrong passwords.
