"use client";

import Link from "next/link";
import { ArrowRight, Boxes, Cloud, Database, GitBranch, Layers3, Network, Radio, Server, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/Navbar";
import { homeFor, useAuth } from "@/lib/auth";
import "./home.css";

const LAYERS = [
  { id: "services", n: "01", icon: Layers3, title: "Services", description: "Who handles each part of a delivery?" },
  { id: "docker", n: "02", icon: Boxes, title: "Docker", description: "How does code become a running container?" },
  { id: "kubernetes", n: "03", icon: Network, title: "Kubernetes", description: "How do pods scale and recover?" },
  { id: "aws", n: "04", icon: Cloud, title: "AWS", description: "What does each cloud service actually do?" },
];

export default function Home() {
  const { user } = useAuth();
  const demo = user ? homeFor(user.role) : "/login";
  return (
    <div className="dx-home">
      <header className="dx-home-header">
        <Wordmark />
        <nav aria-label="Main navigation">
          <Link href="/architecture">Cloud explorer</Link>
          <a href="https://github.com/anannyay/DispatchX" target="_blank" rel="noreferrer" className="dx-source-nav">Source code</a>
          <Link href={demo} className="dx-nav-demo">{user ? "Open console" : "Open demo"} <ArrowRight size={14} /></Link>
        </nav>
      </header>
      <main className="dx-home-shell">
        <section className="dx-hero">
          <div className="dx-hero-copy">
            <div className="dx-eyebrow"><span /> A CLOUD COMPUTING PROJECT</div>
            <h1>Dispatch a parcel.<br /><span>See the cloud at work.</span></h1>
            <p>A real-time delivery platform with an inside view of the system that powers it. Follow a request through services, containers, queues, and the cloud.</p>
            <div className="dx-hero-actions">
              <Link href="/architecture" className="dx-primary-link">Explore the architecture <ArrowRight size={16} /></Link>
              <Link href={demo} className="dx-secondary-link">Try the delivery app <ArrowRight size={14} /></Link>
            </div>
            <div className="dx-hero-caption"><span /> AWS deployment: ECS on EC2. Local orchestration: Kubernetes.</div>
          </div>
          <Link href="/architecture?layer=aws" className="dx-blueprint" aria-label="Explore the AWS deployment architecture">
            <div className="dx-blueprint-heading"><span>DEPLOYMENT BLUEPRINT</span><span>AWS / SYDNEY</span></div>
            <div className="dx-blueprint-flow">
              <div className="dx-blueprint-node"><Cloud size={20} /><div><strong>CloudFront + ALB</strong><span>Receive and route requests</span></div><span className="dx-blueprint-index">01</span></div>
              <div className="dx-blueprint-wire"><span>HTTP · REST · WEBSOCKETS</span></div>
              <div className="dx-blueprint-node dx-blueprint-compute"><Server size={20} /><div><strong>ECS services on EC2</strong><span>Web, API, workers, scheduler, consumer</span></div><span className="dx-blueprint-index">02</span></div>
              <div className="dx-blueprint-wire"><span>STATE · EVENTS · OBJECTS</span></div>
              <div className="dx-blueprint-bottom">
                <div><Database size={17} /><strong>RDS + cache</strong><span>Store & coordinate</span></div>
                <div><GitBranch size={17} /><strong>SNS + SQS</strong><span>Deliver events</span></div>
                <div><Boxes size={17} /><strong>S3</strong><span>Keep the evidence</span></div>
              </div>
            </div>
            <div className="dx-blueprint-footer"><span>Open the interactive system map</span><ArrowRight size={15} /></div>
          </Link>
        </section>
        <section className="dx-layer-section" aria-labelledby="layers-title">
          <div className="dx-section-heading"><div><div className="dx-eyebrow">UNDERSTAND IT, ONE LAYER AT A TIME</div><h2 id="layers-title">A clear path through the stack.</h2></div><p>Click a layer. Inspect a component.<br />Play a walkthrough of what happens next.</p></div>
          <div className="dx-layer-grid">
            {LAYERS.map(({ id, n, icon: Icon, title, description }) => <Link key={id} href={`/architecture?layer=${id}`} className="dx-layer-card">
              <div className="dx-layer-top"><span>{n}</span><Icon size={23} strokeWidth={1.4} /></div>
              <h3>{title}</h3><p>{description}</p><div className="dx-layer-open">Explore layer <ArrowRight size={14} /></div>
            </Link>)}
          </div>
        </section>
        <section className="dx-demo-section">
          <div className="dx-demo-copy"><div className="dx-eyebrow">THE APPLICATION IN MOTION</div><h2>Book. Match. Track. Deliver.</h2><p>A customer places an order. A nearby rider gets a timed offer. The dispatcher sees the fleet and can step in when a delivery needs attention.</p><Link href={demo}>Open the role-based demo <ArrowRight size={15} /></Link></div>
          <div className="dx-proof-grid">
            <div><GitBranch size={18} /><h3>Events drive the work</h3><p>Queues connect dispatch, notifications, and analytics.</p></div>
            <div><Radio size={18} /><h3>Updates arrive live</h3><p>Socket.IO and shared Redis state connect every replica.</p></div>
            <div><ShieldCheck size={18} /><h3>Recovery is visible</h3><p>Explore retries, health checks, and replacement tasks.</p></div>
            <div><Server size={18} /><h3>Infrastructure has a view</h3><p>Inspect actual tasks, pods, capacity, and scheduler events.</p></div>
          </div>
        </section>
        <footer className="dx-home-footer"><span>DISPATCHX / BUILT TO RUN. BUILT TO EXPLAIN.</span><div><Link href="/register">Create an account</Link><Link href="/architecture">Cloud explorer <ArrowRight size={12} /></Link></div></footer>
      </main>
    </div>
  );
}
