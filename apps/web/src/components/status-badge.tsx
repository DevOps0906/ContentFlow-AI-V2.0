import {
  lifecycleLabels,
  phaseOf,
  phases,
  phaseLabels,
  warningStates,
  type LifecycleState,
} from "@/lib/lifecycle";

export function StatusBadge({ state }: { state: LifecycleState }) {
  return (
    <span
      className={`status ${phaseOf(state)}${warningStates.includes(state) ? " warn" : ""}`}
    >
      {lifecycleLabels[state]}
    </span>
  );
}

export function PhaseSteps({ state }: { state: LifecycleState }) {
  const current = phases.indexOf(phaseOf(state));
  return (
    <ol className="phase-steps" aria-label="진행 단계">
      {phases.map((p, i) => (
        <li
          key={p}
          className={i < current ? "done" : i === current ? "current" : ""}
          aria-current={i === current ? "step" : undefined}
        >
          {phaseLabels[p]}
        </li>
      ))}
    </ol>
  );
}
