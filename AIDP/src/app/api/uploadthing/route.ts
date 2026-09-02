import { createRouteHandler } from "uploadthing/next";
import { fileRouter } from "./core";

/** The presign/callback endpoint the browser talks to. The file bytes never
 *  pass through here — see core.ts. */
export const { GET, POST } = createRouteHandler({ router: fileRouter });
