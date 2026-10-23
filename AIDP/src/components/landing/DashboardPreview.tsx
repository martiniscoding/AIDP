import {
  Bell,
  ChartColumn,
  ChevronDown,
  FileText,
  House,
  LifeBuoy,
  Search,
  Settings,
  User,
  Users,
} from "lucide-react";

/**
 * The product shot under the hero: a drawn mock of the app rather than a
 * screenshot.
 *
 * Drawn because a screenshot of a real dashboard is a raster that goes soft on
 * a 2x display, carries whatever data happened to be in the database that day,
 * and has to be retaken every time a padding changes. This is type and boxes,
 * so it stays sharp, the numbers are chosen, and it costs no image bytes.
 *
 * It is deliberately cut off at the bottom. The frame is rounded on its top
 * corners only and the body is a fixed height with the overflow clipped, so
 * the panel reads as continuing past the fold — which is the whole job of a
 * hero product shot. Nothing below the clip line is load-bearing.
 */

const NAV = [
  { label: "Dashboard", icon: House, active: true },
  { label: "Growth", icon: ChartColumn, active: false },
  { label: "Customers", icon: Users, active: false },
  { label: "Reports", icon: FileText, active: false },
  { label: "Support", icon: LifeBuoy, active: false },
  { label: "Settings", icon: Settings, active: false },
];

const KPIS = [
  { label: "Current MRR", value: "$873.4k", delta: "10%" },
  { label: "Current Customers", value: "124,970", delta: "12%" },
  { label: "Active Customers", value: "80.20%", delta: "10%" },
];

// [month, lead bar, trailing bar] as fractions of the plot height. Hand-set
// rather than generated: a random series draws a sawtooth, and the shape of
// this chart is the only thing anyone actually reads at this size.
const MONTHS: [string, number, number][] = [
  ["Jan", 0.74, 0.44],
  ["Feb", 0.54, 0.31],
  ["Mar", 0.31, 0.52],
  ["Apr", 0.45, 0.27],
  ["May", 0.61, 0.37],
  ["Jun", 0.88, 0.52],
  ["Jul", 0.27, 0.45],
  ["Aug", 0.67, 0.39],
  ["Sep", 0.58, 0.74],
  ["Oct", 0.71, 0.41],
  ["Nov", 0.53, 0.66],
  ["Dec", 1, 0.47],
];

const ACTIVITY = [
  {
    name: "John Clayton",
    status: "New Customer",
    dot: "bg-[#7c3aed]",
    id: "#12931166",
    referral: "Linkedin",
    amount: "$42",
  },
  {
    name: "Jane Cooper",
    status: "Returning",
    dot: "bg-[#12b76a]",
    id: "#12931167",
    referral: "Twitter",
    amount: "$64",
  },
];

const COLUMNS = "grid-cols-[26%_25%_18%_17%_14%]";

function CardHeader({
  title,
  control,
}: {
  title: string;
  control?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[#f1eff7] px-3.5 py-2.5">
      <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-ink">
        {title}
      </h3>
      {control ? (
        <span className="inline-flex items-center gap-1.5 rounded-[7px] border border-[#eae7f2] bg-white px-2 py-1 text-[10.5px] text-ink/60">
          {control}
          <ChevronDown size={11} strokeWidth={2} className="text-ink/40" />
        </span>
      ) : null}
    </div>
  );
}

function Delta({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[6px] bg-[#ecfdf3] px-2 py-[3px] text-[10px] font-medium text-[#067647]">
      <span aria-hidden="true" className="text-[7px] leading-none">
        ▲
      </span>
      {value}
    </span>
  );
}

export function DashboardPreview() {
  return (
    <div className="mx-auto w-full max-w-[1060px] px-5 sm:px-6">
      {/* Outer frame: a pale bezel so the white app surface has something to
          sit in. Without it the card's top edge dissolves into the paper the
          gradient has already faded to. */}
      <div className="rounded-t-[26px] border border-white/80 bg-[#eeebf6]/80 p-2 shadow-[0_2px_8px_-4px_rgba(46,16,101,0.12),0_28px_70px_-30px_rgba(46,16,101,0.35)] backdrop-blur-sm sm:p-2.5">
        <div className="flex h-[440px] overflow-hidden rounded-t-[19px] bg-white sm:h-[500px] lg:h-[540px]">
          {/* Sidebar. Dropped below lg — at phone width it would take half the
              panel and leave the charts, which are the point, unreadable. */}
          <aside className="hidden w-[196px] shrink-0 flex-col gap-1 border-r border-[#f1eff7] px-3.5 py-4 lg:flex">
            <div className="mb-5 flex items-center gap-2.5 px-1">
              <span className="grid size-[30px] place-items-center rounded-full bg-[linear-gradient(140deg,#8b5cf6_0%,#6d28d9_100%)]">
                <span className="block size-[11px] rounded-full border-[2.5px] border-white border-b-transparent" />
              </span>
              <span className="font-display text-[16px] font-semibold tracking-[-0.02em] text-ink">
                Dexter
              </span>
            </div>

            {NAV.map(({ label, icon: Icon, active }) => (
              <div
                key={label}
                className={
                  active
                    ? "flex h-10 items-center gap-2.5 rounded-[10px] bg-[linear-gradient(95deg,#7c3aed_0%,#8b5cf6_100%)] px-3 text-[12.5px] font-medium text-white shadow-[0_6px_16px_-8px_rgba(109,40,217,0.9)]"
                    : "flex h-10 items-center gap-2.5 rounded-[10px] px-3 text-[12.5px] text-ink/62"
                }
              >
                <Icon
                  size={15}
                  strokeWidth={1.9}
                  className={active ? "text-white" : "text-ink/45"}
                />
                {label}
              </div>
            ))}
          </aside>

          {/* App surface */}
          <div className="flex min-w-0 flex-1 flex-col bg-[#f8f7fc] p-3.5 sm:p-4">
            {/* Top bar */}
            <div className="flex items-center gap-3">
              <h2 className="shrink-0 text-[16px] font-semibold tracking-[-0.015em] text-ink">
                Overview
              </h2>

              <div className="mx-auto hidden h-9 w-full max-w-[300px] items-center gap-2 rounded-[9px] border border-[#ebe8f3] bg-white px-3 sm:flex">
                <Search size={13} strokeWidth={2} className="text-ink/35" />
                <span className="text-[11.5px] text-ink/35">Overview</span>
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-2">
                <span className="grid size-9 place-items-center rounded-full border border-[#ebe8f3] bg-white">
                  <Bell size={14} strokeWidth={1.9} className="text-ink/50" />
                </span>
                <span className="flex h-9 items-center gap-2 rounded-[9px] border border-[#ebe8f3] bg-white pr-2 pl-1.5">
                  <span className="grid size-6 place-items-center rounded-full bg-[#ede9fe]">
                    <User size={12} strokeWidth={2} className="text-[#7c3aed]" />
                  </span>
                  <span className="hidden text-[11.5px] text-ink/75 sm:inline">
                    John Clayton
                  </span>
                  <ChevronDown size={13} strokeWidth={2} className="text-ink/40" />
                </span>
              </div>
            </div>

            {/* Cards. The two rows are one grid so the second row's tops line
                up with each other even though the cards above differ in
                height. */}
            <div className="mt-3.5 grid min-h-0 flex-1 grid-cols-1 gap-3.5 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
              {/* KPIs */}
              <section className="min-w-0 rounded-[12px] border border-[#ecebf3] bg-white">
                <CardHeader title="KPIs" />
                <div className="divide-y divide-[#f4f2f9]">
                  {KPIS.map(({ label, value, delta }) => (
                    <div
                      key={label}
                      className="flex items-end justify-between gap-3 px-3.5 py-2.5"
                    >
                      <div>
                        <p className="text-[10.5px] text-ink/45">{label}</p>
                        <p className="font-display text-[26px] leading-[1.15] font-bold tracking-[-0.025em] text-[#7c3aed]">
                          {value}
                        </p>
                      </div>
                      <Delta value={delta} />
                    </div>
                  ))}
                </div>
              </section>

              {/* Growth */}
              <section className="flex min-w-0 flex-col rounded-[12px] border border-[#ecebf3] bg-white">
                <CardHeader title="This years growth" control="Yearly" />
                <div className="flex flex-1 items-end gap-[2px] px-3 pt-4 pb-3 sm:gap-1">
                  {MONTHS.map(([month, lead, trail]) => (
                    <div
                      key={month}
                      className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
                    >
                      <div className="flex h-[136px] w-full items-end justify-center gap-[2px] sm:gap-[3px]">
                        <span
                          className="w-[7px] rounded-[2px] bg-[linear-gradient(180deg,#7c3aed_0%,#c4b5fd_100%)] sm:w-[9px]"
                          style={{ height: `${lead * 100}%` }}
                        />
                        <span
                          className="w-[7px] rounded-[2px] bg-[linear-gradient(180deg,#ddd6fe_0%,#f3effe_100%)] sm:w-[9px]"
                          style={{ height: `${trail * 100}%` }}
                        />
                      </div>
                      <span className="text-[9px] text-ink/40">{month}</span>
                    </div>
                  ))}
                </div>
              </section>

              {/* Analytics */}
              <section className="min-w-0 rounded-[12px] border border-[#ecebf3] bg-white">
                <CardHeader title="Analytics" />
                <div className="px-3.5 pt-6">
                  {/* Half-donut. Drawn as one stroked arc with a round cap
                      rather than two stacked rings: at this size a track
                      behind it just reads as a smudge. */}
                  <svg viewBox="0 0 220 112" className="w-full" role="img" aria-label="Analytics gauge">
                    <defs>
                      <linearGradient id="gauge" x1="0" y1="1" x2="1" y2="0">
                        <stop offset="0%" stopColor="#ddd6fe" />
                        <stop offset="48%" stopColor="#8b5cf6" />
                        <stop offset="100%" stopColor="#6d28d9" />
                      </linearGradient>
                    </defs>
                    <path
                      d="M26 108a84 84 0 0 1 168 0"
                      fill="none"
                      stroke="url(#gauge)"
                      strokeWidth="30"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </section>

              {/* Recent activity */}
              <section className="min-w-0 rounded-[12px] border border-[#ecebf3] bg-white">
                <CardHeader title="Recent Activity" control="Last 24H" />
                <div
                  className={`grid ${COLUMNS} border-b border-[#f1eff7] text-[10px] text-ink/45`}
                >
                  {["Customers", "Status", "Customers", "Referral", "Amount"].map(
                    (head, i) => (
                      <span
                        key={head + i}
                        className={
                          i === 0
                            ? "min-w-0 truncate px-2 py-2"
                            : "min-w-0 truncate border-l border-[#f4f2f9] px-2 py-2"
                        }
                      >
                        {head}
                      </span>
                    ),
                  )}
                </div>
                {ACTIVITY.map((row) => (
                  <div
                    key={row.id}
                    className={`grid ${COLUMNS} border-b border-[#f4f2f9] text-[10.5px] text-ink/72`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 px-2 py-2.5">
                      <User size={11} strokeWidth={2} className="shrink-0 text-ink/35" />
                      <span className="truncate">{row.name}</span>
                    </span>
                    <span className="flex min-w-0 items-center border-l border-[#f4f2f9] px-2 py-2.5">
                      <span className="inline-flex min-w-0 items-center gap-1 rounded-[5px] bg-[#f7f5ff] px-1 py-[3px] text-[10px]">
                        <span className={`size-[5px] shrink-0 rounded-full ${row.dot}`} />
                        <span className="truncate">{row.status}</span>
                      </span>
                    </span>
                    <span className="truncate border-l border-[#f4f2f9] px-2 py-2.5">
                      {row.id}
                    </span>
                    <span className="truncate border-l border-[#f4f2f9] px-2 py-2.5">
                      {row.referral}
                    </span>
                    <span className="min-w-0 truncate border-l border-[#f4f2f9] px-2 py-2.5">
                      {row.amount}
                    </span>
                  </div>
                ))}
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
