(function exposeCanvasModel(root, factory) {
  const model = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = model;
  else root.WeaveCanvasModel = model;
})(globalThis, () => {
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function phaseProgram(kind) {
    const workflows = {
      direct: [
        { id: "implement", kind: "work", name: "Complete the goal", goal: "Produce the requested outcome. Gather context and use any relevant tools or integrations along the way." },
        { id: "verify", kind: "verify", name: "Prove it works", criteria: "The requested outcome is complete, accurate, and supported by relevant evidence or checks.", maxRepairs: 1 },
      ],
      review: [
        { id: "inspect", kind: "work", name: "Understand and propose", goal: "Understand the available context and present a concise direction. Do not make consequential changes yet." },
        { id: "approve", kind: "checkpoint", name: "Calibrate the run", question: "What must remain fixed, and what should Codex redirect before continuing?" },
        { id: "implement", kind: "work", name: "Complete the goal", goal: "Follow the calibrated direction and produce the requested outcome using any relevant tools or integrations." },
        { id: "verify", kind: "verify", name: "Prove the result", criteria: "The requested outcome is complete, accurate, and supported by relevant evidence or checks.", maxRepairs: 1 },
      ],
      audit: [
        { id: "map", kind: "work", name: "Explore the options", goal: "Gather context, compare plausible approaches, and identify assumptions, tradeoffs, and likely failure modes before acting." },
        { id: "implement", kind: "work", name: "Execute the best path", goal: "Choose the strongest supported approach and produce the requested outcome using any relevant tools or integrations." },
        { id: "verify", kind: "verify", name: "Challenge the result", criteria: "Actively look for weak assumptions, missing evidence, edge cases, or quality problems; repair once if the result does not hold up.", maxRepairs: 1 },
      ],
      precision: [
        { id: "inspect", kind: "work", scope: "focused", name: "Find the cause", goal: "Inspect the relevant implementation and focused tests. Explain the smallest supported change.", reasoningEffort: "low" },
        { id: "implement", kind: "work", scope: "focused", name: "Make the focused change", goal: "Implement only the supported change. Do not broaden the task.", reasoningEffort: "inherit" },
        { id: "focused-test", kind: "command", stepType: "test", name: "Run the focused test", command: "python3 -m pytest -q", expectedExitCode: 0, stopOnFailure: true },
        { id: "static-check", kind: "command", stepType: "checker", name: "Check the changed files", command: "git diff --check", expectedExitCode: 0, stopOnFailure: true },
        { id: "review", kind: "verify", name: "Review the evidence", criteria: "The change is narrow, the requested behavior is complete, and every exact check passed.", maxRepairs: 0 },
      ],
    };
    return workflows[kind];
  }

  function linearGraph(kind) {
    const phases = clone(phaseProgram(kind));
    phases.forEach((phase, index) => { phase.position = { x: 90 + (index * 300), y: 230 }; });
    return {
      projectionVersion: 1,
      phases,
      edges: phases.slice(1).map((phase, index) => ({ from: phases[index].id, to: phase.id })),
    };
  }

  function clientTopologicalOrder(program) {
    if (!program?.edges?.length) return program?.phases || [];
    const byId = new Map(program.phases.map((phase) => [phase.id, phase]));
    const index = new Map(program.phases.map((phase, order) => [phase.id, order]));
    const incoming = new Map(program.phases.map((phase) => [phase.id, 0]));
    const outgoing = new Map(program.phases.map((phase) => [phase.id, []]));
    for (const edge of program.edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to)) return program.phases;
      incoming.set(edge.to, incoming.get(edge.to) + 1);
      outgoing.get(edge.from).push(edge.to);
    }
    const ready = program.phases.filter((phase) => incoming.get(phase.id) === 0).map((phase) => phase.id);
    const result = [];
    while (ready.length) {
      ready.sort((left, right) => index.get(left) - index.get(right));
      const id = ready.shift();
      result.push(byId.get(id));
      for (const target of outgoing.get(id).sort((left, right) => index.get(left) - index.get(right))) {
        incoming.set(target, incoming.get(target) - 1);
        if (incoming.get(target) === 0) ready.push(target);
      }
    }
    return result;
  }

  function orderedClientPhases(program) {
    const ordered = clientTopologicalOrder(program);
    return ordered.length === (program?.phases?.length || 0) ? ordered : (program?.phases || []);
  }

  function graphProblem(program) {
    const ids = new Set(program.phases.map((phase) => phase.id));
    if (program.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) return "An arrow points to a missing node.";
    if (program.edges.some((edge) => edge.from === edge.to)) return "A node cannot point to itself.";
    const identities = program.edges.map((edge) => `${edge.from}\u0000${edge.to}`);
    if (new Set(identities).size !== identities.length) return "The same arrow appears twice.";
    if (program.phases.length > 1 && !program.edges.length) return "Connect the nodes with arrows before running.";
    const incoming = new Map(program.phases.map((phase) => [phase.id, 0]));
    for (const edge of program.edges) incoming.set(edge.to, incoming.get(edge.to) + 1);
    const roots = program.phases.filter((phase) => incoming.get(phase.id) === 0);
    if (roots.length !== 1) return roots.length ? "Connect every loose node so there is one starting point." : "This graph contains a loop. Remove one arrow.";
    if (clientTopologicalOrder(program).length !== program.phases.length) return "This graph contains a loop or disconnected nodes.";
    if (roots[0].kind !== "work") return "The starting node must be a Codex turn.";
    return "";
  }

  function wouldCreateCycle(program, sourceId, targetId) {
    if (sourceId === targetId) return true;
    const outgoing = new Map(program.phases.map((phase) => [phase.id, []]));
    for (const edge of program.edges) outgoing.get(edge.from)?.push(edge.to);
    const pending = [targetId];
    const seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (current === sourceId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(outgoing.get(current) || []));
    }
    return false;
  }

  function uniquePhaseId(stem, program) {
    const base = String(stem).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "node";
    const ids = new Set(program.phases.map((phase) => phase.id));
    let id = /^[a-z]/.test(base) ? base : `node-${base}`;
    let counter = 2;
    while (ids.has(id)) id = `${base.slice(0, 42)}-${counter++}`;
    return id;
  }

  function layoutRunGraph(graph, executions = []) {
    const sourcePhases = graph?.phases?.length
      ? clone(graph.phases)
      : executions.map((execution) => ({
          id: execution.phaseId,
          kind: execution.kind,
          name: execution.name,
        }));
    const sourceEdges = graph?.edges?.length
      ? clone(graph.edges)
      : sourcePhases.slice(1).map((phase, index) => ({ from: sourcePhases[index].id, to: phase.id }));
    if (!sourcePhases.length) return { width: 1200, height: 320, nodes: [], edges: [] };

    const program = { phases: sourcePhases, edges: sourceEdges };
    const ordered = orderedClientPhases(program);
    const parents = new Map(sourcePhases.map((phase) => [phase.id, []]));
    for (const edge of sourceEdges) parents.get(edge.to)?.push(edge.from);
    const levelById = new Map();
    for (const phase of ordered) {
      const phaseParents = parents.get(phase.id) || [];
      levelById.set(phase.id, phaseParents.length ? Math.max(...phaseParents.map((id) => levelById.get(id) || 0)) + 1 : 0);
    }
    const levels = new Map();
    for (const phase of ordered) {
      const level = levelById.get(phase.id) || 0;
      if (!levels.has(level)) levels.set(level, []);
      levels.get(level).push(phase);
    }

    const width = 1200;
    const nodeWidth = 176;
    const nodeHeight = 90;
    const xPadding = 54;
    const yPadding = 46;
    const maxLevel = Math.max(...levels.keys());
    const largestLevel = Math.max(...[...levels.values()].map((items) => items.length));
    const height = Math.max(320, (largestLevel * 118) + (yPadding * 2));
    const executionById = new Map(executions.map((execution) => [execution.phaseId, execution]));
    const nodes = [];
    for (const [level, phases] of levels) {
      const x = maxLevel ? xPadding + (level * ((width - nodeWidth - (xPadding * 2)) / maxLevel)) : (width - nodeWidth) / 2;
      const contentHeight = phases.length * nodeHeight + Math.max(0, phases.length - 1) * 28;
      const startY = (height - contentHeight) / 2;
      phases.forEach((phase, index) => {
        nodes.push({
          ...phase,
          x,
          y: startY + index * (nodeHeight + 28),
          width: nodeWidth,
          height: nodeHeight,
          execution: executionById.get(phase.id) || null,
        });
      });
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = sourceEdges.flatMap((edge) => {
      const source = byId.get(edge.from);
      const target = byId.get(edge.to);
      if (!source || !target) return [];
      return [{
        ...edge,
        startX: source.x + source.width,
        startY: source.y + source.height / 2,
        endX: target.x,
        endY: target.y + target.height / 2,
      }];
    });
    return { width, height, nodes, edges };
  }

  return { clone, phaseProgram, linearGraph, clientTopologicalOrder, orderedClientPhases, graphProblem, wouldCreateCycle, uniquePhaseId, layoutRunGraph };
});
