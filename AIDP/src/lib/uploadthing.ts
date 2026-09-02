import { generateReactHelpers } from "@uploadthing/react";
import type { AppFileRouter } from "@/app/api/uploadthing/core";

/** Typed client for the file route in src/app/api/uploadthing. `uploadFiles`
 *  rather than the hook: uploads run one at a time inside a loop that keeps a
 *  receipt per file, and a promise fits that where a callback does not. */
export const { uploadFiles } = generateReactHelpers<AppFileRouter>();
