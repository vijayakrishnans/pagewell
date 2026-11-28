-- 251_sign_sender
-- Pagewell e-sign (PW6) — the sender's email on an envelope, for "from" in signers' emails and for
-- telling the sender when someone declines or the envelope completes
-- Bounded context: sign

ALTER TABLE sign_envelopes ADD COLUMN sender_email TEXT;

-- column sign_envelopes.sender_email: The sender's email address when they sent it (shown to signers as who it is from).
