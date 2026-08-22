"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Lock } from "lucide-react";
import { AuthCard, FormError } from "@/components/auth/AuthCard";
import {
  MIN_PASSWORD_LENGTH,
  passwordStrength,
  validatePassword,
} from "@/components/auth/validation";
import { useFieldErrors } from "@/components/auth/useFieldErrors";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { resetPassword } from "@/lib/auth-client";

const STRENGTH_STYLES = [
  "bg-ink/15",
  "bg-danger",
  "bg-warn",
  "bg-ok",
] as const;

export function ResetPasswordForm({
  token,
  tokenError,
}: {
  token?: string;
  tokenError?: string;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { errors, validate, clear } = useFieldErrors<"password" | "confirm">();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const strength = passwordStrength(password);

  // The reset callback bounces here with ?error=INVALID_TOKEN when the link
  // has expired or been used; a missing token means the page was opened directly.
  if (!token || tokenError) {
    return (
      <AuthCard
        title="This link is no longer valid"
        subtitle={
          tokenError
            ? "Password reset links expire after one hour and can only be used once."
            : "Open the reset link from your email, or request a new one."
        }
      >
        <div className="flex flex-col gap-2.5">
          <ButtonLink href="/forgot-password" size="lg">
            Request a new link
          </ButtonLink>
          <ButtonLink href="/sign-in" variant="secondary" size="lg">
            Back to sign in
          </ButtonLink>
        </div>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard
        title="Password updated"
        subtitle="You can now sign in with your new password."
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3 rounded-xl border border-ok-line bg-ok-tint p-4">
            <CheckCircle2
              size={18}
              aria-hidden="true"
              className="shrink-0 text-ok"
            />
            <p className="text-[13px] text-ink/74">
              Taking you to sign in…
            </p>
          </div>
          <ButtonLink href="/sign-in" size="lg">
            Continue to sign in
          </ButtonLink>
        </div>
      </AuthCard>
    );
  }

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const passes = validate({
      password: validatePassword(password),
      confirm: confirm !== password ? "Passwords don't match." : undefined,
    });
    if (!passes) return;

    setFormError(null);
    setPending(true);

    const { error } = await resetPassword({ newPassword: password, token });

    if (error) {
      setFormError(error.message ?? "Could not update your password.");
      setPending(false);
      return;
    }

    setDone(true);
    setTimeout(() => router.push("/sign-in"), 1800);
  };

  return (
    <AuthCard
      title="Choose a new password"
      subtitle="Pick something you haven't used on this account before."
      footer={
        <>
          Changed your mind?{" "}
          <Link
            href="/sign-in"
            className="font-medium text-ink/88 underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError ? <FormError>{formError}</FormError> : null}

        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          icon={<Lock size={16} />}
          value={password}
          error={errors.password}
          onChange={(e) => {
            setPassword(e.target.value);
            clear("password");
          }}
          hint={
            <div className="flex items-center gap-2.5 pt-0.5">
              <div className="flex flex-1 gap-1" aria-hidden="true">
                {[1, 2, 3].map((step) => (
                  <span
                    key={step}
                    className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                      strength.score >= step
                        ? STRENGTH_STYLES[strength.score]
                        : "bg-canvas-sunk"
                    }`}
                  />
                ))}
              </div>
              <span className="min-w-14 text-right text-[12px] text-ink/66">
                {strength.label || `${MIN_PASSWORD_LENGTH}+ characters`}
              </span>
            </div>
          }
        />

        <Field
          label="Confirm new password"
          name="confirm"
          type="password"
          autoComplete="new-password"
          placeholder="Re-enter your password"
          icon={<Lock size={16} />}
          value={confirm}
          error={errors.confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            clear("confirm");
          }}
        />

        <Button
          type="submit"
          size="lg"
          disabled={pending}
          className="mt-2 w-full"
        >
          {pending ? <Spinner /> : null}
          {pending ? "Updating…" : "Update password"}
        </Button>
      </form>
    </AuthCard>
  );
}
