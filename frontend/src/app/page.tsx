"use client";

import Link from "next/link";
import { Activity, ArrowRight, Boxes, Radio, Route } from "lucide-react";
import { Wordmark } from "@/components/Navbar";
import { homeFor, useAuth } from "@/lib/auth";

const CAPABILITIES = [
  { icon: Route, title: "Geo-dispatch", body: "Redis GEOSEARCH matches the nearest available rider. Offers time out and cascade automatically." },
  { icon: Radio, title: "Live tracking", body: "Socket.IO over a Redis adapter streams rider GPS to customers and dispatchers across every API instance." },
  { icon: Activity, title: "Operations map", body: "kepler.gl renders the fleet, active trips and demand density in real time for the dispatch desk." },
  { icon: Boxes, title: "Cloud-native", body: "Containers on ECS behind CloudFront and an ALB, with RDS, ElastiCache and SNS/SQS. Also runs on Kubernetes." },
];

const STACK = ["Next.js", "FastAPI", "Socket.IO", "MySQL", "Redis", "Celery", "SNS · SQS", "ECS on EC2", "CloudFront", "kepler.gl"];

export default function Home() {
  const { user } = useAuth();
  return (
    <div className="min-h-screen bg-k-canvas">
      <header className="flex h-14 items-center justify-between border-b border-k-line px-6">
        <Wordmark />
        <nav className="flex items-center gap-2">
          {user ? (
            <Link href={homeFor(user.role)} className="inline-flex h-8 items-center gap-1.5 rounded bg-k-go px-3 text-sm font-semibold text-white hover:bg-k-gohover">
              Open console <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <>
              <Link href="/login" className="h-8 rounded px-3 text-sm font-medium leading-8 text-k-text hover:text-k-hi">Sign in</Link>
              <Link href="/register" className="h-8 rounded bg-k-go px-3 text-sm font-semibold leading-8 text-white hover:bg-k-gohover">Create account</Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="grid gap-12 border-b border-k-line py-20 lg:grid-cols-[1.3fr_1fr]">
          <div>
            <div className="k-label">Real-time delivery &amp; dispatch</div>
            <h1 className="mt-4 text-[44px] font-semibold leading-[1.08] tracking-[-0.02em] text-k-hi">
              Same-city delivery,<br />dispatched in seconds.
            </h1>
            <p className="mt-5 max-w-xl text-[15px] leading-7 text-k-text">
              DispatchX connects customers, riders and a dispatch desk on one live system: geo-matching,
              GPS tracking and an operations map, deployed on AWS.
            </p>
            <div className="mt-8 flex gap-3">
              <Link href="/register" className="inline-flex h-10 items-center gap-2 rounded bg-k-go px-4 text-sm font-semibold text-white hover:bg-k-gohover">
                Send a parcel <ArrowRight className="h-4 w-4" />
              </Link>
              <Link href="/register?role=rider" className="inline-flex h-10 items-center rounded bg-k-panel px-4 text-sm font-semibold text-k-hi hover:bg-k-hover">
                Ride with DispatchX
              </Link>
            </div>
          </div>
          <div className="k-panel self-start">
            <div className="border-b border-k-line px-4 py-2.5 k-label">Demo access</div>
            <dl className="divide-y divide-k-line/60 px-4 font-mono text-sm">
              {[["Customer", "customer@dispatchx.dev"], ["Rider", "rider@dispatchx.dev"], ["Dispatcher", "dispatch@dispatchx.dev"], ["Password", "dispatchx123"]].map(([k, v]) => (
                <div key={k} className="flex justify-between py-2.5">
                  <dt className="font-sans text-xs text-k-label">{k}</dt>
                  <dd className="text-k-hi">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="border-t border-k-line px-4 py-3">
              <Link href="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-k-accent hover:underline">
                One-click demo sign in <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </section>

        <section className="grid gap-px border-b border-k-line bg-k-line sm:grid-cols-2 lg:grid-cols-4">
          {CAPABILITIES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-k-canvas p-6">
              <Icon className="h-5 w-5 text-k-accent" strokeWidth={1.5} />
              <div className="mt-4 text-sm font-semibold text-k-hi">{title}</div>
              <div className="mt-1.5 text-sm leading-6 text-k-text">{body}</div>
            </div>
          ))}
        </section>

        <section className="flex flex-wrap items-center gap-x-6 gap-y-2 py-8">
          <span className="k-label">Built with</span>
          {STACK.map((s) => <span key={s} className="font-mono text-xs text-k-text">{s}</span>)}
        </section>
      </main>
    </div>
  );
}
