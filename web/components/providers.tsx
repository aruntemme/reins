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
  // Whether the operator's instance-wide fallback model is configured.
  const [instanceDefault, setInstanceDefault] = useState(false);
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
      setInstanceDefault(!!r.instanceDefault);
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
    <section id="providers" className="st-section" aria-labelledby="st-h-providers">
      <h2 id="st-h-providers" className="rz-section-h">Model providers</h2>
      <p className="st-desc">
        Connect any OpenAI-compatible inference provider for <strong>this workspace</strong>. Add as many as
        you like and mark one active — it overrides the instance default for your team&rsquo;s projects. With
        none added, your workspace uses the instance default. API keys are encrypted at rest and never leave the server.
      </p>
      {active?.model && (
        <p className="st-model">
          Active model: <code>{active.model}</code>
          {active.label ? ` · ${active.label}` : ""}
          {providers && providers.length === 0 ? " (instance default)" : ""}
        </p>
      )}
      {err && <p className="st-err" role="alert">{err}</p>}

      {providers === null ? (
        <p className="st-empty">Loading…</p>
      ) : (
        <div className="rz-card st-card">
          {providers.length === 0 ? (
            <p className="st-empty">
              {instanceDefault
                ? "No workspace providers yet. Distillation uses the instance default; add one to use your own."
                : "No providers yet. Add one to enable distillation."}
            </p>
          ) : (
            <ul className="st-list">
              {providers.map((p) => {
                const rowBusy = busy === p.id;
                return (
                  <li key={p.id} className="st-item">
                    <div className="st-prov">
                      <span className="st-prov-name">
                        {p.label}
                        {p.active && <span className="rz-chip live"><span className="rz-live" aria-hidden="true" />active</span>}
                      </span>
                      <span className="st-prov-meta">
                        {p.model}{p.fastModel && p.fastModel !== p.model ? ` · fast: ${p.fastModel}` : ""} · {p.baseURL}
                        {p.hasKey ? ` · key ${p.keyMask}` : " · no key"}
                      </span>
                    </div>
                    <div className="st-ctrl">
                      {rowBusy ? (
                        <span className="st-working" role="status">working…</span>
                      ) : confirming === p.id ? (
                        <>
                          <button className="rz-btn small warn" onClick={() => remove(p)}>Confirm delete</button>
                          <button className="rz-btn small ghost" onClick={() => setConfirming(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          {!p.active && <button className="rz-btn small ghost" onClick={() => activate(p)}>Make active</button>}
                          <button className="rz-btn small ghost" onClick={() => startEdit(p)} aria-label={`Edit ${p.label}`}>Edit</button>
                          <button className="rz-btn small ghost" onClick={() => setConfirming(p.id)} aria-label={`Delete ${p.label}`}>Delete</button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {editing ? (
            <div className="st-form">
              <h3 className="st-title st-formhead">{editing === "new" ? "New provider" : "Edit provider"}</h3>
              <Field label="Label" value={form.label} placeholder="OpenAI" onChange={(v) => setForm({ ...form, label: v })} />
              <Field label="Model" value={form.model} placeholder="gpt-4o" mono onChange={(v) => setForm({ ...form, model: v })} />
              <Field wide label="Base URL" value={form.baseURL} placeholder="https://api.openai.com/v1" mono onChange={(v) => setForm({ ...form, baseURL: v })} />
              <Field label="Fast model (optional)" value={form.fastModel ?? ""} placeholder="gpt-4o-mini" mono onChange={(v) => setForm({ ...form, fastModel: v })} />
              <Field
                label={editing === "new" ? "API key" : "API key (leave blank to keep current)"}
                value={form.apiKey ?? ""}
                placeholder="sk-…"
                type="password"
                mono
                onChange={(v) => setForm({ ...form, apiKey: v })}
              />
              <div className="st-acts">
                <button className="rz-btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save provider"}</button>
                <button className="rz-btn ghost" onClick={() => { setEditing(null); setErr(""); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className={`st-addrow${providers.length ? "" : " first"}`}>
              <button className="rz-btn primary" onClick={startAdd}>Add provider</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Field({ label, value, placeholder, type, mono, wide, onChange }: {
  label: string; value: string; placeholder?: string; type?: string; mono?: boolean; wide?: boolean; onChange: (v: string) => void;
}) {
  return (
    <label className={`st-field${wide ? " wide" : ""}`}>
      <span className="st-label">{label}</span>
      <input
        className={`st-input${mono ? " mono" : ""}`}
        type={type || "text"}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
