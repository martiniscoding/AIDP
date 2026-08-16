"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Building2, Lock, Mail } from "lucide-react";
import { AuthCard, FormError } from "@/components/auth/AuthCard";
import { validateEmail } from "@/components/auth/validation";
import { useFieldErrors } from "@/components/auth/useFieldErrors";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { AFTER_AUTH_REDIRECT, signIn } from "@/lib/auth-client";
import { verifyWorkspace } from "../actions";

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState("");
  const { errors, validate, clear } = useFieldErrors<"email" | "password" | "company">();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const passes = validate({
      email: validateEmail(email),
      // Deliberately not length-checking on sign-in: an existing password
      // that predates the current rule should still get a real attempt.
      password: password ? undefined : "Enter your password.",
      // Company is checked on the server, not here. A platform operator has no
      // company and leaves it blank, and this form cannot tell which kind of
      // account is signing in until the password has been verified.
    });
    if (!passes) return;

    setFormError(null);
    setPending(true);

    // Everything below is wrapped, because anything that throws instead of
    // returning leaves the button spinning forever with nothing said. A Server
    // Action can reject for reasons that have nothing to do with the caller —
    // a dropped connection, a database waking up, or a stale action id in a
    // browser tab that has been open across a redeploy — and "it just spins" is
    // the least diagnosable failure a sign-in form can have.
    try {
      const { error } = await signIn.email({
        email: email.trim(),
        password,
      });

      if (error) {
        setFormError(
          error.status === 401 || error.status === 403
            ? "That email and password combination doesn't match an account."
            : (error.message ?? "Could not sign you in."),
        );
        return;
      }

      // The password was right. Whether they are still admitted, and whether
      // this is the workspace they named, are separate questions — see
      // actions.ts. A failure there has already signed them back out.
      const check = await verifyWorkspace(company);
      if (!check.ok) {
        setFormError(check.message ?? "Could not sign you in.");
        return;
      }

      // Where they belong depends on what kind of account it is: a customer
      // lands on their dashboard, an operator on the console.
      router.push(check.redirectTo ?? AFTER_AUTH_REDIRECT);
      router.refresh();
    } catch {
      setFormError(
        "Something went wrong reaching the server. Check your connection and try again.",
      );
    } finally {
      // Runs on the success path too. Navigation is already under way by then,
      // and re-enabling a button on a page being replaced is harmless — whereas
      // leaving it disabled after a failure strands the user.
      setPending(false);
    }
  };

  return (
    <AuthCard
      tab="sign-in"
      title="Welcome back"
      subtitle="Pick up where your architecture review left off."
      /* No "don't have an account?" line — the switch above the heading is
         already the way across, and repeating it twice on one card is noise. */
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
          error={errors.email}
          onChange={(e) => {
            setEmail(e.target.value);
            clear("email");
          }}
        />

        <Field
          label="Company"
          name="company"
          autoComplete="organization"
          placeholder="Your company's name"
          icon={<Building2 size={16} />}
          value={company}
          error={errors.company}
          onChange={(e) => {
            setCompany(e.target.value);
            clear("company");
          }}
        />

        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          icon={<Lock size={16} />}
          value={password}
          error={errors.password}
          onChange={(e) => {
            setPassword(e.target.value);
            clear("password");
          }}
          labelAction={
            <Link
              href="/forgot-password"
              className="text-[12.5px] text-white/45 underline-offset-4 transition-colors hover:text-white/80 hover:underline"
            >
              Forgot password?
            </Link>
          }
        />

        <Button
          type="submit"
          size="lg"
          disabled={pending}
          className="group mt-2 w-full"
        >
          {pending ? <Spinner /> : null}
          {pending ? "Signing in…" : "Sign in"}
          {pending ? null : (
            <ArrowRight
              size={17}
              aria-hidden="true"
              className="transition-transform duration-300 group-hover:translate-x-0.5"
            />
          )}
        </Button>
      </form>
    </AuthCard>
  );
}
