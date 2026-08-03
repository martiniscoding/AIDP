"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Building2,
  Globe,
  Lock,
  Mail,
  Phone as PhoneIcon,
  User,
} from "lucide-react";
import { AuthCard, FormError } from "@/components/auth/AuthCard";
import {
  MIN_PASSWORD_LENGTH,
  passwordStrength,
  validateCompany,
  validateCountry,
  validateEmail,
  validateName,
  validatePassword,
  validatePhone,
} from "@/components/auth/validation";
import { useFieldErrors } from "@/components/auth/useFieldErrors";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { COUNTRIES } from "@/lib/countries";
import { AFTER_AUTH_REDIRECT, signUp } from "@/lib/auth-client";

const STRENGTH_STYLES = [
  "bg-white/15",
  "bg-rose-400/70",
  "bg-amber-300/80",
  "bg-emerald-400/80",
] as const;

type FieldName =
  | "name"
  | "email"
  | "company"
  | "country"
  | "phone"
  | "password";

export function SignUpForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [country, setCountry] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const { errors, validate, clear } = useFieldErrors<FieldName>();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const strength = passwordStrength(password);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const passes = validate({
      name: validateName(name),
      email: validateEmail(email),
      company: validateCompany(company),
      country: validateCountry(country),
      phone: validatePhone(phone),
      password: validatePassword(password),
    });
    if (!passes) return;

    setFormError(null);
    setPending(true);

    const { error } = await signUp.email({
      name: name.trim(),
      email: email.trim(),
      password,
      company: company.trim(),
      country,
      phone: phone.trim(),
    });

    if (error) {
      setFormError(error.message ?? "Could not create your account.");
      setPending(false);
      return;
    }

    // autoSignIn is on, so a session already exists by this point.
    router.push(AFTER_AUTH_REDIRECT);
    router.refresh();
  };

  return (
    <AuthCard
      width="wide"
      tab="sign-up"
      title="Create your account"
      subtitle="Start assessing architecture submissions against your own principles and standards."
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError ? <FormError>{formError}</FormError> : null}

        <Field
          label="Full name"
          name="name"
          autoComplete="name"
          placeholder="Dana Okonkwo"
          icon={<User size={16} />}
          value={name}
          error={errors.name}
          onChange={(e) => {
            setName(e.target.value);
            clear("name");
          }}
        />

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
          placeholder="Northwind Industrial"
          icon={<Building2 size={16} />}
          value={company}
          error={errors.company}
          onChange={(e) => {
            setCompany(e.target.value);
            clear("company");
          }}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Country"
            name="country"
            autoComplete="country-name"
            placeholder="Select a country"
            options={COUNTRIES}
            icon={<Globe size={16} />}
            value={country}
            error={errors.country}
            onChange={(e) => {
              setCountry(e.target.value);
              clear("country");
            }}
          />

          <Field
            label="Phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+44 20 7946 0000"
            icon={<PhoneIcon size={16} />}
            value={phone}
            error={errors.phone}
            onChange={(e) => {
              setPhone(e.target.value);
              clear("phone");
            }}
          />
        </div>

        <Field
          label="Password"
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
                        : "bg-white/10"
                    }`}
                  />
                ))}
              </div>
              <span className="min-w-14 text-right text-[12px] text-white/45">
                {strength.label || `${MIN_PASSWORD_LENGTH}+ characters`}
              </span>
            </div>
          }
        />

        <Button
          type="submit"
          size="lg"
          disabled={pending}
          className="group mt-2 w-full"
        >
          {pending ? <Spinner /> : null}
          {pending ? "Creating account…" : "Create account"}
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
