import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      /**
       * Raised for the staff-list import on /dashboard/people.
       *
       * The default is 1MB. A .xlsx export of a few thousand employees is
       * comfortably under 4MB — the format is a zip, and this data is text —
       * while still being far too small to be worth a separate upload endpoint
       * with its own auth. Documents, which really are tens of megabytes, go
       * through the Route Handler at /api/documents/upload instead and are not
       * affected by this.
       *
       * The limit counts multipart overhead as well as the file, hence the
       * headroom over the number quoted to the user in ImportPanel.
       */
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
