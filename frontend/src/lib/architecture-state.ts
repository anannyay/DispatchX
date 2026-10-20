import { LAYERS, type LayerId } from "./architecture";

export interface ExplorerSelection {
  layer: LayerId;
  node: string;
  flow: string | null;
  step: number;
}

const DEFAULT_NODE: Record<LayerId, string> = {
  services: "api", docker: "backend-image", kubernetes: "deployments", aws: "ecs",
};

export function initialSelection(layer: LayerId = "services"): ExplorerSelection {
  return { layer, node: DEFAULT_NODE[layer], flow: null, step: 0 };
}

/** A copied URL is untrusted input: resolve every ID against this layer. */
export function readSelection(params: URLSearchParams): ExplorerSelection {
  const layer = LAYERS.find((item) => item.id === params.get("layer")) ?? LAYERS[0];
  const fallback = initialSelection(layer.id);
  const node = layer.nodes.find((item) => item.id === params.get("node"))?.id ?? fallback.node;
  const flow = layer.walkthroughs.find((item) => item.id === params.get("flow"));
  const requestedStep = Number(params.get("step") ?? 1);
  const step = flow && Number.isSafeInteger(requestedStep)
    ? Math.max(0, Math.min(flow.steps.length - 1, requestedStep - 1)) : 0;
  return { layer: layer.id, node, flow: flow?.id ?? null, step };
}

/** Steps are one-based in links and zero-based in the UI. No live actions are encoded. */
export function selectionPath(selection: ExplorerSelection): string {
  const params = new URLSearchParams({ layer: selection.layer });
  if (selection.flow) {
    params.set("flow", selection.flow);
    params.set("step", String(selection.step + 1));
  } else {
    params.set("node", selection.node);
  }
  return `/architecture?${params}`;
}
