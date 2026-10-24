import Image from "next/image";

/**
 * The screenshot under the hero.
 *
 * It is placed, not animated. The panel used to rise on a scroll-driven hinge,
 * which meant the first thing below the fold was a sliver of foreshortened
 * image waiting on the scrollbar; a shot that is simply there reads as part of
 * the page instead of a trick the page performs.
 *
 * The negative top margin is the point of the section: it lifts the frame into
 * the white slack at the foot of the hero so the top edge clears the fold on a
 * normal laptop, and the cut-off image is what tells a visitor there is more
 * page under the one they are looking at. The hero clips its own overflow but
 * this is a sibling, so nothing is cropped; the pull lands on paper, well
 * below where the blue band has finished ramping to white.
 */
export function InsideShot() {
  return (
    <section className="relative -mt-10 bg-white pb-16 sm:-mt-28 sm:pb-24">
      <div className="mx-auto w-full max-w-[1200px] px-5 sm:px-6">
        <div className="relative">
          {/* The contact shadow that sets the frame off the paper. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-[6%] bottom-[-26px] h-16 rounded-[50%] bg-[radial-gradient(closest-side,rgba(4,42,65,0.32),rgba(4,42,65,0))] blur-[6px]"
          />

          {/* The mat a print is mounted on. The shot is light and the paper is
              white, so a white mount disappeared into both. At this width the
              mat is nearer a rule than a mount, so it takes the hairline
              token: enough tint to close the edge, not so much that it reads
              as a frame competing with the screenshot inside it. */}
          <div className="relative rounded-[20px] bg-line-soft p-1.5 shadow-[0_0_0_1px_rgba(4,42,65,0.07),0_2px_10px_-4px_rgba(4,42,65,0.14),0_34px_80px_-32px_rgba(4,42,65,0.42)] sm:rounded-[26px] sm:p-2">
            {/* No ring on the shot itself: the mat is the only edge, so the
                picture ends on white rather than on a dark rule. */}
            <div className="overflow-hidden rounded-[15px] sm:rounded-[20px]">
              <Image
                src="/inside.png"
                alt="An AIDP assessment: a submission scored clause by clause against the organisation's standards, with every contradiction cited."
                width={2620}
                height={1402}
                sizes="(min-width: 1240px) 1160px, 100vw"
                priority
                className="block h-auto w-full"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
