import { z } from "zod";

export const DEFAULT_CONTENT_LOCALE = "de-DE";

export const ContentLocaleSchema = z
  .string()
  .min(2)
  .max(35)
  .transform((value, context) => {
    try {
      const [canonical] = Intl.getCanonicalLocales(value);
      if (canonical) return canonical;
    } catch {
      // Report one stable validation error through the route boundary.
    }
    context.addIssue({ code: z.ZodIssueCode.custom });
    return z.NEVER;
  });
