import { z } from 'zod';
import { revisionSchema } from './contracts.js';

export const branchNameSchema = z.string().trim().min(1).max(100);
export const copyBranchSchema = z.object({
  name: branchNameSchema,
  revision: revisionSchema,
  requestId: z.string().uuid(),
  through: z.string().min(1).max(100).optional(),
}).strict();
export const renameBranchSchema = z.object({ name: branchNameSchema, revision: revisionSchema }).strict();
export const deleteChatSchema = z.object({
  revision: revisionSchema,
  branches: z.array(z.object({ id: z.string().min(1).max(100), revision: revisionSchema }).strict()).max(100_000).optional(),
}).strict();
export type CopyBranch = z.infer<typeof copyBranchSchema>;
