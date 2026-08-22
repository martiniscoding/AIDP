"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Lock, Mail } from "lucide-react";
import { AuthCard, FormError } from "@/components/auth/AuthCard";
import { validateEmail } from "@/components/auth/validation";
import { useFieldErrors } from "@/components/auth/useFieldErrors";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { AFTER_AUTH_REDIRECT, signIn } from "@/lib/auth-client";
import { verifyWorkspace } from "../actions";

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { errors, validate, clear } = useFieldErrors<"email" | "password">();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const passes = validate({
      email: validateEmail(email),
      // Deliberately not length-checking on sign-in: an existing password
      // that predates the current rule should still get a real attempt.
      password: password ? undefined : "Enter your password.",
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

      // The password was right. Whether they are still admitted, and which
      // workspace their email belongs to, are separate questions — see
      // actions.ts. A failure there has already signed them back out.
      const check = await verifyWorkspace();
      if (!check.ok) {
        setFormError(check.message ?? "Could not sign you in.");
        return;
      }

      // Where they belong depends on what kind of account it is: a customer
      // lands on their dashboard, an operator on the console.
      //
      // A full page load rather than router.push. Signing in changes who the
      // client is, and every cached RSC payload and JS chunk in the tab was
      // fetched as somebody else — or, across a redeploy, by a build that no
      // longer exists. A client-side navigation keeps all of it and has to be
      // trusted to invalidate the right parts; a document load cannot get that
      // wrong. It costs one extra round trip on the one navigation per session
      // where correctness matters most.
      window.location.assign(check.redirectTo ?? AFTER_AUTH_REDIRECT);
      return;
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
              className="text-[12.5px] text-ink/66 underline-offset-4 transition-colors hover:text-ink/84 hover:underline"
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
