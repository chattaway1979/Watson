// ============================================================
// Watson — 012 : Cause taxonomy (shared across all support skills)
// ------------------------------------------------------------
// Watson must say WHAT KIND of problem this is, not merely "it's broken".
// The distinction matters because each cause class has a different owner, a
// different safe action set, and a different escalation queue. Guessing the
// class is worse than admitting the cause is unknown, so `unknown_cause` is a
// first-class outcome — never a fallback we quietly avoid.
//
// Pure module: no network, no I/O, no side effects.
// ============================================================

export type CauseClass =
  | 'user_training'          // the software is fine; the workflow was misunderstood
  | 'application_defect'     // the app itself misbehaves
  | 'windows_endpoint'       // OS / device / driver / resource problem
  | 'm365_identity_access'   // sign-in, token, licence, conditional access
  | 'network'                // connectivity, DNS, proxy, VPN
  | 'file_specific'          // one document is bad; everything else is fine
  | 'permissions'            // the person is not allowed, and that may be correct
  | 'service_outage'         // vendor-side incident
  | 'licensing'              // entitlement/edition, distinct from identity
  | 'printer_driver'         // output path rather than the application
  | 'unknown_cause';         // insufficient evidence — say so plainly

export interface CauseProfile {
  readonly key: CauseClass;
  readonly label: string;
  // What the employee is told. Deliberately short and non-technical.
  readonly employeeSummary: string;
  // Who ultimately owns the fix. Drives escalation routing.
  readonly owner: 'employee' | 'watson' | 'it_technician' | 'vendor' | 'microsoft';
  // Whether Watson may attempt any repair at all for this class.
  readonly watsonMayAttemptRepair: boolean;
  readonly routingQueue: string;
}

export const CAUSE_PROFILES: Record<CauseClass, CauseProfile> = {
  user_training: {
    key: 'user_training',
    label: 'Workflow or training',
    employeeSummary: 'The software is working; the steps just need adjusting.',
    owner: 'employee',
    watsonMayAttemptRepair: false,
    routingQueue: 'enablement'
  },
  application_defect: {
    key: 'application_defect',
    label: 'Application problem',
    employeeSummary: 'The application itself is misbehaving on this computer.',
    owner: 'watson',
    watsonMayAttemptRepair: true,
    routingQueue: 'desktop_support'
  },
  windows_endpoint: {
    key: 'windows_endpoint',
    label: 'Windows or device problem',
    employeeSummary: 'Something on this computer is causing it, not the application.',
    owner: 'it_technician',
    watsonMayAttemptRepair: true,
    routingQueue: 'desktop_support'
  },
  m365_identity_access: {
    key: 'm365_identity_access',
    label: 'Microsoft 365 sign-in or access',
    employeeSummary: 'This is a Microsoft account or access problem, not the application.',
    owner: 'it_technician',
    watsonMayAttemptRepair: false,
    routingQueue: 'identity'
  },
  network: {
    key: 'network',
    label: 'Network',
    employeeSummary: 'The connection to the network or internet is the problem.',
    owner: 'it_technician',
    watsonMayAttemptRepair: false,
    routingQueue: 'infrastructure'
  },
  file_specific: {
    key: 'file_specific',
    label: 'This file only',
    employeeSummary: 'This particular file is the problem — other files are fine.',
    owner: 'watson',
    watsonMayAttemptRepair: true,
    routingQueue: 'desktop_support'
  },
  permissions: {
    key: 'permissions',
    label: 'Permissions',
    employeeSummary: 'Your account does not currently have access to this.',
    owner: 'it_technician',
    watsonMayAttemptRepair: false,
    routingQueue: 'identity'
  },
  service_outage: {
    key: 'service_outage',
    label: 'Service outage',
    employeeSummary: 'The provider is having a problem. This is not your computer.',
    owner: 'vendor',
    watsonMayAttemptRepair: false,
    routingQueue: 'incident'
  },
  licensing: {
    key: 'licensing',
    label: 'Licence or edition',
    employeeSummary: 'This looks like a licence or edition problem.',
    owner: 'it_technician',
    watsonMayAttemptRepair: false,
    routingQueue: 'licensing'
  },
  printer_driver: {
    key: 'printer_driver',
    label: 'Printer or driver',
    employeeSummary: 'The problem is in the printing path rather than the document.',
    owner: 'it_technician',
    watsonMayAttemptRepair: true,
    routingQueue: 'desktop_support'
  },
  unknown_cause: {
    key: 'unknown_cause',
    label: 'Not yet determined',
    employeeSummary: 'I do not have enough evidence yet to say what is causing this.',
    owner: 'it_technician',
    watsonMayAttemptRepair: false,
    routingQueue: 'triage'
  }
};

// Causes Watson must never attempt to "repair" itself, regardless of confidence.
// Attempting a local fix for these either cannot work or masks the real problem.
export const NON_REPAIRABLE_BY_WATSON: readonly CauseClass[] = [
  'm365_identity_access',
  'network',
  'permissions',
  'service_outage',
  'licensing',
  'user_training',
  'unknown_cause'
] as const;

export function mayWatsonAttemptRepair(cause: CauseClass): boolean {
  return !NON_REPAIRABLE_BY_WATSON.includes(cause);
}

export function causeProfile(cause: CauseClass): CauseProfile {
  return CAUSE_PROFILES[cause] ?? CAUSE_PROFILES.unknown_cause;
}

// ------------------------------------------------------------
// Evidence-driven narrowing.
//
// The single most useful discriminator in desktop support is "does it happen
// with everything, or only with this one thing?". These helpers encode that
// rather than leaving it to prose.
// ------------------------------------------------------------
export interface NarrowingEvidence {
  // Does a known-good file / second document behave correctly?
  knownGoodWorks?: boolean;
  // Does the problem follow the file to another computer?
  reproducesOnOtherDevice?: boolean;
  // Does a local copy behave differently from the synced/SharePoint copy?
  localCopyWorks?: boolean;
  // Are other applications affected too?
  otherAppsAffected?: boolean;
  // Are other people affected?
  otherPeopleAffected?: boolean;
}

export interface NarrowingResult {
  cause: CauseClass;
  rationale: string;
  // False whenever the evidence is too thin to justify the conclusion.
  sufficient: boolean;
}

// Narrow a cause from comparison evidence. Returns `unknown_cause` with
// `sufficient: false` whenever the answer would be a guess — that is the point
// of this function, not a failure of it.
export function narrowCause(e: NarrowingEvidence): NarrowingResult {
  if (e.otherPeopleAffected === true) {
    return {
      cause: 'service_outage',
      rationale: 'Multiple people are affected, so this is not specific to one computer.',
      sufficient: true
    };
  }
  if (e.otherAppsAffected === true) {
    return {
      cause: 'windows_endpoint',
      rationale: 'More than one application is affected, which points at the computer rather than one app.',
      sufficient: true
    };
  }
  if (e.knownGoodWorks === true && e.reproducesOnOtherDevice === true) {
    return {
      cause: 'file_specific',
      rationale: 'A known-good file works and the problem follows this file to another computer.',
      sufficient: true
    };
  }
  if (e.knownGoodWorks === true && e.reproducesOnOtherDevice === undefined) {
    return {
      cause: 'file_specific',
      rationale: 'A known-good file opens correctly, so the application itself is working.',
      sufficient: true
    };
  }
  if (e.knownGoodWorks === false) {
    return {
      cause: 'application_defect',
      rationale: 'Even a known-good file fails, so this is not specific to one document.',
      sufficient: true
    };
  }
  if (e.localCopyWorks === true) {
    return {
      cause: 'm365_identity_access',
      rationale: 'A local copy works while the synced copy does not, which points at access or sync.',
      sufficient: true
    };
  }
  return {
    cause: 'unknown_cause',
    rationale: 'Not enough comparison evidence yet to separate the file, the application, and the computer.',
    sufficient: false
  };
}
