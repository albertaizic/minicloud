import { z } from 'zod';

// Public https remotes, ssh remotes, and http(s) remotes on localhost/127.0.0.1
// (useful for local git servers such as Gitea). Everything else is rejected.
const REPO_URL_RE =
  /^(https:\/\/[\w.-]+(:\d+)?\/[\w~%.\-]+(\/[%\w~.\-]+)*(\.git)?\/?|git@[\w.-]+:[\w~%.\-]+\/[\w~%.\-]+(\.git)?)$/;
const LOCAL_URL_RE = /^https?:\/\/localhost(:\d+)?\/[\w~%.\-]+(\.git)?$/;

function repoUrlAllowed(url: string): boolean {
  return REPO_URL_RE.test(url) || LOCAL_URL_RE.test(url);
}

export const createAppSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/i, 'name must be alphanumeric with dashes'),
  repositoryUrl: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(repoUrlAllowed, 'repositoryUrl must be a public https or ssh git URL (localhost http allowed)'),
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
