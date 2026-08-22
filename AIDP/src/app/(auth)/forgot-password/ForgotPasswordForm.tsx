"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, MailCheck } from "lucide-react";
import { AuthCard, FormError } from "@/components/auth/AuthCard";
import { validateEmail } from "@/components/auth/validation";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { requestPasswordReset } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const error = validateEmail(email);
    setFieldError(error);
    if (error) return;

    setFormError(null);
    setPending(true);

    const result = await requestPasswordReset({
      email: email.trim(),
      // Better Auth appends ?token=… (or ?error=INVALID_TOKEN) to this path.
      redirectTo: "/reset-password",
    });

    setPending(false);

    if (result.error) {
      setFormError(result.error.message ?? "Could not send the reset link.");
      return;
    }

    // Confirmed regardless of whether the address exists — telling the caller
    // which emails are registered would leak account membership.
    setSent(true);
  };

  if (sent) {
    return (
      <AuthCard
        title="Check your email"
        subtitle={
          <>
            If an account exists for{" "}
            <span className="text-ink/84">{email.trim()}</span>, a password
            reset link is on its way. It expires in one hour.
          </>
        }
        footer={
          <>
            Wrong address?{" "}
            <button
              type="button"
              onClick={() => setSent(false)}
              className="font-medium text-ink/88 underline-offset-4 hover:underline"
            >
              Try another
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3 rounded-xl border border-line bg-card p-4">
            <MailCheck
              size={18}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-royal"
            />
            <p className="text-[13px] leading-relaxed text-ink/70">
              No email provider is configured in development — the reset link is
              printed to the terminal running{" "}
              <code className="rounded bg-canvas-sunk px-1 py-0.5 text-[12px] text-ink/80">
                npm run dev
              </code>
              . See{" "}
              <code className="rounded bg-canvas-sunk px-1 py-0.5 text-[12px] text-ink/80">
                sendResetPassword
              </code>{" "}
              in{" "}
              <code className="rounded bg-canvas-sunk px-1 py-0.5 text-[12px] text-ink/80">
                src/lib/auth.ts
              </code>{" "}
              to plug in a real sender.
            </p>
          </div>

          <ButtonLink href="/sign-in" variant="secondary" size="lg">
            Back to sign in
          </ButtonLink>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter the email on your account and we'll send you a link to choose a new password."
      footer={
        <>
          Remembered it?{" "}
          <Link
            href="/sign-in"
            className="font-medium text-ink/88 underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError ? <FormError>{formError}</FormError> : null}

        <Field
          label="Work email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@company.com"
          icon={<Mail size={16} />}
          value={email}
          error={fieldError}
          onChange={(e) => {
            setEmail(e.target.value);
            setFieldError(undefined);
          }}
        />

        <Button
          type="submit"
          size="lg"
          disabled={pending}
          className="mt-2 w-full"
        >
          {pending ? <Spinner /> : null}
          {pending ? "Sending…" : "Send reset link"}
        </Button>
      </form>
    </AuthCard>
  );
}
