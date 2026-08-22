import { cn } from "@/lib/cn";
import { Reveal } from "./Reveal";

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-ink/66",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="h-px w-6 bg-linear-to-r from-ink/35 to-transparent"
      />
      {children}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = "left",
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex max-w-2xl flex-col gap-5",
        align === "center" && "mx-auto items-center text-center",
        className,
      )}
    >
      {eyebrow ? (
        <Reveal>
          <Eyebrow>{eyebrow}</Eyebrow>
        </Reveal>
      ) : null}
      <Reveal delay={0.06}>
        <h2 className="font-display text-[2.5rem] font-medium leading-[1.04] tracking-[-0.04em] text-ink text-balance sm:text-[3.25rem]">
          {title}
        </h2>
      </Reveal>
      {lede ? (
        <Reveal delay={0.12}>
          <p className="text-[17px] leading-relaxed text-ink/72 text-pretty">
            {lede}
          </p>
        </Reveal>
      ) : null}
    </div>
  );
}
