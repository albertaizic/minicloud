import { z } from 'zod';

const REPO_URL_RE =
  /^(https:\/\/[\w.-]+(:\d+)?\/[\w~%.\-]+\/[\w~%.\-]+(\.git)?\/?|git@[\w.-]+:[\w~%.\-]+\/[\w~%.\-]+(\.git)?)$/;

export const createAppSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/i, 'name must be alphanumeric with dashes'),
  repositoryUrl: z.string().trim().min(1).max(2048).regex(REPO_URL_RE, 'repositoryUrl must be a public https or ssh git URL'),
});

export type CreateAppInput = z.infer<typeof createAppSchema>;

export const deployAppSchema = z.object({
  ref: z.string().trim().max(200).regex(/^[\w.\-/]+$/, 'invalid git ref').optional(),
  healthPath: z.string().trim().max(200).regex(/^\/[\w\-./]*$/, 'healthPath must start with /').optional(),
  containerPort: z.number().int().min(1).max(65535).optional(),
  healthTimeoutSeconds: z.number().int().min(5).max(600).optional(),
}).strict();

export type DeployAppInput = z.infer<typeof deployAppSchema>;

/** Validate a raw id used in URLs (uuids). */
export function isValidId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
