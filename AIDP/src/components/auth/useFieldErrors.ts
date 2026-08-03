"use client";

import { useCallback, useState } from "react";

type Errors<K extends string> = Partial<Record<K, string | undefined>>;

/**
 * Field-level error state for the auth forms.
 *
 * `clear` exists because errors that linger while the user is fixing them read
 * as broken — and on the password field the error also displaces the strength
 * hint, so the user loses the feedback they need to satisfy the rule.
 */
export function useFieldErrors<K extends string>() {
  const [errors, setErrors] = useState<Errors<K>>({});

  /** Record the results of all validators; true when every field passes. */
  const validate = useCallback((checks: Errors<K>) => {
    setErrors(checks);
    return !Object.values(checks).some(Boolean);
  }, []);

  /** Drop one field's error as soon as its value changes. */
  const clear = useCallback(
    (key: K) =>
      setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev)),
    [],
  );

  return { errors, validate, clear };
}
