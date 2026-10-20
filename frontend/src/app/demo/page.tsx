"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Clipboard, RotateCcw, Terminal } from "lucide-react";
import { Wordmark } from "@/components/Navbar";
import { Button, Input, Panel } from "@/components/ui";
import {
  DEMO_FIELDS, DEMO_PRESETS, DEMO_WALKTHROUGH, demoTime, generateDemoCommands, presetDraft,
  type DemoDraft, type PresetId,
} from "@/lib/demo-config";
import "./demo.css";

function CommandBox({ id, title, command, hint, copyLabel }: {
  id: string; title: string; command: string | null; hint: string; copyLabel: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const currentCommand = useRef(command);
  currentCommand.current = command;
  const [status, setStatus] = useState("");
  useEffect(() => setStatus(""), [command]);

  async function copy() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      if (currentCommand.current === command) setStatus("Copied. Paste into your terminal when ready.");
    } catch {
      // Keep the field mounted and accessible when clipboard permissions fail.
      if (currentCommand.current !== command) return;
      input.current?.focus();
      input.current?.select();
      setStatus("Clipboard unavailable. Command selected: press Ctrl+C or ⌘C, or use your device’s Copy action.");
    }
  }

  return (
    <section className="demo-command" aria-labelledby={`${id}-label`}>
      <div className="demo-command-heading">
        <label id={`${id}-label`} htmlFor={id} className="font-semibold text-k-hi">{title}</label>
        <Button type="button" variant="secondary" className="demo-control" disabled={!command}
          aria-describedby={!command ? "demo-validation" : `${id}-status`} onClick={copy}>
          <Clipboard size={14} aria-hidden="true" />{copyLabel}
        </Button>
      </div>
      <p id={`${id}-hint`} className="mb-3 text-xs text-k-text">{hint}</p>
      <textarea id={id} ref={input} readOnly spellCheck={false} rows={5} wrap="soft"
        className="k-input demo-command-text font-mono text-xs" aria-describedby={`${id}-hint ${id}-status`}
        value={command ?? "Fix the configuration errors above to generate a command."} />
      <p id={`${id}-status`} role="status" aria-live="polite" className="demo-copy-status text-xs text-k-accent">
        {status || "Read-only command. You can also select and copy it manually."}
      </p>
    </section>
  );
}

export default function DemoPage() {
  const [preset, setPreset] = useState<PresetId>("explain");
  const [draft, setDraft] = useState<DemoDraft>(() => presetDraft("explain"));
  const selected = DEMO_PRESETS.find((item) => item.id === preset)!;
  const result = generateDemoCommands(draft);
  const customized = DEMO_FIELDS.some((field) => draft[field.key] !== String(selected.values[field.key]));
  const errorCount = Object.keys(result.errors).length;

  function choosePreset(id: PresetId) {
    setPreset(id);
    setDraft((previous) => presetDraft(id, previous.baseUrl));
  }

  return (
    <div className="demo-page min-h-screen">
      <header className="demo-topbar">
        <div className="demo-topbar-inner">
          <Wordmark />
          <nav aria-label="Demo navigation" className="demo-navigation">
            <Link href="/architecture" className="demo-link-button">Architecture</Link>
            <Link href="/login" className="demo-link-button">Role login</Link>
          </nav>
        </div>
      </header>
      <main className="demo-main">
        <header className="space-y-3">
          <p className="k-label">Presentation desk · public · 8 minutes</p>
          <h1 className="text-2xl font-semibold tracking-tight text-k-hi">Explain the system. Show the evidence.</h1>
          <p className="max-w-3xl text-sm">Trace one real delivery, explain its container and cloud responsibilities, then inspect application signals. Prepare finite simulator commands here for optional load after the role flow.</p>
          <nav aria-label="On this page" className="demo-jump-links">
            <a href="#configuration">Configure commands</a><a href="#scope">Environment scope</a>
            <a href="#walkthrough">8-minute walkthrough</a><a href="#evidence">Evidence & limitations</a>
          </nav>
        </header>

        <Panel className="demo-section">
          <div id="configuration" className="demo-section-heading">
            <div><p className="k-label mb-1">01 / Preparation</p><h2 className="text-lg font-semibold text-k-hi">Simulator command generator</h2></div>
            <Terminal size={20} className="text-k-accent" aria-hidden="true" />
          </div>
          <div className="demo-section-body space-y-5">
            <div className="demo-notice">
              <p className="font-semibold text-k-hi">Settings affect the generated simulator command, not a running process.</p>
              <p className="mt-1">This page makes no load-generation requests and starts no cloud resources. Copying only copies text. You decide whether to run it in a terminal; editing here cannot stop or reconfigure a process already running.</p>
            </div>

            <div className="demo-preset-row">
              <label className="min-w-0 flex-1" htmlFor="demo-preset">
                <span className="k-label mb-2 block">Preset</span>
                <select id="demo-preset" className="k-input" value={preset} onChange={(event) => choosePreset(event.target.value as PresetId)}>
                  {DEMO_PRESETS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
                </select>
              </label>
              <Button type="button" variant="secondary" className="demo-control" onClick={() => choosePreset(preset)}>
                <RotateCcw size={14} aria-hidden="true" />Reset preset
              </Button>
            </div>
            <div className="text-sm">
              <p className="text-k-hi">{selected.description}</p>
              <p className="mt-1 text-xs" role="status">{customized ? "Custom numeric settings." : `${selected.label} defaults.`} Selecting or resetting a preset restores its numeric values and keeps your base URL.</p>
            </div>

            <div>
              <label htmlFor="demo-base-url" className="k-label mb-2 block">Simulator base URL</label>
              <Input id="demo-base-url" type="url" autoComplete="off" spellCheck={false} value={draft.baseUrl}
                aria-invalid={!!result.errors.baseUrl} aria-describedby="demo-base-hint demo-base-error"
                onChange={(event) => setDraft((previous) => ({ ...previous, baseUrl: event.target.value }))} />
              <p id="demo-base-hint" className="mt-2 text-xs">Default: http://localhost:8000. Use the application/API root, usually without /api. HTTP(S) only; no credentials, query or fragment. This target does not change where role-login links go or where Compose seeds accounts. URL paths are normalized and encoded in the generated command.</p>
              <p id="demo-base-error" className="demo-field-error">{result.errors.baseUrl}</p>
            </div>

            <div className="demo-field-grid">
              {DEMO_FIELDS.map((field) => (
                <div key={field.key} className="min-w-0">
                  <label htmlFor={`demo-${field.key}`} className="k-label mb-2 block">{field.label} · {field.min}–{field.max}</label>
                  <Input id={`demo-${field.key}`} type="number" min={field.min} max={field.max} step={field.integer ? 1 : "any"}
                    value={draft[field.key]} aria-invalid={!!result.errors[field.key]} aria-describedby={`demo-${field.key}-hint demo-${field.key}-error`}
                    onChange={(event) => setDraft((previous) => ({ ...previous, [field.key]: event.target.value }))} />
                  <p id={`demo-${field.key}-hint`} className="mt-2 text-xs">{field.hint}</p>
                  <p id={`demo-${field.key}-error`} className="demo-field-error">{result.errors[field.key]}</p>
                </div>
              ))}
            </div>
            <p id="demo-validation" role="status" aria-live="polite" className={errorCount ? "text-sm text-k-warn" : "text-sm text-k-accent"}>
              {errorCount ? `${errorCount} invalid ${errorCount === 1 ? "field" : "fields"}. Fix the errors above; all command copy buttons are disabled.` : "Valid settings. Commands are ready to copy; nothing has been executed."}
            </p>

            <div className="demo-notice">
              <h3 className="font-semibold text-k-hi">Manual delivery first; optional load afterward</h3>
              <p className="mt-1">Before the three-role flow, stop every simulator in its own terminal with Ctrl+C (or stop its known simulator container). Wait for exit and check that the demo rider is idle and competing simulated riders are offline. Orders/min = 0 still connects riders and can accept existing offers; it is not a stop button.</p>
              <p className="mt-2">For a later run, use the repository root and an existing Python environment with simulator/requirements.txt installed. Seed the selected counts first. Defaults retained from the simulator: Bengaluru (bangalore), rider index 1, GPS tick 2 s, login ramp 0.05 s. The chosen duration ends the run; Ctrl+C stops it early. Neither method clears saved orders or queued work.</p>
            </div>

            <div className="demo-command-grid">
              <CommandBox id="demo-powershell" title="PowerShell simulator command" command={result.commands?.powershell ?? null}
                copyLabel="Copy PowerShell" hint="One line. Run manually from the repository root after the role flow." />
              <CommandBox id="demo-posix" title="POSIX simulator command" command={result.commands?.posix ?? null}
                copyLabel="Copy POSIX" hint="For sh, bash or zsh. One line, from the repository root after the role flow." />
            </div>
            <CommandBox id="demo-seed" title="Seed accounts · local Compose only" command={result.commands?.seed ?? null}
              copyLabel="Copy seed command" hint="PowerShell or POSIX. Run against your already-running local Compose project. Creates missing demo/simulator accounts for the selected counts; does not remove extra accounts or reset orders. Base URL is not used." />
            <p className="text-sm">For <strong className="text-k-hi">kind</strong>, use the established seed Job in <code>k8s/seed-job.yaml</code> via the workflow in <code>k8s/README.md</code>. For <strong className="text-k-hi">existing AWS</strong>, use the established ECS seed-task workflow in <code>.github/workflows/deploy.yml</code>. Ensure that target has at least the selected rider/customer accounts. The Compose command does not seed either environment remotely.</p>
          </div>
        </Panel>

        <section id="scope" aria-labelledby="demo-scope-heading">
          <p className="k-label mb-1">02 / Scope · reference guidance, not environment detection</p>
          <h2 id="demo-scope-heading" className="mb-4 text-lg font-semibold text-k-hi">Choose what you can actually show</h2>
          <div className="demo-scope-grid">
            <Panel className="p-4">
              <h3 className="font-semibold text-k-hi">Local Compose</h3>
              <p className="mt-2 text-sm">App usually :3000, simulator API :8000. MySQL/Redis, API, worker, Beat and web run on one Docker host. Inspect containers in the terminal with <code>docker compose ps</code> and <code>docker compose images</code>.</p>
              <p className="mt-3 text-sm"><strong className="text-k-hi">Live cluster is unavailable by design.</strong> The cluster API reads ECS/Kubernetes, not local Docker. System signals can still show application measurements when the backend is running.</p>
            </Panel>
            <Panel className="p-4">
              <h3 className="font-semibold text-k-hi">Configured kind · local / CI</h3>
              <p className="mt-2 text-sm">Manifests describe pods, Services, probes, storage and CPU HPA. The configured cluster has fixed nodes; HPA changes pod replicas, not node count. The usual existing ingress is http://localhost:8080.</p>
              <p className="mt-3 text-sm">Show live pods only if that kind cluster is already running and the app is connected to it. Otherwise label the Kubernetes layer as configuration. Use its seed Job workflow.</p>
            </Panel>
            <Panel className="p-4">
              <h3 className="font-semibold text-k-hi">Existing AWS · ECS on EC2</h3>
              <p className="mt-2 text-sm">Use the existing stack’s actual application URL and ECS seed workflow. CloudFront/ALB route to ECS; RDS, Valkey and SNS/SQS supply managed state and event delivery. This repository does not deploy EKS.</p>
              <p className="mt-3 text-sm">A source diagram is not cloud-health evidence. Inspect a fresh authenticated ECS snapshot only when available. This page does not discover, deploy or start AWS resources.</p>
            </Panel>
          </div>
        </section>

        <section id="walkthrough" aria-labelledby="demo-walkthrough-heading">
          <p className="k-label mb-1">03 / Exact presentation sequence</p>
          <h2 id="demo-walkthrough-heading" className="text-lg font-semibold text-k-hi">Eight minutes · click, say, observe</h2>
          <p className="mt-2 mb-4 text-sm">Before the clock: have the chosen environment running and seeded, three isolated browser profiles ready, an idle rider, nearby pickup/drop locations and a terminal open. These are presentation timeboxes, not promised backend completion times. Keep this page in a separate presentation tab; role sessions need independent profiles, not just tabs or private windows sharing one session.</p>
          <ol className="space-y-4">
            {DEMO_WALKTHROUGH.map((step, index) => (
              <li key={step.id}>
                <Panel className="demo-step">
                  <div className="demo-step-heading">
                    <div><p className="font-mono text-xs text-k-accent">{demoTime(step.start)}–{demoTime(step.end)}</p>
                      <h3 className="mt-1 font-semibold text-k-hi">{index + 1}. {step.title}</h3></div>
                    <Link href={step.href} className="demo-link-button">{step.link}<ArrowRight size={14} aria-hidden="true" /></Link>
                  </div>
                  <dl className="demo-step-instructions">
                    <div><dt>Click / do</dt><dd>{step.click}</dd></div>
                    <div><dt>Say</dt><dd>{step.say}</dd></div>
                    <div><dt>Observe</dt><dd>{step.observe}</dd></div>
                  </dl>
                </Panel>
              </li>
            ))}
          </ol>
          <Panel className="mt-4 p-4">
            <h3 className="font-semibold text-k-hi">Read-only terminal evidence · existing kind only</h3>
            <p className="my-2 text-sm">Use the explicit context so the presentation does not silently inspect another cluster. If it is absent, show the configured manifests instead.</p>
            <pre className="demo-terminal font-mono text-xs">{"kubectl --context kind-dispatchx get nodes\nkubectl --context kind-dispatchx -n dispatchx get pods -o wide\nkubectl --context kind-dispatchx -n dispatchx get hpa"}</pre>
          </Panel>
        </section>

        <Panel className="demo-section">
          <div id="evidence" className="demo-section-heading"><div><p className="k-label mb-1">04 / Close with evidence</p><h2 className="text-lg font-semibold text-k-hi">What the presentation establishes</h2></div></div>
          <div className="demo-section-body text-sm space-y-4">
            <p><strong className="text-k-hi">Observed:</strong> record your environment, time, order ID and saved state after reload; container roles from terminal output; fresh System samples and, if available, actual ECS tasks or kind pods. An error or unavailable view stays an error or unavailable view.</p>
            <p><strong className="text-k-hi">Source-configured:</strong> architecture playback, HPA targets, ECS scaling policies, retries/DLQs and optional managed-state redundancy. Source inspection does not prove they ran successfully. No capacity, failover or exactly-once guarantee follows from a preset.</p>
            <p><strong className="text-k-hi">Limits:</strong> simulated straight-line movement, single-host Compose, no configured persistent Redis volume in local/kind, unshared kind API photo disk, and no transactional outbox. RDS Multi-AZ and cache replicas are optional, not defaults.</p>
            <div className="flex flex-wrap gap-2">
              <Link href="/architecture" className="demo-link-button">Architecture</Link>
              <Link href="/login" className="demo-link-button">Role login</Link>
              <Link href="/dispatch/system" className="demo-link-button">System signals · staff</Link>
              <Link href="/dispatch/cluster" className="demo-link-button">Live cluster · staff</Link>
            </div>
            <p className="text-xs">These links use this app’s current origin; changing the simulator base URL does not retarget them. The matching presenter notes live in <code>docs/DEMO-RUNBOOK.md</code>.</p>
          </div>
        </Panel>
      </main>
    </div>
  );
}
