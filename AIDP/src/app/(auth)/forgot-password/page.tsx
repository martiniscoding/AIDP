import type { Metadata } from "next";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata: Metadata = {
  title: "Reset your password",
  description: "Request a password reset link for your Dexter account.",
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
