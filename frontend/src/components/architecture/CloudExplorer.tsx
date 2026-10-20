"use client";

import Link from "next/link";
import {
  ArrowLeft, ArrowRight, Box, Boxes, Check, ChevronRight,
  Cloud, Code2, Database, ExternalLink, GitBranch, Layers3, Link2, List, Maximize2,
  Monitor, Network, Pause, Play, Radio, RotateCcw, Server, ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Wordmark } from "@/components/Navbar";
import DeploymentComparison from "./DeploymentComparison";
import { homeFor, useAuth } from "@/lib/auth";
import { initialSelection, readSelection, selectionPath, type ExplorerSelection } from "@/lib/architecture-state";
import {
  LAYERS, NODE_HEIGHT, NODE_WIDTH, SOURCE_ROOT,
  type ArchitectureLayer, type Component, type ComponentKind, type Connection, type LayerId,
} from "@/lib/architecture";

const ICONS = { client: Monitor, compute: Server, data: Database, queue: GitBranch, control: Network, storage: Box, observe: Radio };
const COLORS: Record<ComponentKind, string> = {
  client: "#B4BECF", compute: "#36BED7", data: "#A99BF4", queue: "#E6B35D",
  control: "#6D9EEB", storage: "#65C6A0", observe: "#D692B8",
};
const LAYER_ICONS = { services: Layers3, docker: Boxes, kubernetes: Network, aws: Cloud };
const KIND_LABELS: Record<ComponentKind, string> = {
  client: "Clients & entry", compute: "Compute", data: "State", queue: "Traffic & events",
  control: "Control", storage: "Storage", observe: "Observability",
};

function lines(text: string, max: number): string[] {
  return text.split(" ").reduce<string[]>((result, word) => {
    const last = result.length - 1;
    if (last >= 0 && result[last].length + word.length + 1 <= max) result[last] += ` ${word}`;
    else result.push(word);
    return result;
  }, []);
}

type Point = [number, number];
function center(node: Component): Point { return [node.x + NODE_WIDTH / 2, node.y + NODE_HEIGHT / 2]; }
function boundary(node: Component, toward: Point): Point {
  const [x, y] = center(node);
  const dx = toward[0] - x, dy = toward[1] - y;
  const scale = 1 / Math.max(Math.abs(dx) / (NODE_WIDTH / 2), Math.abs(dy) / (NODE_HEIGHT / 2));
  return [x + dx * scale, y + dy * scale];
}
function route(edge: Connection, nodes: Component[]) {
  const from = nodes.find((n) => n.id === edge.from)!;
  const to = nodes.find((n) => n.id === edge.to)!;
  const via = edge.via ?? [];
  const start = boundary(from, via[0] ?? center(to));
  const end = boundary(to, via[via.length - 1] ?? center(from));
  return { path: [start, ...via, end].map((p, i) => `${i ? "L" : "M"} ${p[0]} ${p[1]}`).join(" "), start, end };
}

function SystemDiagram({ layer, selected, active, tracing, playing, onSelect }: {
  layer: ArchitectureLayer; selected: string; active: string[]; tracing: boolean; playing: boolean; onSelect: (id: string) => void;
}) {
  const uid = useId().replaceAll(":", "");
  return (
    <div className="explorer-diagram-scroll" tabIndex={0} aria-label={`${layer.label} architecture diagram. Scroll horizontally on smaller screens.`}>
      <svg className="explorer-diagram" viewBox="0 0 1040 620" role="group" aria-label={`${layer.label} components and connections`}>
        <defs>
          <pattern id={`${uid}-grid`} width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r=".7" fill="#343D4A" opacity=".55" />
          </pattern>
          <marker id={`${uid}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8" fill="none" stroke="#6C7A8E" strokeWidth="1.4" />
          </marker>
          <marker id={`${uid}-active`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8" fill="none" stroke="#36BED7" strokeWidth="1.4" />
          </marker>
        </defs>
        <rect width="1040" height="620" fill={`url(#${uid}-grid)`} />
        {layer.groups.map((g) => (
          <g key={g.label}>
            <rect x={g.x} y={g.y} width={g.width} height={g.height} rx="5" fill="#1A202A" fillOpacity=".65" stroke="#333D4C" strokeDasharray="4 5" />
            <text x={g.x + 15} y={g.y + 23} className="explorer-group-label">{g.label}</text>
          </g>
        ))}
        {layer.connections.map((edge, i) => {
          const highlighted = tracing ? active.includes(edge.from) && active.includes(edge.to) : [edge.from, edge.to].includes(selected);
          const { path, start, end } = route(edge, layer.nodes);
          return (
            <g key={`${edge.from}-${edge.to}-${i}`} aria-hidden="true">
              <path d={path} fill="none" stroke={highlighted ? "#36BED7" : "#536176"} strokeWidth={highlighted ? 2 : 1.2}
                opacity={highlighted ? .9 : .42} strokeLinejoin="round" markerEnd={`url(#${uid}-${highlighted ? "active" : "arrow"})`}
                className={highlighted && playing ? "explorer-flow-line" : ""} />
              {edge.label && !edge.via && (
                <text x={(start[0] + end[0]) / 2} y={(start[1] + end[1]) / 2 - 9} textAnchor="middle" className="explorer-edge-label">{edge.label}</text>
              )}
            </g>
          );
        })}
        {layer.nodes.map((node) => {
          const isActive = tracing ? active.includes(node.id) : node.id === selected;
          const Icon = ICONS[node.kind], color = COLORS[node.kind];
          const titleLines = lines(node.label, 22), subtitleLines = lines(node.subtitle, 33);
          return (
            <g key={node.id} role="button" tabIndex={0} aria-label={`Inspect ${node.label}`} aria-pressed={!tracing && node.id === selected}
              onClick={() => onSelect(node.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(node.id); } }}
              className={`explorer-node ${isActive ? "is-active" : ""} ${tracing && !isActive ? "is-muted" : ""}`}
              style={{ "--node-color": color } as React.CSSProperties}>
              {isActive && <rect x={node.x - 4} y={node.y - 4} width={NODE_WIDTH + 8} height={NODE_HEIGHT + 8} rx="7" fill={color} fillOpacity=".06" stroke={color} strokeOpacity=".18" />}
              <rect className="explorer-node-bg" x={node.x} y={node.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx="4" />
              <rect x={node.x} y={node.y + 16} width="2" height="24" fill={color} />
              <Icon x={node.x + 13} y={node.y + 13} width="17" height="17" stroke={color} strokeWidth={1.5} />
              {titleLines.map((text, i) => <text key={i} x={node.x + 39} y={node.y + 24 + i * 14} className="explorer-node-title">{text}</text>)}
              {subtitleLines.map((text, i) => <text key={i} x={node.x + 14} y={node.y + 55 + i * 14} className="explorer-node-subtitle">{text}</text>)}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function CloudExplorer() {
  const { user } = useAuth();
  const [selection, setSelection] = useState<ExplorerSelection>(() => initialSelection());
  const { layer: layerId, node: selected, flow: walkId, step } = selection;
  const [playing, setPlaying] = useState(false);
  const [wide, setWide] = useState(false);
  const [view, setView] = useState<"diagram" | "list">("diagram");
  const [interval, setInterval] = useState(8000);
  const [shareStatus, setShareStatus] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const inspector = useRef<HTMLElement>(null);
  const layer = LAYERS.find((l) => l.id === layerId)!;
  const node = layer.nodes.find((n) => n.id === selected) ?? layer.nodes[0];
  const walkthrough = layer.walkthroughs.find((w) => w.id === walkId);
  const currentStep = walkthrough?.steps[step];
  const staff = user?.role === "admin" || user?.role === "dispatcher";
  const demo = user ? homeFor(user.role) : "/login";

  const navigate = useCallback((next: ExplorerSelection, push = false) => {
    setSelection(next);
    setShareStatus("");
    setShareUrl("");
    const path = selectionPath(next);
    if (`${window.location.pathname}${window.location.search}` !== path) {
      // Keep Next's history metadata, including the route tree, intact.
      window.history[push ? "pushState" : "replaceState"](window.history.state, "", path);
    }
  }, []);
  function changeLayer(id: LayerId) {
    navigate(initialSelection(id), true);
    setPlaying(false);
  }
  useEffect(() => {
    const restore = () => {
      setSelection(readSelection(new URLSearchParams(window.location.search)));
      setPlaying(false);
      setShareStatus("");
      setShareUrl("");
    };
    restore();
    if (window.matchMedia("(max-width: 620px)").matches) setView("list");
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setWide(false); setPlaying(false); }
    };
    const onVisibility = () => { if (document.hidden) setPlaying(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  useEffect(() => {
    if (!playing || !walkthrough) return;
    if (step >= walkthrough.steps.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => navigate({ ...selection, step: step + 1 }), interval);
    return () => clearTimeout(timer);
  }, [playing, step, walkthrough, selection, interval, navigate]);

  function selectWalk(id: string) { navigate({ ...selection, flow: id, step: 0 }, true); setPlaying(false); }
  function selectNode(id: string) {
    navigate({ ...selection, node: id, flow: null, step: 0 });
    setPlaying(false);
    if (window.matchMedia("(max-width: 1100px)").matches) {
      requestAnimationFrame(() => inspector.current?.scrollIntoView({ block: "nearest" }));
    }
  }
  function selectStep(index: number) { navigate({ ...selection, step: index }); setPlaying(false); }
  async function share() {
    setPlaying(false);
    const url = new URL(selectionPath(selection), window.location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      setShareUrl("");
      setShareStatus("View link copied. Opens at this component or step.");
    } catch {
      setShareUrl(url);
      setShareStatus("Copy the view link below.");
    }
  }
  const NodeIcon = ICONS[node.kind];

  return (
    <div className={`cloud-explorer min-h-screen ${wide ? "explorer-wide" : ""}`}>
      <header className="explorer-header">
        <Wordmark />
        <nav aria-label="Main navigation">
          <Link href="/" className="explorer-nav-link">Overview</Link>
          <span className="explorer-nav-link is-current" aria-current="page">Cloud explorer</span>
        </nav>
        <Link href={staff ? "/dispatch/cluster" : demo} className="explorer-console-link">
          <Radio size={13} /> {staff ? "Live cluster" : user ? "My console" : "Open demo"} <ArrowRight size={13} />
        </Link>
      </header>

      <main className="explorer-shell">
        <section className="explorer-intro">
          <div>
            <div className="explorer-eyebrow"><span /> DISPATCHX / CLOUD COMPUTING LAB</div>
            <h1>See the system behind every delivery.</h1>
            <p>Explore the services. Unpack the containers. Follow a request through the cloud.</p>
          </div>
          <div className="explorer-mode-note"><Code2 size={15} /><span>Source-backed architecture<br /><strong>No cloud connection required</strong></span></div>
        </section>

        <div className="explorer-layer-tabs" role="tablist" aria-label="Architecture layer">
          {LAYERS.map((l, index) => {
            const Icon = LAYER_ICONS[l.id];
            return <button key={l.id} id={`tab-${l.id}`} role="tab" aria-selected={layerId === l.id} aria-controls="architecture-panel" tabIndex={layerId === l.id ? 0 : -1}
              onKeyDown={(event) => {
                const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!direction && event.key !== "Home" && event.key !== "End") return;
                event.preventDefault();
                const next = event.key === "Home" ? 0 : event.key === "End" ? LAYERS.length - 1 : (index + direction + LAYERS.length) % LAYERS.length;
                changeLayer(LAYERS[next].id);
                document.getElementById(`tab-${LAYERS[next].id}`)?.focus();
              }}
              onClick={() => changeLayer(l.id)} className={layerId === l.id ? "is-selected" : ""}>
              <span className="explorer-tab-number">0{index + 1}</span><Icon size={17} strokeWidth={1.6} /><span>{l.label}</span>
              {layerId === l.id && <span className="explorer-tab-active" />}
            </button>;
          })}
          <div className="explorer-layer-hint">Same application. Different layers.</div>
        </div>

        <section id="architecture-panel" role="tabpanel" aria-labelledby={`tab-${layerId}`} className="explorer-workspace">
          <div className="explorer-workspace-heading">
            <div><div className="explorer-eyebrow">{layer.eyebrow}</div><h2>{layer.title}</h2><p>{layer.description}</p></div>
            <div className="explorer-heading-actions">
              <button className="explorer-presentation-button" onClick={share}><Link2 size={14} />Copy view link</button>
              <button className="explorer-presentation-button hidden lg:inline-flex" onClick={() => setWide(!wide)} aria-pressed={wide} aria-label={wide ? "Exit presentation view" : "Enter presentation view"}><Maximize2 size={14} />{wide ? "Exit · Esc" : "Presentation view"}</button>
            </div>
          </div>
          <div className="explorer-share-status" role="status">{shareStatus}</div>
          {shareUrl && <input className="explorer-share-url" aria-label="View link" value={shareUrl} readOnly onFocus={(event) => event.currentTarget.select()} />}
          <div className="explorer-toolbar">
            <span className="explorer-toolbar-label">EXPLORE</span>
            <button aria-pressed={!walkthrough} className={!walkthrough ? "is-selected" : ""} onClick={() => selectNode(selected)}><Box size={13} /> Components</button>
            <span className="explorer-toolbar-divider" />
            {layer.walkthroughs.map((w) => <button key={w.id} aria-pressed={walkId === w.id} className={walkId === w.id ? "is-selected" : ""} onClick={() => selectWalk(w.id)}><GitBranch size={13} />{w.title}</button>)}
          </div>
          <div className={`explorer-canvas-layout ${walkthrough ? "is-walkthrough" : ""}`}>
            <div className="explorer-canvas">
              <div className="explorer-canvas-meta">
                <span><span className="explorer-schematic-dot" /> SCHEMATIC · NOT LIVE TELEMETRY</span>
                <div className="explorer-view-switch" aria-label="Component display">
                  <button aria-label="Diagram view" aria-pressed={view === "diagram"} onClick={() => setView("diagram")}><Network size={12} />Diagram</button>
                  <button aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={12} />List</button>
                </div>
              </div>
              {view === "diagram" ? (
                <SystemDiagram layer={layer} selected={selected} active={currentStep?.nodes ?? []} tracing={!!walkthrough} playing={playing} onSelect={selectNode} />
              ) : (
                <div className="explorer-component-list" aria-label={`${layer.label} components`}>
                  {layer.nodes.map((item) => {
                    const Icon = ICONS[item.kind];
                    const active = currentStep ? currentStep.nodes.includes(item.id) : item.id === selected;
                    return <button key={item.id} aria-label={`Inspect ${item.label}`} aria-pressed={!walkthrough && item.id === selected}
                      className={active ? "is-active" : ""} onClick={() => selectNode(item.id)}>
                      <Icon size={17} color={COLORS[item.kind]} /><span><strong>{item.label}</strong><small>{item.subtitle}</small>{currentStep && active && <small className="explorer-in-step">In this step</small>}</span><ChevronRight size={13} />
                    </button>;
                  })}
                </div>
              )}
              <div className="explorer-legend">
                {(Object.keys(KIND_LABELS) as ComponentKind[]).filter((kind) => layer.nodes.some((item) => item.kind === kind)).map((kind) => <span key={kind}><i style={{ background: COLORS[kind] }} />{KIND_LABELS[kind]}</span>)}
              </div>
            </div>
            <aside ref={inspector} className="explorer-inspector" aria-label="Architecture details">
              {walkthrough && currentStep ? (
                <>
                  <div className="explorer-inspector-topline"><span className="explorer-eyebrow">GUIDED WALKTHROUGH</span><span className="explorer-step-count">{String(step + 1).padStart(2, "0")} / {String(walkthrough.steps.length).padStart(2, "0")}</span></div>
                  <h3>{walkthrough.title}</h3>
                  <div className="explorer-step-progress" aria-label={`Step ${step + 1} of ${walkthrough.steps.length}`}>
                    {walkthrough.steps.map((s, i) => <button key={i} aria-label={`Step ${i + 1}: ${s.title}`} aria-current={step === i ? "step" : undefined}
                      className={i <= step ? "is-reached" : ""} onClick={() => selectStep(i)} />)}
                  </div>
                  <div className="explorer-current-step" aria-live="polite">
                    <span className="explorer-step-number">{step + 1}</span>
                    <h4>{currentStep.title}</h4><p>{currentStep.body}</p>
                  </div>
                  <div className="explorer-playback">
                    <button className="explorer-icon-button" aria-label="Previous step" disabled={step === 0} onClick={() => selectStep(step - 1)}><ArrowLeft size={16} /></button>
                    <button className="explorer-play-button" onClick={() => {
                      if (step === walkthrough.steps.length - 1) { navigate({ ...selection, step: 0 }); setPlaying(true); } else setPlaying(!playing);
                    }}>{playing ? <Pause size={14} /> : step === walkthrough.steps.length - 1 ? <RotateCcw size={14} /> : <Play size={14} />}{playing ? "Pause" : step === walkthrough.steps.length - 1 ? "Replay" : "Play walkthrough"}</button>
                    <button className="explorer-icon-button" aria-label="Next step" disabled={step === walkthrough.steps.length - 1} onClick={() => selectStep(step + 1)}><ArrowRight size={16} /></button>
                  </div>
                  <label className="explorer-pace">Step interval<select value={interval} onChange={(event) => setInterval(Number(event.target.value))}><option value={5000}>5 seconds</option><option value={8000}>8 seconds</option><option value={12000}>12 seconds</option></select></label>
                  <ol className="explorer-step-list">
                    {walkthrough.steps.map((s, i) => <li key={s.title}><button onClick={() => selectStep(i)} aria-current={step === i ? "step" : undefined} className={i === step ? "is-current" : ""}>
                      <span>{i < step ? <Check size={12} /> : String(i + 1).padStart(2, "0")}</span>{s.title}
                    </button></li>)}
                  </ol>
                  <p className="explorer-inspector-footnote">Illustrates the implemented flow. Playback does not send traffic or change cloud resources.</p>
                </>
              ) : (
                <>
                  <div className="explorer-inspector-topline"><span className="explorer-eyebrow">COMPONENT INSPECTOR</span><NodeIcon size={19} color={COLORS[node.kind]} strokeWidth={1.5} /></div>
                  <label className="explorer-component-picker">Inspect component<select aria-label="Inspect component" value={selected} onChange={(event) => selectNode(event.target.value)}>{layer.nodes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                  <h3>{node.label}</h3><div className="explorer-component-subtitle">{node.subtitle}</div>
                  <p className="explorer-component-purpose">{node.purpose}</p>
                  <dl className="explorer-component-facts">
                    {node.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
                  </dl>
                  <a className="explorer-source-link" href={`${SOURCE_ROOT}${node.source}`} target="_blank" rel="noreferrer"><Code2 size={14} /><span>{node.source}</span><ExternalLink size={12} /></a>
                  <button className="explorer-inspector-walk" onClick={() => selectWalk(layer.walkthroughs[0].id)}>Follow the flow <ArrowRight size={14} /></button>
                </>
              )}
            </aside>
          </div>
        </section>

        <section className="explorer-understanding">
          <div className="explorer-takeaway"><div className="explorer-section-icon"><Layers3 size={19} /></div><div><div className="explorer-eyebrow">WHAT THIS LAYER DOES</div><p>{layer.takeaway}</p></div></div>
          <div className="explorer-boundary"><ShieldCheck size={18} /><div><div className="explorer-eyebrow">THE CURRENT BOUNDARY</div><p>{layer.caveat}</p></div></div>
        </section>

        <DeploymentComparison />

        <section className="explorer-next">
          <div><div className="explorer-eyebrow">FROM ARCHITECTURE TO EVIDENCE</div><h2>Watch the actual system work.</h2><p>The operations map shows deliveries. Cluster View reads the running ECS or Kubernetes platform.</p></div>
          <div className="explorer-next-links">
            <Link href={staff ? "/dispatch" : "/login"}><Radio size={16} /><span>Operations console<small>{staff ? "Fleet, orders, offers and alerts" : "Sign in with the dispatcher demo"}</small></span><ChevronRight size={16} /></Link>
            <Link href={staff ? "/dispatch/cluster" : "/login"}><Server size={16} /><span>Live cluster<small>{staff ? "Tasks, pods, capacity and scheduler events" : "Requires dispatcher access and a running platform"}</small></span><ChevronRight size={16} /></Link>
          </div>
        </section>
        <footer className="explorer-footer"><span>DISPATCHX <span className="mx-2 text-k-line">/</span> CLOUD COMPUTING PROJECT</span><a href="https://github.com/anannyay/DispatchX" target="_blank" rel="noreferrer">Explore the repository <ExternalLink size={12} /></a></footer>
      </main>
    </div>
  );
}
