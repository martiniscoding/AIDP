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
      className="self-start rounded-full border border-white/25 px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
    >
      Sign out
    </button>
  );
}
