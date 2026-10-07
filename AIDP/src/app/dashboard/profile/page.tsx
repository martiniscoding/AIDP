import type { Metadata } from "next";
import { requireOwnerWorkspace } from "@/lib/access/gate";
import { load } from "@/lib/access/profile";
import { load as loadCredential } from "@/lib/access/credentials";
import { secretsConfigured } from "@/lib/access/secrets";
import { ProfileForm } from "./ProfileForm";
import { ModelKey } from "./ModelKey";

export const metadata: Metadata = {
  title: "Profile",
  description: "Your company's details.",
};

/**
 * The company's own record.
 *
 * `requireOwnerWorkspace` is the check that matters — the nav link is hidden
 * from a member as well, but that is cosmetic, and the Server Action behind the
 * form repeats the check for itself because it accepts a direct POST.
 */
export default async function ProfilePage() {
  const access = await requireOwnerWorkspace();
  const [profile, credential] = await Promise.all([
    load(access.organisation.id),
    loadCredential(access.organisation.id),
  ]);

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-ink">
          Profile
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] text-ink/68">
          Your company&rsquo;s details and the model key your assessments run on. Only
          administrators can change these.
        </p>
      </header>

      <ProfileForm profile={profile} />

      <ModelKey credential={credential} storageReady={secretsConfigured()} />

      <p className="mt-4 text-[12px] text-ink/62">
        Workspace created{" "}
        {profile.createdAt.toLocaleDateString(undefined, {
          day: "numeric",
          month: "long",
          year: "numeric",
        })}
        {" · "}
        handle <code className="text-ink/70">{profile.slug}</code>, which never changes
      </p>
    </>
  );
}
