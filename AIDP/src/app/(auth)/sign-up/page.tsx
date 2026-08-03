import type { Metadata } from "next";
import { SignUpForm } from "./SignUpForm";

export const metadata: Metadata = {
  title: "Create your account",
  description:
    "Create a Dexter account and start assessing architecture submissions against your own principles and standards.",
};

export default function SignUpPage() {
  return <SignUpForm />;
}
