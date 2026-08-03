import type { Metadata } from "next";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const metadata: Metadata = {
  title: "Choose a new password",
  description: "Set a new password for your Dexter account.",
};

/**
 * Better Auth's reset callback redirects here with either `?token=…` or
 * `?error=INVALID_TOKEN`. `searchParams` is async as of Next.js 16.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;

  return <ResetPasswordForm token={token} tokenError={error} />;
}
