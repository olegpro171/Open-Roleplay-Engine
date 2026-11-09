export const characterCardLimits = {
  pngBytes: 100_000_000,
  jsonBytes: 20_000_000,
  embeddedBytes: 2_000_000,
  // The persisted record holds both source metadata and normalized editable fields.
  recordBytes: 48_000_000,
} as const;
