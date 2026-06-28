"use client";
import { useCallback, useEffect, useState } from "react";
import { api, type Provider, type ProviderInput } from "@/lib/api";

/**
 * LLM provider management, shown on /settings for owners/admins.
 *
 * Operators add one or more OpenAI-compatible providers (base URL + model + API
 * key) and mark one active; the distillation pipeline uses the active one. API
 * keys are encrypted at rest server-side and never sent back to the browser —
 * the form leaves the key blank on edit to keep the stored one.
 */
const EMPTY: ProviderInput = { label: "", baseURL: "https://api.openai.com/v1", model: "", fastModel: "", maxTokens: 2000, apiKey: "" };

export function Providers() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [active, setActive] = useState<{ model: string; label: string } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // provider id or "new"
  const [form, setForm] = useState<ProviderInput>(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await api.providers();
      setProviders(r.providers);
      setActive({ model: r.active.model, label: r.active.label });
    } catch {
      setErr("Could not load providers. Try again.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startAdd = () => { setForm(EMPTY); setEditing("new"); };
  const startEdit = (p: Provider) => {
    setForm({ label: p.label, baseURL: p.baseURL, model: p.model, fastModel: p.fastModel, maxTokens: p.maxTokens, apiKey: "" });
    setEditing(p.id);
  };

  const save = async () => {
    if (!form.label.trim() || !form.baseURL.trim() || !form.model.trim()) {
      setErr("Label, base URL, and model are required.");
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const payload: ProviderInput = {
        label: form.label.trim(),
        baseURL: form.baseURL.trim(),
        model: form.model.trim(),
        fastModel: form.fastModel?.trim() || undefined,
        maxTokens: form.maxTokens || undefined,
        // Omit an empty key on edit so the stored one is preserved.
        ...(form.apiKey?.trim() ? { apiKey: form.apiKey.trim() } : {}),
      };
      if (editing === "new") await api.createProvider(payload);
      else if (editing) await api.updateProvider(editing, payload);
      setEditing(null);
      await load();
    } catch {
      setErr("Could not save the provider. Check the fields and try again.");
    }
    setSaving(false);
  };

  const activate = async (p: Provider) => {
    setBusy(p.id);
    setErr("");
    try { await api.activateProvider(p.id); await load(); }
    catch { setErr("Could not switch the active provider."); }
    setBusy(null);
  };

  const remove = async (p: Provider) => {
    setBusy(p.id);
    setErr("");
    try { await api.deleteProvider(p.id); await load(); }
    catch { setErr("Could not delete that provider."); }
    setConfirming(null);
    setBusy(null);
  };

  return (
    <section>
      <div className="label" style={{ marginBottom: 14 }}><span className="sq blue" /> model providers</div>
      <p className="sub" style={{ fontSize: 14, marginBottom: 14 }}>
        Connect any OpenAI-compatible inference provider for <strong>this workspace</strong>. Add as many as
        you like and mark one active — it overrides the instance default for your team&rsquo;s projects. With
        none added, your workspace uses the instance default. API keys are encrypted at rest and never leave the server.
      </p>
      {active?.model && (
        <p className="mono" style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 14 }}>
          active model: <strong style={{ color: "var(--ink)" }}>{active.model}</strong>
          {active.label ? ` · ${active.label}` : ""}
          {providers && providers.length === 0 ? " (instance default)" : ""}
        </p>
      )}
      {err && <div className="mono" style={{ color: "var(--blocked)", marginBottom: 12 }}>{err}</div>}

      {providers === null ? (
        <div className="empty">Loading…</div>
      ) : (
        <div className="card pad" style={{ display: "grid", gap: 14 }}>
          {providers.length === 0 ? (
            <div className="empty" style={{ padding: "8px 0" }}>No providers yet. Add one to enable distillation.</div>
          ) : providers.map((p) => {
            const rowBusy = busy === p.id;
            return (
              <div key={p.id} className="pitem">
                <div className="ptext" style={{ display: "grid", gap: 2 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <strong>{p.label}</strong>
                    {p.active && <span className="tiny" style={{ color: "var(--active)" }}>● active</span>}
                  </span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    {p.model}{p.fastModel && p.fastModel !== p.model ? ` · fast: ${p.fastModel}` : ""} · {p.baseURL}
                    {p.hasKey ? ` · key ${p.keyMask}` : " · no key"}
                  </span>
                </div>
                <div className="pmeta">
                  <div className="acts" style={{ alignItems: "center" }}>
                    {rowBusy ? (
                      <span className="tiny">working…</span>
                    ) : confirming === p.id ? (
                      <>
                        <button className="tiny" onClick={() => remove(p)}>confirm</button>
                        <button className="tiny" onClick={() => setConfirming(null)}>cancel</button>
                      </>
                    ) : (
                      <>
                        {!p.active && <button className="tiny" onClick={() => activate(p)}>make active</button>}
                        <button className="tiny" onClick={() => startEdit(p)}>edit</button>
                        <button className="tiny" onClick={() => setConfirming(p.id)}>delete</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {editing ? (
            <div style={{ display: "grid", gap: 10, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                {editing === "new" ? "new provider" : "edit provider"}
              </div>
              <Field label="Label" value={form.label} placeholder="OpenAI" onChange={(v) => setForm({ ...form, label: v })} />
              <Field label="Base URL" value={form.baseURL} placeholder="https://api.openai.com/v1" onChange={(v) => setForm({ ...form, baseURL: v })} />
              <Field label="Model" value={form.model} placeholder="gpt-4o" onChange={(v) => setForm({ ...form, model: v })} />
              <Field label="Fast model (optional)" value={form.fastModel ?? ""} placeholder="gpt-4o-mini" onChange={(v) => setForm({ ...form, fastModel: v })} />
              <Field
                label={editing === "new" ? "API key" : "API key (leave blank to keep current)"}
                value={form.apiKey ?? ""}
                placeholder="sk-…"
                type="password"
                onChange={(v) => setForm({ ...form, apiKey: v })}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button className="btn solid" onClick={save} disabled={saving}>{saving ? "saving…" : "save provider"}</button>
                <button className="btn" onClick={() => { setEditing(null); setErr(""); }}>cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ borderTop: providers.length ? "1px solid var(--line)" : undefined, paddingTop: providers.length ? 14 : 0 }}>
              <button className="btn solid" onClick={startAdd}>add provider</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Field({ label, value, placeholder, type, onChange }: {
  label: string; value: string; placeholder?: string; type?: string; onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{label}</span>
      <input
        className="tokeninput"
        type={type || "text"}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
