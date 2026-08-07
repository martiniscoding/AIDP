import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveActive } from "@/lib/ingest/org";
import { loadAssessment } from "@/lib/tech-stack/load";
import { AssessmentForm } from "./AssessmentForm";

export const metadata: Metadata = {
  title: "Technology Stack & Architecture Reference",
};

export default async function TechStackPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const user = session.user as typeof session.user & { company?: string };
  const organisation = await resolveActive(user);
  const { input, savedAt, status } = await loadAssessment(
    { id: user.id, name: user.name, company: user.company },
    organisation.id,
  );

  return (
    <>
      <header className="mb-10 max-w-3xl">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-royal-soft/70">
            Client assessment
          </p>
          {status === "submitted" ? (
            <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
              Submitted
            </span>
          ) : (
            <span className="rounded-full border border-white/15 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-white/50">
              Draft
            </span>
          )}
        </div>

        <h1 className="mt-3 font-display text-[34px] font-semibold leading-[1.1] tracking-[-0.02em] text-white sm:text-[40px]">
          Technology Stack &amp; Architecture Reference
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-white/55">
          Tell us where your data lives today and where you want it to go. We use
          this to tailor recommendations to your stack rather than a generic one
          — so answer what you know and leave the rest. Everything saves as a
          draft until you submit.
        </p>
      </header>

      <AssessmentForm initial={input} initialSavedAt={savedAt} />
    </>
  );
}
