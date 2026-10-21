-- Preserve the original English diagnostic and immutable request separately.
-- Older outcomes deliberately have no inferred translation identity.
ALTER TABLE generations ADD COLUMN error_message TEXT;
