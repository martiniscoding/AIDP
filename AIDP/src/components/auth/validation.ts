export const MIN_PASSWORD_LENGTH = 8; // must match emailAndPassword.minPasswordLength

/** Pragmatic check — the server is the real authority on deliverability. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(value: string): string | undefined {
  if (!value.trim()) return "Enter your work email.";
  if (!EMAIL_RE.test(value.trim())) return "Enter a valid email address.";
  return undefined;
}

export function validatePassword(value: string): string | undefined {
  if (!value) return "Enter a password.";
  if (value.length < MIN_PASSWORD_LENGTH)
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  return undefined;
}

export function validateName(value: string): string | undefined {
  if (!value.trim()) return "Enter your name.";
  if (value.trim().length < 2) return "Enter your full name.";
  return undefined;
}

export function validateCompany(value: string): string | undefined {
  if (!value.trim()) return "Enter your company name.";
  if (value.trim().length < 2) return "Enter your company name.";
  return undefined;
}

export function validateCountry(value: string): string | undefined {
  if (!value) return "Select your country.";
  return undefined;
}

/**
 * Loose on formatting, strict on substance: accepts the punctuation people
 * actually type (+, spaces, dashes, parentheses, dots) and checks only that
 * enough digits are present for a dialable international number.
 */
export function validatePhone(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Enter your phone number.";
  if (/[^0-9+()\-.\s]/.test(trimmed))
    return "Use only digits, spaces, and + ( ) - characters.";

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return "That number looks too short.";
  if (digits.length > 15) return "That number looks too long.";
  return undefined;
}

export type Strength = { score: 0 | 1 | 2 | 3; label: string };

/**
 * Advisory only — length plus variety. Nothing here gates submission beyond
 * the minimum length the server enforces.
 */
export function passwordStrength(value: string): Strength {
  if (!value) return { score: 0, label: "" };

  let points = 0;
  if (value.length >= MIN_PASSWORD_LENGTH) points += 1;
  if (value.length >= 12) points += 1;
  if (/[^A-Za-z0-9]/.test(value) || (/[A-Z]/.test(value) && /\d/.test(value)))
    points += 1;

  if (value.length < MIN_PASSWORD_LENGTH) return { score: 0, label: "Too short" };
  if (points >= 3) return { score: 3, label: "Strong" };
  if (points === 2) return { score: 2, label: "Good" };
  return { score: 1, label: "Weak" };
}
