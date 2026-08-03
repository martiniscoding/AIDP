import type { Metadata } from "next";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Dexter.",
};

export default function SignInPage() {
  return <SignInForm />;
}
