import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GroupCategory, GroupRule, GroupSettings, GroupMatchKind } from "./types";

interface Props {
  open: boolean;
  onClose: () => void;
  /// Bumped after any settings change so the rest of the app re-fetches layout.
  onChanged: () => void;
}

export function GroupSettingsDialog({ open, onClose, onChanged }: Props) {
  const [settings, setSettings] = useState<GroupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    invoke<GroupSettings>("get_group_settings")
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function save(next: GroupSettings) {
    setSettings(next);
    try {
      await invoke("set_group_settings", { settings: next });
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  async function reset() {
    try {
      const fresh = await invoke<GroupSettings>("reset_group_settings");
      setSettings(fresh);
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-black/60 p-6"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[44rem] max-w-full flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Folder grouping</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Treat auto-generated folders as single blocks in the treemap.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-xs">
          {error && <div className="mb-3 text-red-400">{error}</div>}
          {!settings && !error && <div className="text-zinc-500">Loading…</div>}
          {settings && (
            <div className="space-y-5">
              {settings.categories.map((cat) => (
                <CategorySection
                  key={cat.id}
                  category={cat}
                  onChange={(next) =>
                    save({
                      ...settings,
                      categories: settings.categories.map((c) =>
                        c.id === cat.id ? next : c,
                      ),
                    })
                  }
                />
              ))}
              <CustomRulesSection
                rules={settings.custom_rules}
                onChange={(rules) => save({ ...settings, custom_rules: rules })}
              />
              <OverridesSection
                excluded={settings.excluded_paths}
                forced={settings.forced_paths}
                onChange={(excluded, forced) =>
                  save({ ...settings, excluded_paths: excluded, forced_paths: forced })
                }
              />
            </div>
          )}
        </div>
        <footer className="flex shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-900/60 px-5 py-3">
          <button
            onClick={reset}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            Reset to defaults
          </button>
          <button
            onClick={onClose}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function CategorySection({
  category,
  onChange,
}: {
  category: GroupCategory;
  onChange: (next: GroupCategory) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="rounded border border-zinc-800 bg-zinc-950/40">
      <header className="flex items-center gap-3 px-3 py-2">
        <Toggle
          checked={category.enabled}
          onChange={(v) => onChange({ ...category, enabled: v })}
        />
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-zinc-100">{category.label}</span>
            <span className="text-[10px] text-zinc-500">
              {category.rules.length} pattern{category.rules.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
            {category.description}
          </p>
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-zinc-500 hover:text-zinc-200"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
      </header>
      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <RuleList
            rules={category.rules}
            onChange={(rules) => onChange({ ...category, rules })}
          />
        </div>
      )}
    </section>
  );
}

function CustomRulesSection({
  rules,
  onChange,
}: {
  rules: GroupRule[];
  onChange: (next: GroupRule[]) => void;
}) {
  return (
    <section className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <header className="mb-2">
        <div className="font-medium text-zinc-100">Custom rules</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
          Your own folder names or directory extensions to group.
        </p>
      </header>
      <RuleList rules={rules} onChange={onChange} />
    </section>
  );
}

function RuleList({
  rules,
  onChange,
}: {
  rules: GroupRule[];
  onChange: (next: GroupRule[]) => void;
}) {
  const [draftPattern, setDraftPattern] = useState("");
  const [draftKind, setDraftKind] = useState<GroupMatchKind>("name");

  function add() {
    const p = draftPattern.trim();
    if (!p) return;
    const rule: GroupRule = { kind: draftKind, pattern: p, under: [] };
    onChange([...rules, rule]);
    setDraftPattern("");
  }

  return (
    <div>
      {rules.length === 0 && (
        <div className="mb-2 text-[11px] italic text-zinc-600">No patterns yet.</div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {rules.map((r, i) => (
          <span
            key={`${r.kind}:${r.pattern}:${i}`}
            className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800/70 px-2 py-0.5 font-mono text-[11px]"
          >
            <span className="text-zinc-500">{ruleKindLabel(r.kind)}:</span>
            <span className="text-zinc-200">{r.pattern}</span>
            {r.under.length > 0 && (
              <span className="text-zinc-500">under {r.under.join("/")}</span>
            )}
            <button
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
              className="ml-1 text-zinc-500 hover:text-red-400"
              aria-label="Remove"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        <div className="relative">
          <select
            value={draftKind}
            onChange={(e) => setDraftKind(e.target.value as GroupMatchKind)}
            className="appearance-none rounded border border-zinc-700 bg-zinc-800 py-1 pl-2 pr-6 text-[11px] text-zinc-200 focus:border-blue-500 focus:outline-none"
          >
            <option value="name">Name</option>
            <option value="dir_ext">Dir ext</option>
          </select>
          <span
            aria-hidden
            className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-zinc-400"
          >
            ▾
          </span>
        </div>
        <input
          value={draftPattern}
          onChange={(e) => setDraftPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder={draftKind === "name" ? "node_modules" : ".app"}
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={add}
          className="rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-500"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function ruleKindLabel(k: GroupMatchKind): string {
  switch (k) {
    case "name":
      return "name";
    case "dir_ext":
      return "ext";
    case "name_under":
      return "name@";
  }
}

function OverridesSection({
  excluded,
  forced,
  onChange,
}: {
  excluded: string[];
  forced: string[];
  onChange: (excluded: string[], forced: string[]) => void;
}) {
  return (
    <section className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <header className="mb-2">
        <div className="font-medium text-zinc-100">Per-folder overrides</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
          Right-click any folder in the treemap to add an override here.
        </p>
      </header>
      <PathList
        label="Always grouped"
        paths={forced}
        emptyText="None forced."
        onRemove={(p) => onChange(excluded, forced.filter((x) => x !== p))}
      />
      <div className="h-2" />
      <PathList
        label="Never grouped"
        paths={excluded}
        emptyText="None excluded."
        onRemove={(p) => onChange(excluded.filter((x) => x !== p), forced)}
      />
    </section>
  );
}

function PathList({
  label,
  paths,
  emptyText,
  onRemove,
}: {
  label: string;
  paths: string[];
  emptyText: string;
  onRemove: (p: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-zinc-500">{label}</div>
      {paths.length === 0 ? (
        <div className="text-[11px] italic text-zinc-600">{emptyText}</div>
      ) : (
        <ul className="space-y-1">
          {paths.map((p) => (
            <li
              key={p}
              className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">
                {p}
              </span>
              <button
                onClick={() => onRemove(p)}
                className="text-zinc-500 hover:text-red-400"
                aria-label="Remove"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-block h-[18px] w-8 shrink-0 rounded-full transition-colors ${
        checked ? "bg-blue-600" : "bg-zinc-700"
      }`}
      aria-pressed={checked}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[14px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
