// ============================================================
// Watson — 012 : The eleven employee-facing support states
// ------------------------------------------------------------
// The engine's internal CaseState is a workflow machine. This module is the
// EMPLOYEE-FACING projection of it: what the person actually sees, in their
// language. They are deliberately separate — internal states exist to make
// transitions safe, employee states exist to make the experience legible — and
// mapping between them here means the internal machine can change without
// silently changing what an employee is told.
//
// Pure module: no network, no I/O.
// ============================================================
import type { CaseState } from '../watson/cases';

export type EmployeeState =
  | 'ready'          // Watson is available, nothing in flight
  | 'listening'      // taking the initial problem statement
  | 'investigation'  // gathering evidence, one question at a time
  | 'diagnosis'      // a cause has been reached and explained
  | 'approval'       // a change is proposed and waiting on the employee
  | 'working'        // an approved action is running
  | 'verification'   // checking whether it actually worked
  | 'resolution'     // confirmed fixed, at the workflow level
  | 'escalation'     // handed to a technician with a full record
  | 'open_issue'     // unresolved and parked, honestly labelled as such
  | 'employee_report'; // the plain-language summary the employee keeps

export interface EmployeeStateView {
  readonly state: EmployeeState;
  readonly label: string;
  // One short line. Employees read this, so no jargon and no false progress.
  readonly employeeLine: string;
  // True when Watson is waiting on the person rather than working.
  readonly awaitingEmployee: boolean;
  // True when a case in this state may still be called "fixed". Guards against
  // marking something resolved just because instructions were handed over.
  readonly countsAsResolved: boolean;
}

export const EMPLOYEE_STATES: Record<EmployeeState, EmployeeStateView> = {
  ready: {
    state: 'ready', label: 'Ready',
    employeeLine: 'Tell me what is going wrong and I will take it from there.',
    awaitingEmployee: true, countsAsResolved: false
  },
  listening: {
    state: 'listening', label: 'Listening',
    employeeLine: 'Got it — let me make sure I understand the problem.',
    awaitingEmployee: true, countsAsResolved: false
  },
  investigation: {
    state: 'investigation', label: 'Investigating',
    employeeLine: 'I am working out what is causing this.',
    awaitingEmployee: true, countsAsResolved: false
  },
  diagnosis: {
    state: 'diagnosis', label: 'Diagnosis',
    employeeLine: 'Here is what I think is wrong and why.',
    awaitingEmployee: false, countsAsResolved: false
  },
  approval: {
    state: 'approval', label: 'Needs your approval',
    employeeLine: 'I need your go-ahead before I change anything.',
    awaitingEmployee: true, countsAsResolved: false
  },
  working: {
    state: 'working', label: 'Working',
    employeeLine: 'Running the fix now. You can stop this at any time.',
    awaitingEmployee: false, countsAsResolved: false
  },
  verification: {
    state: 'verification', label: 'Checking it worked',
    employeeLine: 'Let us confirm this actually fixed your work, not just the error.',
    awaitingEmployee: true, countsAsResolved: false
  },
  resolution: {
    state: 'resolution', label: 'Resolved',
    employeeLine: 'You confirmed your work is back to normal.',
    awaitingEmployee: false, countsAsResolved: true
  },
  escalation: {
    state: 'escalation', label: 'Passed to a technician',
    employeeLine: 'I could not fix this safely, so a technician has everything I found.',
    awaitingEmployee: false, countsAsResolved: false
  },
  open_issue: {
    state: 'open_issue', label: 'Still open',
    employeeLine: 'This is not fixed yet. I have not closed it.',
    awaitingEmployee: false, countsAsResolved: false
  },
  employee_report: {
    state: 'employee_report', label: 'Summary',
    employeeLine: 'Here is a short record of what happened.',
    awaitingEmployee: false, countsAsResolved: false
  }
};

// Projection from the internal workflow machine to what the employee sees.
export function toEmployeeState(
  internal: CaseState,
  opts: { approvalRequested?: boolean; running?: boolean; hasDiagnosis?: boolean } = {}
): EmployeeState {
  switch (internal) {
    case 'investigating':
      // Investigation and diagnosis share an internal state; the presence of a
      // stated cause is what separates them for the employee.
      return opts.hasDiagnosis ? 'diagnosis' : 'investigation';
    case 'waiting_for_employee':
      return 'investigation';
    case 'waiting_for_approval':
      return 'approval';
    case 'technician_working':
      return opts.running ? 'working' : 'escalation';
    case 'waiting_for_verification':
      return 'verification';
    case 'resolved':
      return 'resolution';
    case 'escalated':
    case 'assigned':
      return 'escalation';
    case 'closed':
      return 'employee_report';
    case 'reopened':
      return 'open_issue';
    default:
      return 'investigation';
  }
}

export function employeeStateView(state: EmployeeState): EmployeeStateView {
  return EMPLOYEE_STATES[state] ?? EMPLOYEE_STATES.investigation;
}

// ------------------------------------------------------------
// Resolution integrity.
//
// The single most common way support tooling lies is calling a case resolved
// because advice was given. Resolution here requires the EMPLOYEE to confirm
// their actual work is possible again — not that a command ran, and not that
// an error message disappeared.
// ------------------------------------------------------------
export interface ResolutionEvidence {
  actionCompleted: boolean;      // level 1 — the step ran
  symptomRemoved: boolean;       // level 2 — the error is gone
  workflowRestored: boolean;     // level 3 — the person can do their job
  confirmedByEmployee: boolean;  // the person said so; Watson did not assume
}

export interface ResolutionDecision {
  resolved: boolean;
  state: EmployeeState;
  reason: string;
}

export function decideResolution(e: ResolutionEvidence): ResolutionDecision {
  if (!e.confirmedByEmployee) {
    return {
      resolved: false, state: 'verification',
      reason: 'Waiting for you to confirm whether your work is back to normal.'
    };
  }
  if (!e.actionCompleted) {
    return { resolved: false, state: 'open_issue', reason: 'The step did not complete.' };
  }
  if (!e.symptomRemoved) {
    return { resolved: false, state: 'open_issue', reason: 'The original symptom is still present.' };
  }
  if (!e.workflowRestored) {
    // The error cleared but the person still cannot work. This is NOT resolved,
    // and calling it so is exactly the failure this check exists to prevent.
    return {
      resolved: false, state: 'open_issue',
      reason: 'The error is gone but you still cannot do your work, so this stays open.'
    };
  }
  return { resolved: true, state: 'resolution', reason: 'You confirmed your work is back to normal.' };
}

// Guidance alone never resolves a case.
export function instructionsOnlyResolve(): false {
  return false;
}
