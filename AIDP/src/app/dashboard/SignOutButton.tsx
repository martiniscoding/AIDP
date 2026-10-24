"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={async () => {
        await signOut();
        router.push("/");
        router.refresh();
      }}
      className="flex w-full items-center justify-center whitespace-nowrap rounded-full border border-rail-ink/25 px-3.5 py-1.5 text-[12.5px] text-rail-ink/80 transition-colors hover:bg-rail-ink/10 hover:text-rail-ink"
    >
      Sign out
    </button>
  );
}
