ALTER TABLE generations ADD COLUMN continuation_variant_id TEXT
  CHECK (continuation_variant_id IS NULL OR (kind = 'response' AND context_selection IS NULL));
