"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  KeyRound,
  Search,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/access/format";
import { OWNER, MEMBER, ROLE_LABEL } from "@/lib/access/roles";
import { STATUS_META, type RosterStatus } from "@/lib/access/roster-status";
import type { Person } from "@/lib/access/roster";
import { MIN_PASSWORD } from "@/lib/access/password-policy";
import {
  addPerson,
  grantAccess,
  removePerson,
  revokeAccess,
  setPassword,
  setRole,
} from "./actions";

const TONE: Record<string, string> = {
  good: "border-ok-line bg-ok-tint text-ok",
  warn: "border-warn-line bg-warn-tint text-warn",
  neutral: "border-line bg-card text-ink/68",
  off: "border-line bg-card text-ink/62",
};

type Filter = "all" | RosterStatus;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Everyone" },
  { id: "active", label: "Active" },
  { id: "allowed", label: "Invited" },
  { id: "imported", label: "Not admitted" },
  { id: "revoked", label: "Revoked" },
];

/**
 * The roster.
 *
 * Built around bulk selection because the realistic action is not "admit this
 * person" — it is "I have just imported two hundred names and twelve of them
 * need access". Selecting and admitting together is the whole point of the
 * import; one row at a time would make a spreadsheet upload pointless.
 *
 * The confirmation on revoke is deliberate. It signs someone out immediately
 * and there is no undo beyond re-admitting them, which is a different act with
 * its own audit trail.
 */
export function PeopleTable({
  people,
  currentUserId,
}: {
  people: Person[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return people.filter((person) => {
      if (filter !== "all" && person.status !== filter) return false;
      if (!needle) return true;
      return (
        person.email.includes(needle) ||
        person.name.toLowerCase().includes(needle) ||
        person.department.toLowerCase().includes(needle) ||
        person.jobTitle.toLowerCase().includes(needle)
      );
    });
  }, [people, filter, search]);

  // Selection is kept across filter changes, so anything acted on has to be
  // narrowed back to what is actually on screen — otherwise filtering to
  // "Not admitted" and pressing Revoke would hit rows the user cannot see.
  const actionable = useMemo(
    () => visible.filter((person) => selected.has(person.id)),
    [visible, selected],
  );

  const counts = useMemo(() => {
    const byStatus = { imported: 0, allowed: 0, active: 0, revoked: 0 };
    for (const person of people) {
      if (person.status in byStatus) byStatus[person.status] += 1;
    }
    return byStatus;
  }, [people]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id));

  const toggleAll = () =>
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visible.forEach((person) => next.delete(person.id));
      else visible.forEach((person) => next.add(person.id));
      return next;
    });

  const act = (work: () => Promise<{ ok: boolean; message: string }>, clear = true) =>
    startTransition(async () => {
      const result = await work();
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok && clear) setSelected(new Set());
      setConfirmRevoke(false);
      router.refresh();
    });

  const ids = actionable.map((person) => person.id);

  return (
    <section className="mt-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="mr-auto font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
          Your list
          <span className="ml-2 text-[13px] font-normal text-ink/62">
            {people.length} {people.length === 1 ? "person" : "people"}
          </span>
        </h2>

        <label className="relative">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/62"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, email, team"
            aria-label="Search people"
            className="w-60 rounded-lg border border-line bg-card py-1.5 pl-8 pr-3 text-[12.5px] text-ink/88 placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          />
        </label>

        <button
          type="button"
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink/78 transition-colors hover:border-line-strong hover:text-ink"
        >
          <UserPlus size={13} />
          Add someone
        </button>
      </div>

      {adding && <AddPersonForm onDone={(result) => { setMessage({ ok: result.ok, text: result.message }); if (result.ok) setAdding(false); router.refresh(); }} />}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((option) => {
          const count =
            option.id === "all" ? people.length : counts[option.id as RosterStatus] ?? 0;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              aria-pressed={filter === option.id}
              className={cn(
                "rounded-full border px-3 py-1 text-[12px] transition-colors",
                filter === option.id
                  ? "border-royal-mid/45 bg-royal/10 text-royal"
                  : "border-line text-ink/66 hover:border-line-strong hover:text-ink/78",
              )}
            >
              {option.label}
              <span className="ml-1.5 tabular-nums opacity-55">{count}</span>
            </button>
          );
        })}
      </div>

      {actionable.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-royal-mid/30 bg-royal/[0.08] p-3">
          <span className="mr-auto text-[12.5px] text-ink/78">
            {actionable.length} selected
          </span>

          <button
            type="button"
            disabled={pending}
            onClick={() => act(() => grantAccess(ids, MEMBER))}
            className="inline-flex items-center gap-1.5 rounded-lg bg-royal px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
          >
            <Check size={13} />
            Give access
          </button>

          <button
            type="button"
            disabled={pending}
            onClick={() => act(() => grantAccess(ids, OWNER))}
            title="Admit as an administrator — they can manage people and see spend."
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink/78 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
          >
            <ShieldCheck size={13} />
            As administrator
          </button>

          {confirmRevoke ? (
            <span className="inline-flex items-center gap-2 rounded-lg border border-danger-line bg-danger-tint px-2.5 py-1 text-[12px] text-danger">
              Sign them out and withdraw access?
              <button
                type="button"
                disabled={pending}
                onClick={() => act(() => revokeAccess(ids))}
                className="rounded-md bg-danger px-2 py-0.5 font-medium text-white transition-colors hover:bg-danger/85 disabled:opacity-40"
              >
                Yes, revoke
              </button>
              <button
                type="button"
                onClick={() => setConfirmRevoke(false)}
                className="text-ink/68 transition-colors hover:text-ink"
              >
                cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmRevoke(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink/72 transition-colors hover:border-danger-line hover:text-danger disabled:opacity-40"
            >
              <UserMinus size={13} />
              Revoke
            </button>
          )}
        </div>
      )}

      {message && (
        <p
          role="status"
          className={cn(
            "mb-3 text-[12.5px]",
            message.ok ? "text-ok" : "text-warn",
          )}
        >
          {message.text}
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-line">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-card">
                <th scope="col" className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label="Select everyone shown"
                    className="size-3.5 accent-[var(--color-royal-mid)]"
                  />
                </th>
                <Th>Person</Th>
                <Th>Status</Th>
                <Th>Role</Th>
                <Th className="text-right">Tokens</Th>
                <th scope="col" className="w-10" />
              </tr>
            </thead>
            <tbody>
              {visible.map((person) => (
                <Row
                  key={person.id}
                  person={person}
                  isSelf={person.userId === currentUserId}
                  selected={selected.has(person.id)}
                  onToggle={() => toggle(person.id)}
                  pending={pending}
                  onAct={act}
                />
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-[13px] text-ink/62">
                    {people.length === 0
                      ? "Nobody on the list yet. Import your staff spreadsheet above, or add someone by hand."
                      : "Nobody matches that."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-ink/62",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Row({
  person,
  isSelf,
  selected,
  onToggle,
  pending,
  onAct,
}: {
  person: Person;
  isSelf: boolean;
  selected: boolean;
  onToggle: () => void;
  pending: boolean;
  onAct: (work: () => Promise<{ ok: boolean; message: string }>, clear?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [settingPassword, setSettingPassword] = useState(false);
  const meta = STATUS_META[person.status];

  return (
    <tr
      className={cn(
        "border-b border-line-soft last:border-0 transition-colors",
        selected ? "bg-royal/[0.07]" : "hover:bg-card",
        person.status === "revoked" && "opacity-55",
      )}
    >
      <td className="px-3 py-3 align-middle">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${person.email}`}
          className="size-3.5 accent-[var(--color-royal-mid)]"
        />
      </td>

      <td className="px-3 py-3">
        <p className="text-[13.5px] leading-tight text-ink/92">
          {person.name || person.email.split("@")[0]}
          {isSelf && <span className="ml-2 text-[11px] text-ink/62">you</span>}
        </p>
        <p className="mt-0.5 text-[12px] leading-tight text-ink/64">{person.email}</p>
        {(person.jobTitle || person.department) && (
          <p className="mt-0.5 text-[11.5px] leading-tight text-ink/62">
            {[person.jobTitle, person.department].filter(Boolean).join(" · ")}
          </p>
        )}
      </td>

      <td className="px-3 py-3">
        <span
          title={meta.blurb}
          className={cn(
            "inline-block rounded-md border px-2 py-0.5 text-[11.5px]",
            TONE[meta.tone],
          )}
        >
          {meta.label}
        </span>
        {person.status === "revoked" && person.revokedByName && (
          <p className="mt-1 text-[11px] text-ink/58">by {person.revokedByName}</p>
        )}
        {person.status === "allowed" && !person.hasAccount && (
          <p className="mt-1 text-[11px] text-ink/58">has not signed up</p>
        )}
      </td>

      <td className="px-3 py-3">
        <span
          className={cn(
            "text-[12.5px]",
            person.role === OWNER ? "text-royal" : "text-ink/68",
          )}
        >
          {ROLE_LABEL[person.role]}
        </span>
      </td>

      <td className="px-3 py-3 text-right">
        <span className="text-[13px] tabular-nums text-ink/78">
          {person.totalTokens > 0 ? formatTokens(person.totalTokens) : "—"}
        </span>
        {person.lastActiveAt && (
          <p className="mt-0.5 text-[11px] text-ink/58">
            {new Date(person.lastActiveAt).toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
            })}
          </p>
        )}
      </td>

      <td className="relative px-2 py-3 text-right">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-label={`Actions for ${person.email}`}
          aria-expanded={open}
          className="rounded-md p-1 text-ink/62 transition-colors hover:bg-canvas-sunk hover:text-ink/78"
        >
          <ChevronDown size={14} />
        </button>

        {settingPassword && (
          <PasswordBox
            person={person}
            pending={pending}
            onCancel={() => setSettingPassword(false)}
            onDone={(result) => {
              setSettingPassword(false);
              onAct(async () => result, false);
            }}
          />
        )}

        {open && !settingPassword && (
          <div className="absolute right-2 top-11 z-20 w-52 overflow-hidden rounded-xl border border-line bg-card py-1 shadow-pop">
            <MenuItem
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setSettingPassword(true);
              }}
            >
              <KeyRound size={12} className="mr-1.5 inline" />
              {person.hasAccount ? "Reset password" : "Create account"}
            </MenuItem>

            {person.status !== "revoked" && (
              <MenuItem
                disabled={pending || isSelf}
                onClick={() => {
                  setOpen(false);
                  onAct(() => setRole(person.id, person.role === OWNER ? MEMBER : OWNER), false);
                }}
              >
                {person.role === OWNER ? "Make a member" : "Make an administrator"}
              </MenuItem>
            )}
            {person.status === "imported" && (
              <MenuItem
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  onAct(() => grantAccess([person.id], MEMBER), false);
                }}
              >
                Give access
              </MenuItem>
            )}
            {person.status === "revoked" && (
              <MenuItem
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  onAct(() => grantAccess([person.id], person.role), false);
                }}
              >
                Restore access
              </MenuItem>
            )}
            {/* Only ever offered for someone who never had access. Anyone who
                did is revoked instead — the record has to survive them. */}
            {person.status === "imported" && (
              <MenuItem
                danger
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  onAct(() => removePerson(person.id), false);
                }}
              >
                <Trash2 size={12} className="mr-1.5 inline" />
                Remove from list
              </MenuItem>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "block w-full px-3 py-2 text-left text-[12.5px] transition-colors disabled:opacity-30",
        danger
          ? "text-danger hover:bg-danger-tint"
          : "text-ink/78 hover:bg-canvas-sunk hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function AddPersonForm({
  onDone,
}: {
  onDone: (result: { ok: boolean; message: string }) => void;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) =>
        startTransition(async () => {
          onDone(await addPerson(formData));
        })
      }
      className="mb-4 rounded-xl border border-line bg-card p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input name="email" label="Email" type="email" required placeholder="name@company.com" />
        <Input name="name" label="Name" placeholder="Optional" />
        <Input name="jobTitle" label="Job title" placeholder="Optional" />
        <Input name="department" label="Team" placeholder="Optional" />
      </div>

      {/* Filling this in creates the account outright, so the person can be
          handed credentials instead of being sent to a sign-up form. Left
          blank, they register themselves and choose their own. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Input
          name="password"
          label="Set a password (optional)"
          type="password"
          autoComplete="new-password"
          placeholder={`At least ${MIN_PASSWORD} characters`}
        />
        <p className="self-end pb-1.5 text-[11.5px] leading-relaxed text-ink/62">
          Leave blank and they sign up themselves. Fill it in and their account
          is created now — pass the password on yourself; nothing is emailed.
        </p>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[12.5px] text-ink/72">
          <input
            type="checkbox"
            name="admit"
            defaultChecked
            className="size-3.5 accent-[var(--color-royal-mid)]"
          />
          Give them access straight away
        </label>

        <label className="flex items-center gap-2 text-[12.5px] text-ink/72">
          <input
            type="checkbox"
            name="role"
            value={OWNER}
            className="size-3.5 accent-[var(--color-royal-mid)]"
          />
          As an administrator
        </label>

        <button
          type="submit"
          disabled={pending}
          className="ml-auto rounded-full bg-royal px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  );
}

function Input({
  name,
  label,
  type = "text",
  required,
  placeholder,
  autoComplete,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-ink/62">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink/88 placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
      />
    </label>
  );
}

/**
 * Setting one person's password from their row.
 *
 * Inline rather than a modal: it is a two-second action taken while looking at
 * the list, and the administrator needs to see whose row they are typing into.
 */
function PasswordBox({
  person,
  pending,
  onDone,
  onCancel,
}: {
  person: Person;
  pending: boolean;
  onDone: (result: { ok: boolean; message: string }) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const tooShort = value.length > 0 && value.length < MIN_PASSWORD;

  return (
    <div className="absolute right-2 top-11 z-20 w-72 rounded-xl border border-line bg-card p-3 shadow-pop">
      <p className="mb-2 text-[11.5px] leading-relaxed text-ink/66">
        Set a password for {person.email}. You will need to pass it on — nothing
        is emailed.
      </p>
      <input
        type="password"
        value={value}
        autoFocus
        autoComplete="new-password"
        onChange={(event) => setValue(event.target.value)}
        placeholder={`At least ${MIN_PASSWORD} characters`}
        className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink/88 placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
      />
      {tooShort && (
        <p className="mt-1.5 text-[11px] text-warn">
          {MIN_PASSWORD - value.length} more character
          {MIN_PASSWORD - value.length === 1 ? "" : "s"}.
        </p>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={pending || value.length < MIN_PASSWORD}
          onClick={async () => onDone(await setPassword(person.id, value))}
          className="rounded-lg bg-royal px-3 py-1 text-[12px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
        >
          {person.hasAccount ? "Reset it" : "Create account"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] text-ink/64 transition-colors hover:text-ink"
        >
          cancel
        </button>
      </div>
    </div>
  );
}
