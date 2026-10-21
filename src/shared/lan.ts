import { z } from 'zod';

export const lanSettingsSchema = z.object({
  enabled: z.boolean(),
  automatic: z.boolean(),
  interfaceId: z.string().min(1).max(300).nullable(),
  port: z.number().int().min(1024).max(65535),
}).strict();
export const lanCommandSchema = lanSettingsSchema.extend({ revision: z.number().int().nonnegative() }).strict();
export const lanInterfaceSchema = z.object({
  id: z.string(), name: z.string(), address: z.ipv4(), netmask: z.ipv4(), prefix: z.number().int().min(8).max(30),
}).strict();
export const lanStatusSchema = z.object({
  revision: z.number().int().nonnegative(),
  settings: lanSettingsSchema,
  interfaces: z.array(lanInterfaceSchema),
  runtime: z.discriminatedUnion('state', [
    z.object({ state: z.literal('off') }),
    z.object({ state: z.literal('listening'), url: z.string().url() }),
    z.object({ state: z.literal('unavailable'), message: z.string() }),
  ]),
  canConfigure: z.boolean(),
});
export type LanSettings = z.infer<typeof lanSettingsSchema>;
export type LanInterface = z.infer<typeof lanInterfaceSchema>;
export type LanStatus = z.infer<typeof lanStatusSchema>;
