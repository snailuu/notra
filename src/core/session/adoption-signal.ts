import { buildProjectGraphFromDirectory } from "../knowledge/graph-model.js";
import { normalizeEvidencePath } from "../knowledge/evidence.js";

export type AdoptionDeclared = "adopted" | "not_applicable" | "missing";
export type AdoptionSignal = "strong" | "weak" | "none";

export interface AdoptionObservation {
  node_id: string;
  declared: AdoptionDeclared;
  evidence_overlap: boolean | null;
  signal: AdoptionSignal;
}

export interface AdoptionClassification {
  strong: string[];
  weak: string[];
  notApplicable: string[];
  observations: AdoptionObservation[];
}

export interface ClassifyAdoptionSignalsParams {
  preflight: any;
  agentAdopted: string[];
  agentNotApplicable: string[];
  touchedFiles: string[];
  nodeMap: Map<string, { source_evidence?: string[] }>;
}

export function classifyAdoptionSignals(params: ClassifyAdoptionSignalsParams): AdoptionClassification {
  const { preflight, agentAdopted, agentNotApplicable, touchedFiles, nodeMap } = params;
  const recommended = extractRecommendedNodeIds(preflight);
  const result: AdoptionClassification = {
    strong: [],
    weak: [],
    notApplicable: [...dedupeValues(agentNotApplicable)],
    observations: []
  };

  const adoptedSet = new Set(agentAdopted);
  const notApplicableSet = new Set(agentNotApplicable);
  // adopted 与 notApplicable 同节点冲突时，adopted 优先（在执行层兜底）
  const conflictingIds = [...adoptedSet].filter((id) => notApplicableSet.has(id));
  for (const id of conflictingIds) {
    notApplicableSet.delete(id);
  }
  result.notApplicable = result.notApplicable.filter((id) => !adoptedSet.has(id));

  const touchedSet = new Set(touchedFiles.map((p) => normalizeEvidencePath(p)));

  for (const nodeId of dedupeValues(agentAdopted)) {
    const node = nodeMap.get(nodeId);
    const overlap = hasEvidenceOverlap(node?.source_evidence || [], touchedSet);
    if (overlap) {
      result.strong.push(nodeId);
    } else {
      result.weak.push(nodeId);
    }
    result.observations.push({
      node_id: nodeId,
      declared: "adopted",
      evidence_overlap: overlap,
      signal: overlap ? "strong" : "weak"
    });
  }

  for (const nodeId of dedupeValues([...notApplicableSet])) {
    result.observations.push({
      node_id: nodeId,
      declared: "not_applicable",
      evidence_overlap: null,
      signal: "none"
    });
  }

  for (const nodeId of recommended) {
    if (adoptedSet.has(nodeId) || notApplicableSet.has(nodeId)) {
      continue;
    }
    result.weak.push(nodeId);
    result.observations.push({
      node_id: nodeId,
      declared: "missing",
      evidence_overlap: false,
      signal: "weak"
    });
  }

  result.strong = dedupeValues(result.strong);
  result.weak = dedupeValues(result.weak);
  result.notApplicable = dedupeValues(result.notApplicable);

  return result;
}

export function extractRecommendedNodeIds(preflight: any): string[] {
  if (!preflight || preflight.mode !== "knowledge-hit") {
    return [];
  }
  return dedupeValues(
    (preflight.matchedPractices || [])
      .map((practice: any) => practice?.recommended_option)
      .filter(Boolean)
  );
}

export const recommendedFromPreflight = extractRecommendedNodeIds;

export async function loadNodeMapForIds(
  knowledgeRoot: string,
  ids: string[]
): Promise<Map<string, { source_evidence?: string[] }>> {
  if (!ids || ids.length === 0) {
    return new Map();
  }
  const graph = await buildProjectGraphFromDirectory(knowledgeRoot);
  const wanted = new Set(ids);
  return new Map(
    (graph.nodes || [])
      .filter((node: any) => wanted.has(node.id))
      .map((node: any) => [node.id, { source_evidence: node.source_evidence || [] }])
  );
}

function hasEvidenceOverlap(evidencePaths: string[], touchedSet: Set<string>): boolean {
  if (!evidencePaths || evidencePaths.length === 0 || touchedSet.size === 0) {
    return false;
  }
  for (const raw of evidencePaths) {
    const normalized = normalizeEvidencePath(raw);
    if (normalized && touchedSet.has(normalized)) {
      return true;
    }
  }
  return false;
}

function dedupeValues(values: string[] | undefined | null): string[] {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}
