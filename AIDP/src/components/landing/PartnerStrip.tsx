const MARKS = [
  // A bolt, a cluster, a wave, a prism, a ring — five silhouettes distinct
  // enough to read as five different companies at logo size.
  "M13 4 7 12h4l-1 8 6-8h-4l1-8Z",
  "M12 7.5a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm0 5.8a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm-4.4-2.9a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm8.8 0a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z",
  "M5 14.5c3-4 5-1.5 7-3s2.5-4 7-3.5c-1 7-5.5 10-8.5 10-2.2 0-4.3-1.2-5.5-3.5Z",
  "M12 4 20 12l-8 8-8-8 8-8Zm0 4.6L8.6 12l3.4 3.4L15.4 12 12 8.6Z",
  "M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm0 2.6A5.4 5.4 0 1 0 12 17.4 5.4 5.4 0 0 0 12 6.6Z",
];

/**
 * The logo wall. The row is laid out wider than its frame and masked at both
 * edges, so the outer two marks fall off the sides rather than ending in a
 * tidy row — a wall that stops cleanly reads as the five logos they have,
 * one that runs off the edge reads as more of them off-screen.
 *
 * The marks are placeholders. Swap `MARKS` and the wordmark for real partner
 * artwork before this goes in front of anyone who would recognise them.
 */
export function PartnerStrip() {
  return (
    <section className="bg-white pt-6 pb-16 sm:pt-8 sm:pb-20">
      <h2 className="px-5 text-center font-display text-[clamp(1.35rem,3.1vw,1.75rem)] font-semibold tracking-[-0.03em] text-ink">
        Partnering with top industry experts
      </h2>

      <div
        className="mt-8 overflow-hidden sm:mt-10"
        style={{
          maskImage:
            "linear-gradient(90deg, transparent 0%, #000 12%, #000 88%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(90deg, transparent 0%, #000 12%, #000 88%, transparent 100%)",
        }}
      >
        <ul className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-6 px-2 sm:gap-10">
          {MARKS.map((d, i) => (
            <li
              key={d}
              className={`flex shrink-0 items-center gap-2.5 ${i === 0 || i === MARKS.length - 1 ? "opacity-55" : ""}`}
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="size-7 shrink-0 text-ink sm:size-9"
              >
                <circle cx="12" cy="12" r="12" fill="currentColor" />
                <path d={d} fill="#ffffff" />
              </svg>
              <span className="font-display text-[clamp(0.95rem,2vw,1.4rem)] font-semibold tracking-[-0.03em] whitespace-nowrap text-ink">
                Logoipsum
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
