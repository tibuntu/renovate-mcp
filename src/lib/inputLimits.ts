import { z } from "zod";

// Centralized input-size caps for every tool schema. These exist to refuse
// pathologically large inputs (DoS via 100 MB blobs) before any business
// logic runs. Caps are intentionally generous — real-world inputs are orders
// of magnitude smaller — so the only way to trip them is intent or a buggy
// caller.

export const PATH_MAX_BYTES = 4096;
export const TOKEN_MAX_BYTES = 1024;
export const ENDPOINT_MAX_BYTES = 2048;
export const REPOSITORY_MAX_BYTES = 256;
export const FILENAME_MAX_BYTES = 512;
export const CONFIG_JSON_MAX_BYTES = 1_000_000;
export const REPORT_JSON_MAX_BYTES = 10_000_000;
export const HOST_RULES_MAX_ITEMS = 256;
export const HOST_RULE_JSON_MAX_BYTES = 64_000;

export const pathString = (description: string) =>
  z.string().max(PATH_MAX_BYTES).describe(description);

export const tokenString = (description: string) =>
  z.string().max(TOKEN_MAX_BYTES).describe(description);

export const endpointString = (description: string) =>
  z.string().max(ENDPOINT_MAX_BYTES).describe(description);

export const repositoryString = (description: string) =>
  z.string().max(REPOSITORY_MAX_BYTES).describe(description);

export const filenameString = (description: string) =>
  z.string().max(FILENAME_MAX_BYTES).describe(description);

const refineJsonSize =
  (limit: number) =>
  (value: unknown): boolean => {
    try {
      return JSON.stringify(value).length <= limit;
    } catch {
      return false;
    }
  };

export const configRecord = (description: string) =>
  z
    .record(z.string(), z.unknown())
    .refine(refineJsonSize(CONFIG_JSON_MAX_BYTES), {
      message: `Config object exceeds ${CONFIG_JSON_MAX_BYTES} bytes when serialized`,
    })
    .describe(description);

export const reportRecord = (description: string) =>
  z
    .record(z.string(), z.unknown())
    .refine(refineJsonSize(REPORT_JSON_MAX_BYTES), {
      message: `Report object exceeds ${REPORT_JSON_MAX_BYTES} bytes when serialized`,
    })
    .describe(description);

export const hostRuleRecord = (description: string) =>
  z
    .record(z.string(), z.unknown())
    .refine(refineJsonSize(HOST_RULE_JSON_MAX_BYTES), {
      message: `hostRule entry exceeds ${HOST_RULE_JSON_MAX_BYTES} bytes when serialized`,
    })
    .describe(description);
