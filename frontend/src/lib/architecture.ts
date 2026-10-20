export type LayerId = "services" | "docker" | "kubernetes" | "aws";
export type ComponentKind = "client" | "compute" | "data" | "queue" | "control" | "storage" | "observe";

export interface Component {
  id: string;
  label: string;
  subtitle: string;
  kind: ComponentKind;
  x: number;
  y: number;
  purpose: string;
  facts: { label: string; value: string }[];
  source: string;
}
export interface Connection { from: string; to: string; label?: string; via?: [number, number][] }
export interface WalkStep { title: string; body: string; nodes: string[] }
export interface Walkthrough { id: string; title: string; steps: WalkStep[] }
export interface ArchitectureLayer {
  id: LayerId;
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  takeaway: string;
  caveat: string;
  groups: { label: string; x: number; y: number; width: number; height: number }[];
  nodes: Component[];
  connections: Connection[];
  walkthroughs: Walkthrough[];
}

export const SOURCE_ROOT = "https://github.com/anannyay/DispatchX/blob/main/";
export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 82;

// Source-backed schematics: arrows show selected requests, dependencies, or control
// relationships, not live traffic, health, or an exhaustive network topology.
export const LAYERS: ArchitectureLayer[] = [
  {
    id: "services", label: "Services", eyebrow: "01 / APPLICATION",
    title: "One delivery. Several responsibilities.",
    description: "Follow the work from the browser to the API, dispatch workers, and shared state.",
    takeaway: "One backend image runs separate API, Celery worker, Beat scheduler, and AWS SQS consumer processes. API, worker, and consumer capacity can scale separately; Beat is configured as a single scheduler.",
    caveat: "These roles share domain logic and a database, rather than owning independent microservices. This schematic shows selected relationships, not live health or guaranteed failure recovery.",
    groups: [
      { label: "EXPERIENCE", x: 16, y: 24, width: 214, height: 552 },
      { label: "APPLICATION PROCESSES", x: 254, y: 24, width: 454, height: 552 },
      { label: "SHARED STATE", x: 732, y: 24, width: 292, height: 552 },
    ],
    nodes: [
      { id: "browser", label: "Customer · rider · dispatch", subtitle: "Three browser experiences", kind: "client", x: 31, y: 234,
        purpose: "Customers book and track parcels, riders handle deliveries, and dispatchers monitor the fleet.",
        facts: [{ label: "Requests", value: "REST over HTTP(S); Socket.IO over WebSocket (WS/WSS) for updates and GPS." }, { label: "Access", value: "JWT authentication and role checks on protected endpoints." }, { label: "Maps", value: "Leaflet for delivery views; kepler.gl for fleet operations." }], source: "frontend/src/app/customer/page.tsx" },
      { id: "web", label: "Web", subtitle: "Next.js · React", kind: "compute", x: 274, y: 80,
        purpose: "Serves the interface and assets. Browser clients then talk directly to the API through the configured origin.",
        facts: [{ label: "Image", value: "A separate frontend image, built with Next.js standalone output." }, { label: "Three roles", value: "Customer, rider, and dispatcher pages use the same frontend." }, { label: "Live state", value: "Socket events update orders and rider locations in the UI." }], source: "frontend/Dockerfile" },
      { id: "api", label: "API + real time", subtitle: "FastAPI · Socket.IO", kind: "compute", x: 274, y: 234,
        purpose: "Validates actions, writes orders and audit events, and maintains authenticated WebSocket connections.",
        facts: [{ label: "Durable state", value: "Orders and status history are stored in MySQL in the supplied deployments." }, { label: "GPS + replicas", value: "The API writes GPS to Redis GEO/hash state; Socket.IO pub/sub relays updates across API instances." }, { label: "Health", value: "/api/health checks the process; /api/ready checks database and Redis." }], source: "backend/app/realtime.py" },
      { id: "worker", label: "Background handlers", subtitle: "Celery · SQS consumer on AWS", kind: "compute", x: 504, y: 80,
        purpose: "Runs shared dispatch and notification handlers: in a Celery worker locally, or a separate SQS consumer on AWS. Celery workers execute timed jobs in both modes.",
        facts: [{ label: "Matching", value: "Redis GEOSEARCH, fresh GPS, availability, distance, and rating." }, { label: "Shared database", value: "Dispatch reads orders and writes attempts and audit events in MySQL." }, { label: "Default timeout", value: "A 20-second offer window; Celery timeout tasks are scheduled after 21 seconds. OFFER_TIMEOUT_S is configurable." }], source: "backend/app/services/dispatch.py" },
      { id: "bus", label: "Event delivery", subtitle: "Celery locally · SNS/SQS on AWS", kind: "queue", x: 504, y: 234,
        purpose: "After the database commit, the API publishes or enqueues an event. Downstream handlers run asynchronously; publication itself is part of the request.",
        facts: [{ label: "Without SNS", value: "Celery calls the shared dispatch and notification handlers; this is the local / kind path." }, { label: "With SNS_TOPIC_ARN", value: "SNS fans out to SQS queues; the AWS consumer process handles dispatch and notifications." }, { label: "Delivery boundary", value: "Duplicate processing is possible. The database commit and event publication have no transactional outbox." }], source: "backend/app/services/events.py" },
      { id: "beat", label: "Scheduler", subtitle: "Celery Beat", kind: "control", x: 504, y: 436,
        purpose: "Enqueues periodic checks through Redis for Celery workers to execute. Recovery depends on the scheduler, workers, and shared stores being available.",
        facts: [{ label: "Every 30 seconds", value: "Schedule an active-order SLA check." }, { label: "Every 45 seconds", value: "Schedule rescue of pending orders older than 30 seconds with no live offer." }, { label: "Every 60 seconds", value: "Schedule pruning of idle riders whose GPS is over 120 seconds old." }], source: "backend/app/workers/celery_app.py" },
      { id: "redis", label: "Redis", subtitle: "Geo-index · locks · broker · pub/sub", kind: "data", x: 786, y: 80,
        purpose: "Holds rapidly changing rider state and coordinates work across processes.",
        facts: [{ label: "Matching", value: "Locations, online/available sets, and expiring offer keys." }, { label: "Messaging", value: "Celery broker and Socket.IO pub/sub use Redis." }, { label: "State boundary", value: "MySQL remains the durable order record." }], source: "backend/app/redis_client.py" },
      { id: "db", label: "MySQL", subtitle: "Users · orders · audit history", kind: "data", x: 786, y: 234,
        purpose: "Stores the durable facts: who booked a delivery, who accepted it, and how its status changed.",
        facts: [{ label: "Models", value: "User, RiderProfile, Order, and OrderEvent." }, { label: "Acceptance", value: "UPDATE … WHERE status='pending' allows one winner for that pending assignment." }, { label: "Schema", value: "The API container entrypoint runs Alembic migrations before starting the server." }], source: "backend/app/models.py" },
      { id: "pod", label: "Delivery photo", subtitle: "API disk or Amazon S3", kind: "storage", x: 786, y: 436,
        purpose: "Stores optional proof-of-delivery images. The rider submits the uploaded key with the delivery action; that action attaches it to the order.",
        facts: [{ label: "S3 configured", value: "The API signs a 300-second PUT URL; the browser sends image bytes directly to S3." }, { label: "No S3 configured", value: "The API writes to local disk. Compose mounts an uploads volume; kind has no shared photo volume." }, { label: "Viewing", value: "The API checks order access before returning a photo URL; S3 GET URLs also expire after 300 seconds." }], source: "backend/app/routers/uploads.py" },
    ],
    connections: [
      { from: "browser", to: "web", via: [[238, 275], [238, 121]] },
      { from: "browser", to: "api", label: "HTTP / WS" },
      { from: "api", to: "db", via: [[480, 349], [756, 349], [756, 275]] },
      { from: "api", to: "bus" }, { from: "bus", to: "worker" },
      // realtime.py writes rider GPS to Redis and uses it for Socket.IO pub/sub.
      { from: "api", to: "redis", via: [[480, 275], [480, 198], [750, 198], [750, 121]] },
      { from: "worker", to: "redis" },
      { from: "worker", to: "db", via: [[704, 121], [704, 275]] },
      { from: "beat", to: "redis", via: [[720, 477], [720, 121]] },
      // uploads.py: local bytes pass through the API; S3 bytes come from the browser.
      { from: "api", to: "pod", label: "local disk", via: [[480, 275], [480, 402], [878, 402]] },
      { from: "browser", to: "pod", label: "S3 PUT", via: [[123, 552], [758, 552], [758, 477]] },
    ],
    walkthroughs: [
      { id: "delivery", title: "Follow a delivery", steps: [
        { title: "A customer books a parcel", body: "The browser sends pickup and drop coordinates to the API. The API validates the request and calculates the quote.", nodes: ["browser", "api"] },
        { title: "Save the order, then publish", body: "The API commits the pending order and its audit event to MySQL, broadcasts the update, and publishes order.created.", nodes: ["api", "db", "bus"] },
        { title: "Find and offer a rider", body: "The shared dispatch handler runs in Celery locally or the SQS consumer on AWS. It reads the order in MySQL, searches Redis, reserves an offer slot, and emits a timed offer via Redis pub/sub to the API sockets.", nodes: ["bus", "worker", "db", "redis", "api", "browser"] },
        { title: "Accept one pending assignment", body: "A conditional SQL update allows only one pending-to-assigned winner. Redis marks the rider busy, and Socket.IO informs the customer. These steps are separate operations, not one atomic transaction.", nodes: ["api", "db", "redis", "browser"] },
        { title: "Track, pick up, deliver", body: "GPS flows through the API and Redis. The rider can upload a photo to S3 or the local API, then submit its key with delivery. MySQL records the status; an online rider is made available again.", nodes: ["browser", "api", "redis", "db", "pod"] },
      ] },
      { id: "gps", title: "Trace live GPS", steps: [
        { title: "A rider sends a location", body: "While online, the rider UI sends coordinates, heading, and speed every two seconds over authenticated Socket.IO. Positions are simulated by default; device GPS is an option.", nodes: ["browser", "api"] },
        { title: "Update shared rider state", body: "The API updates the Redis geo-index and rider hash, so all API instances and dispatch workers see the latest location.", nodes: ["api", "redis"] },
        { title: "Broadcast to the right rooms", body: "If the rider has an active order in Redis, its order room receives rider:location. The dispatcher room receives fleet:location for every accepted ping. Redis pub/sub relays events across API instances; missed events are not durably replayed.", nodes: ["redis", "api", "browser"] },
      ] },
      { id: "recovery", title: "An offer goes unanswered", steps: [
        { title: "Hold a short-lived offer", body: "The default offer window is 20 seconds. Redis keys last 15 seconds longer, and a Celery timeout is scheduled after 21 seconds. The grace period helps delayed tasks find the offer; execution timing is not guaranteed.", nodes: ["worker", "redis"] },
        { title: "Expire and try again", body: "If the offer key still matches, the Celery task withdraws the offer and retries dispatch. The default search radius grows through 3, 6, 12, and 25 km as attempts accumulate.", nodes: ["worker", "redis", "db"] },
        { title: "Rescue an interrupted path", body: "Every 45 seconds, Beat queues a worker check for pending orders older than 30 seconds with no live offer. It queues another dispatch attempt when the worker, Redis, and MySQL are available; it cannot repair every partial failure.", nodes: ["beat", "redis", "db", "worker"] },
        { title: "Escalate when riders are unavailable", body: "With no reservable candidate and at least MAX_DISPATCH_ATTEMPTS attempts (default 12), dispatch marks the order unassigned and emits an alert for dispatcher action.", nodes: ["worker", "db", "redis", "api", "browser"] },
      ] },
    ],
  },
  {
    id: "docker", label: "Docker", eyebrow: "02 / PACKAGING",
    title: "Package once. Run each role separately.",
    description: "Images contain the application and dependencies. Containers run a specific process from those images.",
    takeaway: "The backend Dockerfile packages api, worker, beat, and consumer roles. Compose runs the first three separately, alongside a separate frontend image and shared dependencies.",
    caveat: "Compose runs on one host without automatic horizontal scaling. It defines no SQS consumer; events use Celery when SNS_TOPIC_ARN is unset. Environment overrides can change backend settings.",
    groups: [
      { label: "BUILD INPUTS", x: 16, y: 24, width: 214, height: 552 },
      { label: "IMMUTABLE IMAGES", x: 254, y: 24, width: 214, height: 552 },
      { label: "RUNNING PROCESSES", x: 492, y: 24, width: 214, height: 552 },
      { label: "LOCAL DEPENDENCIES", x: 730, y: 24, width: 294, height: 552 },
    ],
    nodes: [
      { id: "frontend-source", label: "Frontend source", subtitle: "Next.js + package lock", kind: "client", x: 31, y: 100,
        purpose: "The frontend Dockerfile installs pinned dependencies and compiles the application.",
        facts: [{ label: "Build stages", value: "Dependencies → production build → small runtime image." }, { label: "Output", value: "Next.js standalone server and static assets." }], source: "frontend/Dockerfile" },
      { id: "backend-source", label: "Backend source", subtitle: "Python + requirements", kind: "compute", x: 31, y: 300,
        purpose: "The Python image contains the API, workers, migrations, and seed command.",
        facts: [{ label: "Shared artifact", value: "Every backend role uses the same version of the domain logic." }, { label: "Entrypoint", value: "A command selects which process the container runs." }], source: "backend/Dockerfile" },
      { id: "web-image", label: "Web image", subtitle: "node:22-alpine", kind: "storage", x: 269, y: 100,
        purpose: "A deployable filesystem snapshot containing the built web server.",
        facts: [{ label: "Runtime", value: "Runs as a non-root web user on port 3000." }, { label: "AWS registry", value: "CI pushes commit-tagged images to Amazon ECR." }], source: "frontend/Dockerfile" },
      { id: "backend-image", label: "Backend image", subtitle: "python:3.12-slim", kind: "storage", x: 269, y: 300,
        purpose: "One image becomes several separately scheduled containers.",
        facts: [{ label: "Roles", value: "api, worker, beat, consumer, migrate, and seed." }, { label: "Why reuse it?", value: "All roles ship together and share the same models and event handlers." }], source: "backend/entrypoint.sh" },
      { id: "web-container", label: "Web container", subtitle: "node server.js", kind: "compute", x: 507, y: 100,
        purpose: "A running instance of the web image serves the customer, rider, and dispatcher interfaces.",
        facts: [{ label: "Local address", value: "Compose publishes port 3000." }, { label: "API address", value: "The local frontend is built to call localhost:8000." }], source: "docker-compose.yml" },
      { id: "api-container", label: "API container", subtitle: "entrypoint → api", kind: "compute", x: 507, y: 250,
        purpose: "Runs migrations, then starts the FastAPI and Socket.IO ASGI application.",
        facts: [{ label: "Port", value: "Compose publishes API port 8000." }, { label: "Uploads", value: "Compose mounts a named volume at the default local upload directory, /tmp/dispatchx-uploads." }], source: "docker-compose.yml" },
      { id: "jobs", label: "Worker + scheduler", subtitle: "Separate worker and beat containers", kind: "control", x: 507, y: 450,
        purpose: "The worker executes queued jobs while Beat periodically schedules maintenance tasks.",
        facts: [{ label: "Independent processes", value: "A scheduler restart does not restart the web server." }, { label: "Broker", value: "Both roles connect to the shared Redis container." }], source: "docker-compose.yml" },
      { id: "mysql", label: "MySQL + volume", subtitle: "mysql-data → /var/lib/mysql", kind: "data", x: 785, y: 100,
        purpose: "A named volume persists the local database when the container is replaced.",
        facts: [{ label: "Startup", value: "API, worker, and Beat wait for a healthy MySQL container." }, { label: "Persistence", value: "Data survives container replacement while the volume is retained." }], source: "docker-compose.yml" },
      { id: "redis", label: "Redis container", subtitle: "Broker + geo + pub/sub", kind: "data", x: 785, y: 300,
        purpose: "Gives all local backend roles one shared coordination service.",
        facts: [{ label: "Networking", value: "Compose service names resolve on the project network." }, { label: "Current limitation", value: "The Compose Redis service has no configured persistent volume." }], source: "docker-compose.yml" },
      { id: "monitoring", label: "Prometheus + Grafana", subtitle: "Metrics collection and dashboards", kind: "observe", x: 785, y: 450,
        purpose: "Prometheus scrapes API metrics and Grafana presents the system and business measurements.",
        facts: [{ label: "Local ports", value: "Prometheus 9090; Grafana 3001." }, { label: "Signals", value: "HTTP traffic, latency, orders, offers, online riders, and assignment time." }], source: "monitoring/prometheus.local.yml" },
    ],
    connections: [
      { from: "frontend-source", to: "web-image", label: "build" }, { from: "web-image", to: "web-container", label: "run" },
      { from: "backend-source", to: "backend-image", label: "build" },
      { from: "backend-image", to: "api-container" },
      { from: "backend-image", to: "jobs", via: [[478, 341], [478, 491]] },
      { from: "api-container", to: "mysql", via: [[728, 291], [728, 141]] },
      { from: "api-container", to: "redis" },
      { from: "jobs", to: "mysql", via: [[708, 491], [708, 209], [877, 209]] },
      { from: "jobs", to: "redis" }, { from: "monitoring", to: "api-container", via: [[990, 409], [718, 409], [718, 291]] },
    ],
    walkthroughs: [
      { id: "build", title: "From source to containers", steps: [
        { title: "Build the artifacts", body: "Dockerfiles define the build environment. Frontend dependencies use the package lock; direct Python dependencies are version-pinned in requirements.txt. Base image tags and Python transitive dependencies are not fully locked.", nodes: ["frontend-source", "backend-source"] },
        { title: "Create two application images", body: "The frontend image contains the compiled web server. The backend image contains every backend role and its shared code.", nodes: ["web-image", "backend-image"] },
        { title: "Choose a process per container", body: "Compose starts web, API, worker, and Beat separately. API, worker, and Beat share an image but have different entrypoint commands.", nodes: ["web-container", "api-container", "jobs"] },
        { title: "Attach network and storage", body: "Containers reach MySQL and Redis by service name. Named volumes hold database files and local delivery photos.", nodes: ["api-container", "mysql", "redis"] },
      ] },
      { id: "replace", title: "Replace a container", steps: [
        { title: "The image stays reusable", body: "Replacing an API container creates a fresh process from the same image. An image is the template; a container is an instance.", nodes: ["backend-image", "api-container"] },
        { title: "Shared state stays outside the process", body: "Replacing only the API keeps orders in MySQL and coordination state in Redis. Local photos use a named volume. Replacing Redis can lose coordination state and queued jobs because Compose gives it no persistent volume.", nodes: ["api-container", "mysql", "redis"] },
        { title: "Know the single-host boundary", body: "Compose uses restart policies for backend containers. Surviving a host failure or adding replicas automatically requires an orchestrator and appropriate storage.", nodes: ["api-container", "jobs", "monitoring"] },
      ] },
    ],
  },
  {
    id: "kubernetes", label: "Kubernetes", eyebrow: "03 / ORCHESTRATION",
    title: "Declare the desired state. Let controllers maintain it.",
    description: "The kind configuration declares one control plane and two worker nodes on a single local machine or CI runner; zone-a and zone-b are simulated zone labels.",
    takeaway: "Pods run containers. Deployments maintain desired replicas. Services select pods behind stable addresses. Ingress routes browser traffic. HPA adjusts the API and worker Deployments using CPU metrics.",
    caveat: "This local / CI topology is separate from AWS ECS. The manifests configure no node autoscaler, Redis persistence, or shared photo volume. Pod replacement depends on capacity and reachable dependencies.",
    groups: [
      { label: "TRAFFIC", x: 16, y: 24, width: 214, height: 552 },
      { label: "KUBERNETES CONTROL", x: 254, y: 24, width: 214, height: 552 },
      { label: "WORKLOADS ON TWO WORKER NODES", x: 492, y: 24, width: 532, height: 552 },
    ],
    nodes: [
      { id: "ingress", label: "NGINX Ingress", subtitle: "One entry point · port 8080", kind: "client", x: 31, y: 100,
        purpose: "Routes /api and /socket.io to the API Service, and the remaining paths to the web Service.",
        facts: [{ label: "WebSockets", value: "Long timeouts and cookie affinity are configured." }, { label: "Local access", value: "kind maps host port 8080 to the ingress." }], source: "k8s/ingress.yaml" },
      { id: "services", label: "Services + cluster DNS", subtitle: "Stable workload addresses", kind: "queue", x: 31, y: 300,
        purpose: "Services give changing pods a stable network identity inside the cluster.",
        facts: [{ label: "Routing", value: "api:8000 and web:3000 select their respective pods via spec.selector and pod labels." }, { label: "Discovery", value: "Backend roles also use the mysql and redis Services; MySQL's Service is headless." }], source: "k8s/ingress.yaml" },
      { id: "deployments", label: "Deployments", subtitle: "Desired replicas + rolling updates", kind: "control", x: 269, y: 100,
        purpose: "Controllers create replacement pods when instances disappear and roll out new application versions.",
        facts: [{ label: "Workloads", value: "api, web, worker, beat, and redis." }, { label: "Scheduler safety", value: "Beat uses Recreate so the old scheduler stops before its replacement starts." }], source: "k8s/beat.yaml" },
      { id: "hpa", label: "Horizontal Pod Autoscaler", subtitle: "CPU → replica count", kind: "control", x: 269, y: 300,
        purpose: "Adjusts the number of API and worker pods using CPU metrics from metrics-server.",
        facts: [{ label: "API", value: "2–8 pods, targeting 50% CPU utilization." }, { label: "Worker", value: "1–3 pods, targeting 70% CPU utilization." }, { label: "Scale down", value: "API uses a 90-second stabilization window." }], source: "k8s/hpa.yaml" },
      { id: "rbac", label: "Config + permissions", subtitle: "ConfigMap · Secret · RBAC", kind: "control", x: 269, y: 450,
        purpose: "Supplies environment configuration and grants the API the cluster permissions used by Cluster View.",
        facts: [{ label: "Identity", value: "A ServiceAccount authenticates the API to Kubernetes." }, { label: "Inspection", value: "RBAC permits reading workloads, nodes, and events; the demo also permits pod deletion." }], source: "k8s/rbac.yaml" },
      { id: "api-pods", label: "API pods", subtitle: "FastAPI + Socket.IO containers", kind: "compute", x: 507, y: 100,
        purpose: "Replicas handle requests and WebSockets, with shared state held in MySQL and Redis.",
        facts: [{ label: "Health", value: "Readiness calls /api/ready (DB + Redis); liveness calls /api/health (process only)." }, { label: "Placement", value: "ScheduleAnyway topology constraints prefer spreading replicas across the two simulated zones." }, { label: "Local photos", value: "API pods have no upload volume: disk uploads are pod-local, unshared, and ephemeral." }], source: "k8s/api.yaml" },
      { id: "web-pods", label: "Web pods", subtitle: "Next.js containers", kind: "compute", x: 785, y: 100,
        purpose: "Serve the frontend behind the web Service and Ingress.",
        facts: [{ label: "Portable image", value: "Uses the shared frontend Dockerfile; kind builds it for same-origin API requests through Ingress." }, { label: "Placement", value: "Two replicas with ScheduleAnyway constraints that prefer spreading across simulated zones." }], source: "k8s/web.yaml" },
      { id: "jobs", label: "Worker + Beat pods", subtitle: "Task execution and scheduling", kind: "compute", x: 507, y: 300,
        purpose: "Run the background roles from the backend image without occupying API request processes.",
        facts: [{ label: "Local event bus", value: "Celery uses Redis; there is no SQS consumer in this deployment." }, { label: "Startup job", value: "A separate seed Job prepares migrations and demo accounts." }], source: "k8s/worker.yaml" },
      { id: "redis", label: "Redis pod", subtitle: "Deployment + Service", kind: "data", x: 785, y: 300,
        purpose: "Coordinates dispatch, Socket.IO, and Celery across the API and worker pods.",
        facts: [{ label: "Replicas", value: "A single Redis instance in the current manifests." }, { label: "Limitation", value: "No persistent volume or Redis failover is configured." }], source: "k8s/redis.yaml" },
      { id: "mysql", label: "MySQL StatefulSet", subtitle: "PersistentVolumeClaim", kind: "data", x: 785, y: 450,
        purpose: "Pairs the database workload with a stable storage claim.",
        facts: [{ label: "Storage", value: "The PVC holds the MySQL data directory." }, { label: "Scope", value: "A local persistent volume is not a multi-zone managed database." }], source: "k8s/mysql.yaml" },
    ],
    connections: [
      { from: "ingress", to: "services", label: "HTTP / WS" },
      { from: "services", to: "api-pods", via: [[241, 341], [241, 225], [480, 225], [480, 141]] },
      { from: "services", to: "web-pods", via: [[225, 341], [225, 248], [877, 248]] },
      { from: "deployments", to: "api-pods" }, { from: "deployments", to: "web-pods", via: [[361, 76], [877, 76]] },
      // hpa.yaml targets the API and worker Deployments; it does not scale Beat.
      { from: "hpa", to: "deployments" }, { from: "deployments", to: "jobs" },
      { from: "api-pods", to: "redis", via: [[735, 141], [735, 341]] },
      { from: "jobs", to: "mysql", via: [[599, 420], [762, 420], [762, 491]] },
      { from: "jobs", to: "redis" }, { from: "api-pods", to: "mysql", via: [[715, 141], [715, 491]] },
    ],
    walkthroughs: [
      { id: "request", title: "A request through Kubernetes", steps: [
        { title: "Enter through Ingress", body: "The browser reaches the kind cluster at port 8080. NGINX routes the request by path.", nodes: ["ingress"] },
        { title: "Resolve the correct Service", body: "The API and web Services provide stable destinations even when individual pod addresses change.", nodes: ["services", "api-pods", "web-pods"] },
        { title: "Run application logic", body: "An API pod reads or writes MySQL. Dispatch work goes to Celery through Redis and is executed in a worker pod.", nodes: ["api-pods", "mysql", "redis", "jobs"] },
      ] },
      { id: "scale", title: "Scale under load", steps: [
        { title: "API CPU rises", body: "A load generator can create more requests and GPS connections. metrics-server reports resource utilization for the pods.", nodes: ["api-pods", "hpa"] },
        { title: "HPA changes desired replicas", body: "With metrics available, HPA can raise the API Deployment from two toward eight pods around a 50% CPU target. Worker scaling targets 70% with one to three pods. Beat remains at one replica.", nodes: ["hpa", "deployments", "jobs"] },
        { title: "Controllers create more pods", body: "New replicas need space on the existing worker nodes. API readiness checks determine when new API pods can receive traffic; insufficient capacity can leave pods pending.", nodes: ["deployments", "api-pods", "services"] },
        { title: "Scale back after demand falls", body: "The API scale-down stabilization window is 90 seconds. The cluster still has two worker nodes; no node autoscaler is configured.", nodes: ["hpa", "api-pods"] },
      ] },
      { id: "heal", title: "Recover a lost API pod", steps: [
        { title: "An API pod disappears", body: "The Deployment now has fewer replicas than its desired count. Existing connections on that pod are interrupted.", nodes: ["api-pods", "deployments"] },
        { title: "Create a replacement", body: "The controller requests a replacement from the declared template. With capacity and dependencies available, it can start and pass readiness checks before receiving Service traffic.", nodes: ["deployments", "api-pods", "services"] },
        { title: "Reconnect to shared state", body: "Socket.IO clients attempt to reconnect. A replacement API uses the same MySQL and Redis services, but reconnection does not guarantee replay of missed events, restored order-room subscriptions, or recovery of in-flight requests.", nodes: ["api-pods", "mysql", "redis"] },
      ] },
    ],
  },
  {
    id: "aws", label: "AWS", eyebrow: "04 / CLOUD DEPLOYMENT",
    title: "From the edge to the data tier.",
    description: "CloudFront and an ALB route requests to ECS services on EC2, with managed data, messaging, storage, and monitoring.",
    takeaway: "ECS schedules the containers; EC2 supplies the machines. RDS, ElastiCache, S3, SNS, and SQS handle state and messaging outside the application containers.",
    caveat: "The default stack uses a single NAT Gateway, with RDS Multi-AZ and a cache replica disabled to conserve credits. The diagram describes repository configuration, not live resource health.",
    groups: [
      { label: "CLIENT + GLOBAL EDGE", x: 16, y: 24, width: 214, height: 358 },
      { label: "VPC · AP-SOUTHEAST-2 · TWO AVAILABILITY ZONES", x: 254, y: 24, width: 770, height: 358 },
      { label: "REGIONAL MANAGED SERVICES", x: 16, y: 414, width: 1008, height: 162 },
    ],
    nodes: [
      { id: "cloudfront", label: "CloudFront", subtitle: "HTTPS entry + static asset cache", kind: "client", x: 31, y: 100,
        purpose: "Provides the public HTTPS address and caches versioned static assets at the edge.",
        facts: [{ label: "Dynamic traffic", value: "Pages, API requests, and Socket.IO traffic are uncached; /_next/static/* is cached." }, { label: "Origin protocol", value: "Viewer HTTPS/WSS terminates here; the configured ALB origin uses HTTP on port 80." }, { label: "Origin access", value: "ALB rules require X-Origin-Verify. A CloudFront-only security-group rule additionally applies when CloudFrontPrefixListId is supplied." }], source: "infra/stacks/edge.yml" },
      { id: "browser", label: "Rider browser", subtitle: "App traffic + direct photo upload", kind: "client", x: 31, y: 274,
        purpose: "Uses CloudFront for the app, REST actions, and Socket.IO. Delivery photos take a separate browser-to-S3 path.",
        facts: [{ label: "Authorize", value: "POST /api/uploads/pod requests a signed upload URL for the rider's assigned order." }, { label: "Upload", value: "PUT image bytes directly to the returned S3 URL, then submit pod_key with the delivery action." }], source: "frontend/src/app/rider/page.tsx" },
      { id: "alb", label: "Application Load Balancer", subtitle: "Path routing + health checks", kind: "queue", x: 269, y: 100,
        purpose: "Routes HTTP and WebSocket traffic to web and API task targets. A regional WAF is enabled by default via EnableWaf.",
        facts: [{ label: "Placement", value: "Public subnets across two availability zones." }, { label: "Target health", value: "API targets are checked at /api/health; this process-only check does not test MySQL or Redis." }, { label: "Routing", value: "/api/* and /socket.io/* reach API tasks; /grafana paths reach monitoring; other paths reach web tasks. /metrics is blocked." }], source: "infra/src/app.template.yml" },
      { id: "ecs", label: "Amazon ECS", subtitle: "web · api · worker · beat · consumer", kind: "compute", x: 507, y: 100,
        purpose: "Runs and replaces application tasks, with independent services for each backend role and the web app.",
        facts: [{ label: "API scaling", value: "2–8 tasks, targeting 60% CPU." }, { label: "Background scaling", value: "Workers: 1–3 at 70% CPU. Consumers: 1–4 targeting 20 visible dispatch-queue messages; notify backlog is not the scaling signal." }, { label: "Deployment", value: "EC2 tasks use bridge networking and circuit-breaker rollback. ALB health checks cover API, web, and monitoring; Beat stays at one task." }], source: "infra/src/app.template.yml" },
      { id: "ec2", label: "EC2 capacity", subtitle: "Auto Scaling group + capacity provider", kind: "control", x: 507, y: 274,
        purpose: "Supplies the virtual machines on which ECS places containers.",
        facts: [{ label: "Two scaling decisions", value: "Service scaling changes task counts; the capacity provider manages hosts within ASG bounds (default 2–4 t3.small instances)." }, { label: "Networking", value: "Application subnets share one NAT Gateway; an S3 gateway endpoint provides a separate S3 route." }, { label: "Images", value: "GitHub Actions builds images and pushes them to ECR." }], source: "infra/src/app.template.yml" },
      { id: "rds", label: "Amazon RDS", subtitle: "Managed MySQL", kind: "data", x: 785, y: 100,
        purpose: "Stores users, orders, rider profiles, and the audit trail outside the ECS task lifecycle.",
        facts: [{ label: "Isolation", value: "Data subnets and security groups limit database access." }, { label: "Credentials", value: "Secrets Manager injects database credentials into the backend tasks." }, { label: "Availability", value: "Multi-AZ is an optional deployment parameter; disabled by default." }], source: "infra/stacks/data.yml" },
      { id: "cache", label: "Amazon ElastiCache", subtitle: "Valkey · Redis-compatible", kind: "data", x: 785, y: 274,
        purpose: "Provides the shared geo-index, locks, Celery broker, and pub/sub used by backend replicas.",
        facts: [{ label: "Compatibility", value: "The Python Redis clients use the managed Valkey endpoint." }, { label: "Isolation", value: "Cache access is restricted to the application tier." }, { label: "Availability", value: "A replica with failover is optional; disabled by default." }], source: "infra/stacks/data.yml" },
      { id: "messaging", label: "SNS → SQS", subtitle: "Fan-out · filtering · dead-letter queues", kind: "queue", x: 31, y: 470,
        purpose: "SNS routes order events into separate dispatch, notification, and analytics queues.",
        facts: [{ label: "Consumers", value: "Each ECS consumer task polls dispatch and notify queues in separate threads; a Lambda consumes analytics." }, { label: "Retries", value: "The ECS consumer deletes a message after its handler returns. Each queue has a DLQ with maxReceiveCount 5." }, { label: "Semantics", value: "At-least-once delivery can duplicate processing. Dispatch has state checks and locks; notification and analytics effects are not deduplicated." }], source: "infra/stacks/messaging.yml" },
      { id: "s3", label: "Amazon S3", subtitle: "Proof-of-delivery objects", kind: "storage", x: 269, y: 470,
        purpose: "Stores optional delivery photos. Image bytes go directly from the browser to S3, bypassing CloudFront and the ECS API.",
        // Bucket policy/CORS/lifecycle: infra/stacks/data.yml; tagging only: infra/stacks/analytics.yml PodFunction.
        facts: [{ label: "Direct upload", value: "The API signs a 300-second PUT URL using the task's S3 permissions; the browser uploads over HTTPS." }, { label: "Lifecycle", value: "The photo bucket has versioning and lifecycle policies; the analytics data lake is a separate bucket." }, { label: "Validation", value: "S3 Object Created → EventBridge → Lambda checks size and Content-Type metadata and tags validated=true/false. It neither deletes invalid objects nor gates delivery." }], source: "backend/app/routers/uploads.py#L32-L63" },
      { id: "analytics", label: "Lambda → S3 → Athena", subtitle: "Events become queryable history", kind: "storage", x: 507, y: 470,
        purpose: "Turns the analytics queue into date-partitioned event files in the data lake.",
        facts: [{ label: "Ingestion", value: "Lambda consumes SQS messages and writes NDJSON objects to S3." }, { label: "Catalog", value: "Glue defines the table with partition projection." }, { label: "Analysis", value: "Athena queries the event history; named queries ship with the stack." }], source: "infra/stacks/analytics.yml" },
      { id: "monitoring", label: "Metrics, logs, alarms", subtitle: "CloudWatch · Prometheus · Grafana", kind: "observe", x: 785, y: 470,
        purpose: "Makes both infrastructure behavior and delivery performance visible.",
        facts: [{ label: "CloudWatch", value: "Container logs, a dashboard, and infrastructure alarms." }, { label: "Prometheus", value: "Scrapes API and business metrics using Cloud Map discovery." }, { label: "Current limitation", value: "Prometheus history is ephemeral; alert email requires a confirmed subscriber." }], source: "infra/stacks/observability.yml" },
    ],
    connections: [
      { from: "browser", to: "cloudfront", label: "HTTPS / WSS" },
      { from: "cloudfront", to: "alb", label: "HTTP :80" }, { from: "alb", to: "ecs", label: "HTTP / WS" },
      // uploads.py signs URLs locally; the API does not proxy S3 image bytes.
      { from: "browser", to: "s3", label: "HTTPS PUT" },
      { from: "ecs", to: "rds" }, { from: "ec2", to: "ecs" }, { from: "ecs", to: "cache" },
      { from: "ecs", to: "messaging", via: [[486, 141], [486, 376], [123, 376]] },
      { from: "messaging", to: "analytics", via: [[123, 596], [599, 596]] },
      { from: "ecs", to: "monitoring", via: [[719, 141], [719, 511]] },
    ],
    walkthroughs: [
      { id: "request", title: "An order through AWS", steps: [
        { title: "Reach the cloud entry point", body: "CloudFront terminates public HTTPS/WSS. It forwards API and Socket.IO traffic to the ALB over HTTP on port 80 without edge caching.", nodes: ["cloudfront", "alb"] },
        { title: "Route to an API task", body: "The ALB routes /api/* requests to an ECS API task using process-level health checks. The task validates the customer and writes the order to RDS; ALB health alone does not prove dependencies are available.", nodes: ["alb", "ecs", "rds"] },
        { title: "Fan out the order event", body: "The API publishes order.created to SNS. Subscription filters send it to the relevant SQS queues.", nodes: ["ecs", "messaging"] },
        { title: "Dispatch with shared state", body: "The ECS consumer reads the dispatch queue and runs the dispatch handler. ElastiCache supplies rider locations and offer locks; Celery workers handle timed follow-up jobs.", nodes: ["messaging", "ecs", "cache"] },
        { title: "Deliver with an optional photo", body: "The rider requests a five-minute PUT URL from the API, uploads directly to S3, then submits the key with delivery. EventBridge triggers metadata validation and tagging in Lambda; delivery does not wait for that result.", nodes: ["browser", "ecs", "s3"] },
        { title: "Keep an analytical history", body: "The analytics Lambda reads its separate queue and writes events to S3. Athena can query that history through the Glue table.", nodes: ["messaging", "analytics"] },
      ] },
      { id: "scaling", title: "Scale tasks and machines", steps: [
        { title: "Measure workload demand", body: "API and worker scaling use CPU. Consumer scaling targets the dispatch queue's visible-message count (20), not notify backlog or backlog per task. Scaling is bounded and does not guarantee a queue will drain.", nodes: ["monitoring", "ecs", "messaging"] },
        { title: "Increase service task counts", body: "ECS service auto scaling raises the desired number of tasks within configured bounds. API tasks can grow from two to eight.", nodes: ["ecs"] },
        { title: "Make room on EC2", body: "The capacity provider can add EC2 hosts within ASG bounds, default two to four. Task scaling and host scaling are separate; tasks may wait if capacity is unavailable or the host limit is reached.", nodes: ["ecs", "ec2"] },
        { title: "Share work across replicas", body: "Added API tasks use the same RDS and ElastiCache endpoints and join ALB routing after health checks. Scaling compute does not remove the default single-instance database and cache failure boundaries.", nodes: ["alb", "ecs", "rds", "cache"] },
      ] },
      { id: "failure", title: "Handle a failed consumer", steps: [
        { title: "A handler fails", body: "The SQS consumer logs the failure and does not delete the message. The message becomes visible again after its visibility timeout.", nodes: ["ecs", "messaging", "monitoring"] },
        { title: "Retry the message", body: "A consumer can receive it again. Dispatch state checks and expiring Redis locks reduce duplicate work, but do not make all side effects atomic. Notifications and analytics can be duplicated.", nodes: ["messaging", "ecs", "cache"] },
        { title: "Isolate repeated failures", body: "After the configured receive limit of five, SQS moves the message to a dead-letter queue for investigation.", nodes: ["messaging", "monitoring"] },
        { title: "Recognize the remaining boundary", body: "The database commit and event publication are separate operations. A durable outbox is not implemented, so every failure mode is not covered by queue retries.", nodes: ["rds", "ecs", "messaging"] },
      ] },
    ],
  },
];
