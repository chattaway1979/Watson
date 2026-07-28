// ============================================================
// Watson — 012 : Bluebeam Revu skill pack — issue families
// ------------------------------------------------------------
// Bluebeam is the application H&R Electric's estimators and project teams live
// in. A generic "restart and reinstall" script is actively harmful here: it
// destroys custom Tool Chests and calibration work that took months to build,
// and it rarely addresses the real cause, which is usually a specific plan set,
// a SharePoint lock, or an uncalibrated page rather than the application.
//
// Every family below therefore states the MINIMUM EVIDENCE required before any
// action, and lists prohibited actions explicitly. Watson may not skip to a
// repair because a symptom "looks like" something familiar.
//
// Pure data + pure functions. No network, no I/O, no execution.
// ============================================================
import type { CauseClass } from '../../support/causes';

export type BluebeamFamilyKey =
  | 'launch_stability'
  | 'signin_licensing'
  | 'studio'
  | 'pdf_rendering'
  | 'printing_plotting'
  | 'measurement_scale'
  | 'markups_toolchest'
  | 'ocr_search_overlay'
  | 'file_sync_locking'
  | 'profiles_settings';

export type BusinessImpactPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface DiagnosticBranch {
  // The single next-best question. Watson asks ONE of these, never a list.
  readonly question: string;
  // Where the answer is stored on the case so it is never asked twice.
  readonly evidenceKey: string;
  readonly outcomes: ReadonlyArray<{
    readonly whenAnswer: string;
    readonly cause: CauseClass;
    // Positive raises confidence, negative lowers it. Applied by the engine.
    readonly confidenceDelta: number;
    readonly note: string;
  }>;
}

export interface BluebeamFamily {
  readonly key: BluebeamFamilyKey;
  readonly label: string;
  // Plain-language symptoms an employee might actually type.
  readonly exampleStatements: readonly string[];
  // Evidence Watson MUST have before proposing any change. Non-negotiable.
  readonly minimumEvidence: readonly string[];
  readonly branches: readonly DiagnosticBranch[];
  // Causes this family can legitimately resolve to.
  readonly candidateCauses: readonly CauseClass[];
  readonly employeeSafeActions: readonly string[];      // Tier 1
  readonly approvalRequiredActions: readonly string[];  // Tier 2
  readonly prohibitedActions: readonly string[];        // never, or Tier 3 only
  readonly verificationSequence: readonly string[];     // action -> symptom -> workflow
  readonly escalationConditions: readonly string[];
  readonly handoffFields: readonly string[];
  readonly repairTimeMinutes: { readonly min: number; readonly max: number };
  readonly defaultPriority: BusinessImpactPriority;
}

// Shared verification spine. Every family verifies at three levels; only the
// workflow-level line differs, because that is the only one that proves the
// person can actually do their job again.
const verify = (workflowLine: string): readonly string[] => [
  'Confirm the step Watson ran actually completed.',
  'Confirm the original error or symptom is gone.',
  workflowLine
];

export const BLUEBEAM_FAMILIES: Record<BluebeamFamilyKey, BluebeamFamily> = {
  // ----------------------------------------------------------
  launch_stability: {
    key: 'launch_stability',
    label: 'Bluebeam will not open, crashes, freezes, or runs slowly',
    exampleStatements: [
      'Bluebeam will not open.',
      'Bluebeam is running extremely slow.',
      'Revu crashes as soon as I open a drawing.',
      'Bluebeam is not responding.'
    ],
    minimumEvidence: [
      'Whether Bluebeam fails to start at all, or starts and then fails.',
      'Whether it fails with every file or only with a specific plan set.',
      'Whether a Bluebeam process is already running (often hung) before launch.',
      'Whether the computer itself is short of memory or disk.'
    ],
    branches: [
      {
        question: 'Does Bluebeam fail to open at all, or does it open and then freeze?',
        evidenceKey: 'bluebeam.launch.stage',
        outcomes: [
          { whenAnswer: 'never_opens', cause: 'application_defect', confidenceDelta: 15, note: 'Failure before any document loads points at the install or a hung process.' },
          { whenAnswer: 'opens_then_freezes', cause: 'file_specific', confidenceDelta: 10, note: 'Opening then freezing usually implicates the document being loaded.' },
          { whenAnswer: 'slow_throughout', cause: 'windows_endpoint', confidenceDelta: 10, note: 'General slowness is more often resources than Bluebeam.' }
        ]
      },
      {
        question: 'If you open a small, known-good PDF instead, does that work normally?',
        evidenceKey: 'bluebeam.knownGoodWorks',
        outcomes: [
          { whenAnswer: 'yes', cause: 'file_specific', confidenceDelta: 25, note: 'Application is healthy; the original plan set is the problem.' },
          { whenAnswer: 'no', cause: 'application_defect', confidenceDelta: 20, note: 'Fails regardless of document — application or profile level.' }
        ]
      },
      {
        question: 'Are other applications on this computer also slow or unresponsive right now?',
        evidenceKey: 'bluebeam.otherAppsAffected',
        outcomes: [
          { whenAnswer: 'yes', cause: 'windows_endpoint', confidenceDelta: 25, note: 'Whole-machine symptom; treating this as a Bluebeam fault would waste the repair.' },
          { whenAnswer: 'no', cause: 'application_defect', confidenceDelta: 10, note: 'Isolated to Bluebeam.' }
        ]
      }
    ],
    candidateCauses: ['application_defect', 'windows_endpoint', 'file_specific', 'unknown_cause'],
    employeeSafeActions: [
      'Close and reopen Bluebeam.',
      'Open a small known-good PDF to compare.',
      'Open a local copy instead of the SharePoint copy.',
      'Check whether the computer is low on memory or disk.'
    ],
    approvalRequiredActions: [
      'End a confirmed hung Bluebeam process.',
      'Switch to a clean test profile (reversible, original preserved).',
      'Clear approved Bluebeam cache locations.',
      'Run the supported Bluebeam repair.'
    ],
    prohibitedActions: [
      'Reinstalling before a Tool Chest and profile backup exists.',
      'Deleting the user profile folder outright.',
      'Registry edits (technician only).'
    ],
    verificationSequence: verify('Confirm the employee can open the plan set they actually needed and work in it.'),
    escalationConditions: [
      'Crashes persist after a clean test profile.',
      'Crash logs show a repeated fault the employee cannot resolve.',
      'The computer is out of disk or memory at a level Watson cannot safely fix.'
    ],
    handoffFields: ['crash_log_excerpt', 'bluebeam_version', 'file_specific_result', 'known_good_result', 'process_state', 'disk_memory_state'],
    repairTimeMinutes: { min: 5, max: 25 },
    defaultPriority: 'high'
  },

  // ----------------------------------------------------------
  signin_licensing: {
    key: 'signin_licensing',
    label: 'Bluebeam sign-in, licence, or edition problems',
    exampleStatements: [
      'Bluebeam says my licence is not valid.',
      'I cannot sign in to Bluebeam.',
      'Revu opened in demo mode.',
      'It says my trial expired.'
    ],
    minimumEvidence: [
      'The exact on-screen message, quoted rather than paraphrased.',
      'Whether the prompt is a Bluebeam sign-in or a Microsoft sign-in — they look similar and are handled by different teams.',
      'Whether the employee can sign in to Microsoft 365 normally right now.',
      'Which edition the employee expects to have.'
    ],
    branches: [
      {
        question: 'Does the sign-in window show the Bluebeam logo, or a Microsoft sign-in page?',
        evidenceKey: 'bluebeam.signin.provider',
        outcomes: [
          { whenAnswer: 'bluebeam', cause: 'licensing', confidenceDelta: 25, note: 'Bluebeam entitlement path — licensing queue.' },
          { whenAnswer: 'microsoft', cause: 'm365_identity_access', confidenceDelta: 30, note: 'Microsoft identity problem that merely surfaced inside Bluebeam.' }
        ]
      },
      {
        question: 'Can you open Outlook or Teams and use them normally right now?',
        evidenceKey: 'bluebeam.m365Healthy',
        outcomes: [
          { whenAnswer: 'no', cause: 'm365_identity_access', confidenceDelta: 25, note: 'Broader Microsoft sign-in problem.' },
          { whenAnswer: 'yes', cause: 'licensing', confidenceDelta: 15, note: 'Microsoft identity is healthy, so the problem is Bluebeam-side.' }
        ]
      }
    ],
    candidateCauses: ['licensing', 'm365_identity_access', 'network', 'unknown_cause'],
    employeeSafeActions: [
      'Read out the exact message shown.',
      'Confirm whether Outlook and Teams work.',
      'Close and reopen Bluebeam once.'
    ],
    approvalRequiredActions: [],
    prohibitedActions: [
      'Stating a licence is valid, expired, or assigned without verified entitlement data — Watson has no licence source and must never guess.',
      'Reassigning or releasing licences (administrator only).',
      'Changing the Microsoft account signed into Windows.'
    ],
    verificationSequence: verify('Confirm the employee can open Bluebeam with full functionality, not demo mode.'),
    escalationConditions: [
      'A Bluebeam entitlement change is required.',
      'The Microsoft sign-in loop persists.',
      'Edition does not match what the role requires.'
    ],
    handoffFields: ['exact_message', 'signin_provider', 'expected_edition', 'm365_health', 'bluebeam_version'],
    repairTimeMinutes: { min: 5, max: 30 },
    defaultPriority: 'high'
  },

  // ----------------------------------------------------------
  studio: {
    key: 'studio',
    label: 'Bluebeam Studio Sessions and Projects',
    exampleStatements: [
      'I cannot join the Studio session.',
      'My Studio project will not sync.',
      'The session is not showing up.',
      'It says the document is checked out.'
    ],
    minimumEvidence: [
      'Whether this is a Session (live markup) or a Project (document store) — they fail differently.',
      'Whether the employee can sign in to Studio at all.',
      'Whether other Studio members are affected.',
      'Whether there are unsynced local changes that must be preserved first.'
    ],
    branches: [
      {
        question: 'Is this a Studio Session you join for live markups, or a Studio Project you check documents in and out of?',
        evidenceKey: 'bluebeam.studio.kind',
        outcomes: [
          { whenAnswer: 'session', cause: 'permissions', confidenceDelta: 10, note: 'Session access is usually invitation or permission based.' },
          { whenAnswer: 'project', cause: 'permissions', confidenceDelta: 10, note: 'Project access and checkout state are permission driven.' }
        ]
      },
      {
        question: 'Are other people on your team able to open the same session or project right now?',
        evidenceKey: 'bluebeam.studio.othersAffected',
        outcomes: [
          { whenAnswer: 'no_others_fine', cause: 'permissions', confidenceDelta: 25, note: 'Only this account is blocked — permissions or invitation.' },
          { whenAnswer: 'yes_others_too', cause: 'service_outage', confidenceDelta: 25, note: 'Multiple members affected — Studio service side.' }
        ]
      },
      {
        question: 'Do you have markups on this drawing that have not uploaded yet?',
        evidenceKey: 'bluebeam.studio.pendingChanges',
        outcomes: [
          { whenAnswer: 'yes', cause: 'unknown_cause', confidenceDelta: -10, note: 'Unsynced work present — preserve before any action. This lowers confidence deliberately: no repair may proceed until the work is safe.' },
          { whenAnswer: 'no', cause: 'unknown_cause', confidenceDelta: 0, note: 'No pending work to protect.' }
        ]
      }
    ],
    candidateCauses: ['permissions', 'network', 'service_outage', 'm365_identity_access', 'unknown_cause'],
    employeeSafeActions: [
      'Confirm whether colleagues can access the same session or project.',
      'Check whether any markups are still pending upload.',
      'Sign out and back in to Studio once.'
    ],
    approvalRequiredActions: [],
    prohibitedActions: [
      'Forcing a check-in or discarding a checkout while unsynced markups exist.',
      'Deleting the local Studio cache before pending changes are confirmed uploaded.',
      'Removing or re-inviting Studio members (administrator only).'
    ],
    verificationSequence: verify('Confirm the employee can open the correct session or project and see their own markups.'),
    escalationConditions: [
      'Pending markups cannot be recovered.',
      'A checkout must be broken by an administrator.',
      'Studio-side outage suspected.'
    ],
    handoffFields: ['studio_kind', 'session_or_project_ref_redacted', 'others_affected', 'pending_changes', 'exact_message'],
    repairTimeMinutes: { min: 10, max: 40 },
    defaultPriority: 'high'
  },

  // ----------------------------------------------------------
  pdf_rendering: {
    key: 'pdf_rendering',
    label: 'PDF will not open, blank pages, or missing content',
    exampleStatements: [
      'This PDF is blank.',
      'The drawing will not open.',
      'Half the linework is missing.',
      'The text looks wrong on this sheet.'
    ],
    minimumEvidence: [
      'Whether other PDFs open correctly (the single most useful discriminator).',
      'Whether the file opens on another computer.',
      'How the PDF was produced — scanned, exported from CAD, or supplied by an architect.',
      'The file size and page count, since oversized plan sets behave differently.'
    ],
    branches: [
      {
        question: 'Does a different PDF open normally in Bluebeam right now?',
        evidenceKey: 'bluebeam.knownGoodWorks',
        outcomes: [
          { whenAnswer: 'yes', cause: 'file_specific', confidenceDelta: 30, note: 'Application healthy; this document is the problem.' },
          { whenAnswer: 'no', cause: 'application_defect', confidenceDelta: 25, note: 'All documents fail — application level.' }
        ]
      },
      {
        question: 'Does this same file open correctly on a colleague’s computer?',
        evidenceKey: 'bluebeam.reproducesOnOtherDevice',
        outcomes: [
          { whenAnswer: 'no_fails_there_too', cause: 'file_specific', confidenceDelta: 25, note: 'Problem travels with the file — likely generation defect or corruption.' },
          { whenAnswer: 'yes_works_there', cause: 'windows_endpoint', confidenceDelta: 20, note: 'File is fine; this computer or its copy is the problem.' }
        ]
      },
      {
        question: 'Is this a scanned drawing, or was it exported from CAD?',
        evidenceKey: 'bluebeam.pdf.origin',
        outcomes: [
          { whenAnswer: 'scanned', cause: 'file_specific', confidenceDelta: 10, note: 'Scanned sheets have no text layer; blank-looking search results are expected, not a defect.' },
          { whenAnswer: 'cad_export', cause: 'file_specific', confidenceDelta: 10, note: 'CAD exports can carry broken fonts or huge vector layers.' }
        ]
      }
    ],
    candidateCauses: ['file_specific', 'application_defect', 'windows_endpoint', 'unknown_cause'],
    employeeSafeActions: [
      'Open a different PDF to compare.',
      'Ask a colleague to open the same file.',
      'Open a local copy rather than the synced copy.',
      'Note the file size and page count.'
    ],
    approvalRequiredActions: [
      'Produce a repaired copy, leaving the original untouched.'
    ],
    prohibitedActions: [
      'Overwriting, flattening, or re-saving the original plan set — the original is evidence and often a contract document.',
      'Deleting the file as a troubleshooting step.'
    ],
    verificationSequence: verify('Confirm the employee can read and mark up the sheets they actually needed.'),
    escalationConditions: [
      'The file is corrupt and no clean copy exists.',
      'The issuing party must reissue the plan set.'
    ],
    handoffFields: ['file_specific_result', 'other_device_result', 'pdf_origin', 'file_size', 'page_count', 'exact_message'],
    repairTimeMinutes: { min: 5, max: 30 },
    defaultPriority: 'high'
  },

  // ----------------------------------------------------------
  printing_plotting: {
    key: 'printing_plotting',
    label: 'Printing and large-format plotting',
    exampleStatements: [
      'I cannot print this drawing.',
      'The plot came out the wrong size.',
      'The edges are cut off.',
      'It printed in black and white.'
    ],
    minimumEvidence: [
      'Which printer or plotter, and whether it is large format.',
      'Whether other applications can print to the same device.',
      'Whether the sheet size and the paper size actually match.',
      'Whether the output is wrong or absent — those are different faults.'
    ],
    branches: [
      {
        question: 'Can you print a test page from another application to the same printer?',
        evidenceKey: 'bluebeam.print.otherAppWorks',
        outcomes: [
          { whenAnswer: 'no', cause: 'printer_driver', confidenceDelta: 30, note: 'Not a Bluebeam problem — printer or driver path.' },
          { whenAnswer: 'yes', cause: 'application_defect', confidenceDelta: 15, note: 'Printing works generally; Bluebeam-side settings.' }
        ]
      },
      {
        question: 'Is the output the wrong size or clipped, rather than missing entirely?',
        evidenceKey: 'bluebeam.print.symptom',
        outcomes: [
          { whenAnswer: 'wrong_size_or_clipped', cause: 'user_training', confidenceDelta: 20, note: 'Usually page scaling or paper size selection rather than a fault.' },
          { whenAnswer: 'nothing_prints', cause: 'printer_driver', confidenceDelta: 20, note: 'No output at all points at the driver or queue.' }
        ]
      }
    ],
    candidateCauses: ['printer_driver', 'application_defect', 'user_training', 'network', 'unknown_cause'],
    employeeSafeActions: [
      'Print a test page from another application.',
      'Check the selected paper size against the sheet size.',
      'Print a single sheet rather than the whole set.'
    ],
    approvalRequiredActions: [
      'Change printer configuration or default settings.',
      'Print as image or flatten a copy — only when vector output has been shown to fail, and only on a copy.'
    ],
    prohibitedActions: [
      'Flattening or print-as-image on the ORIGINAL file.',
      'Installing or replacing printer drivers (technician only).'
    ],
    verificationSequence: verify('Confirm the employee has a correctly scaled, complete plot they can actually issue.'),
    escalationConditions: [
      'Driver replacement is required.',
      'The plotter itself is faulty or offline.'
    ],
    handoffFields: ['printer_name', 'large_format', 'other_app_print_result', 'sheet_size', 'paper_size', 'print_symptom'],
    repairTimeMinutes: { min: 10, max: 35 },
    defaultPriority: 'high'
  },

  // ----------------------------------------------------------
  measurement_scale: {
    key: 'measurement_scale',
    label: 'Measurements, scale, and calibration',
    exampleStatements: [
      'My measurements are wrong.',
      'The takeoff numbers are way off.',
      'The scale looks wrong on this sheet.',
      'Lengths are coming out double.'
    ],
    minimumEvidence: [
      'A known real-world dimension on the sheet to validate against.',
      'Whether the page is calibrated, and by whom.',
      'Whether other sheets in the same set measure correctly — sets often mix scales.',
      'The unit system in use.'
    ],
    branches: [
      {
        question: 'Is there a dimension printed on the drawing you can check against — a door width or a known bay spacing?',
        evidenceKey: 'bluebeam.measure.knownDimension',
        outcomes: [
          { whenAnswer: 'yes', cause: 'user_training', confidenceDelta: 15, note: 'A known dimension makes calibration verifiable rather than assumed.' },
          { whenAnswer: 'no', cause: 'unknown_cause', confidenceDelta: -15, note: 'Without a reference dimension no measurement conclusion is trustworthy.' }
        ]
      },
      {
        question: 'Do measurements on a different sheet in the same set come out correctly?',
        evidenceKey: 'bluebeam.measure.otherSheetsOk',
        outcomes: [
          { whenAnswer: 'yes', cause: 'user_training', confidenceDelta: 25, note: 'Per-page scale — this sheet needs its own calibration.' },
          { whenAnswer: 'no', cause: 'user_training', confidenceDelta: 15, note: 'Whole-set calibration or unit mismatch.' }
        ]
      }
    ],
    candidateCauses: ['user_training', 'file_specific', 'unknown_cause'],
    employeeSafeActions: [
      'Measure a known dimension and compare it against the printed value.',
      'Check the page calibration on the affected sheet.',
      'Compare against another sheet in the same set.',
      'Confirm the units in use.'
    ],
    approvalRequiredActions: [],
    prohibitedActions: [
      'Treating the scale label shown on a sheet as authoritative — plan sets are routinely rescaled when issued, and trusting the label is how takeoffs go wrong.',
      'Recalibrating a page that other people are actively taking off from without telling them.',
      'Changing stored measurements on a shared document without agreement.'
    ],
    verificationSequence: verify('Confirm a known dimension now measures correctly AND the employee’s takeoff totals look right to them.'),
    escalationConditions: [
      'The drawing has no usable reference dimension.',
      'The issued plan set is internally inconsistent and must be queried with the architect.'
    ],
    handoffFields: ['known_dimension', 'measured_value', 'expected_value', 'page_calibration', 'units', 'other_sheets_result'],
    repairTimeMinutes: { min: 5, max: 20 },
    defaultPriority: 'urgent'
  },

  // ----------------------------------------------------------
  markups_toolchest: {
    key: 'markups_toolchest',
    label: 'Markups, Tool Chest, and profiles',
    exampleStatements: [
      'My tools are gone.',
      'My markups are not showing.',
      'My Tool Chest is empty.',
      'My markups will not save.'
    ],
    minimumEvidence: [
      'Whether the tools are missing, or the profile that contains them is not loaded.',
      'Whether markups are absent or merely hidden by a layer or filter.',
      'Whether the document is read-only, which silently prevents saving.',
      'Whether a recoverable backup of the Tool Chest exists.'
    ],
    branches: [
      {
        question: 'Is your usual profile still selected in the top-right of Bluebeam?',
        evidenceKey: 'bluebeam.profile.loaded',
        outcomes: [
          { whenAnswer: 'no', cause: 'application_defect', confidenceDelta: 25, note: 'Profile not loaded — tools are almost certainly intact, not lost.' },
          { whenAnswer: 'yes', cause: 'application_defect', confidenceDelta: 10, note: 'Profile loaded but tool sets missing.' }
        ]
      },
      {
        question: 'When you try to save, does Bluebeam say the file is read-only?',
        evidenceKey: 'bluebeam.markups.readOnly',
        outcomes: [
          { whenAnswer: 'yes', cause: 'file_specific', confidenceDelta: 30, note: 'Read-only state, not a markup fault — usually sync or checkout.' },
          { whenAnswer: 'no', cause: 'application_defect', confidenceDelta: 10, note: 'Saving is failing for another reason.' }
        ]
      }
    ],
    candidateCauses: ['application_defect', 'file_specific', 'permissions', 'user_training', 'unknown_cause'],
    employeeSafeActions: [
      'Check which profile is selected.',
      'Check whether markups are hidden by a layer or filter.',
      'Check whether the document is read-only.',
      'Reopen Bluebeam once.'
    ],
    approvalRequiredActions: [
      'Restore a Tool Chest or profile from backup.',
      'Switch profile (reversible; original preserved).'
    ],
    prohibitedActions: [
      'Resetting or reinstalling before the Tool Chest, stamps, and custom columns are backed up — this is unrecoverable user work, often years of it.',
      'Deleting profile folders.'
    ],
    verificationSequence: verify('Confirm the employee’s own tool sets are present and their markups save successfully.'),
    escalationConditions: [
      'No Tool Chest backup exists and tools are genuinely lost.',
      'Profile corruption survives a clean test profile.'
    ],
    handoffFields: ['profile_name', 'toolchest_backup_exists', 'read_only_state', 'markups_visible', 'bluebeam_version'],
    repairTimeMinutes: { min: 10, max: 40 },
    defaultPriority: 'high'
  },

  // ----------------------------------------------------------
  ocr_search_overlay: {
    key: 'ocr_search_overlay',
    label: 'OCR, text search, hyperlinks, overlays, and slip-sheeting',
    exampleStatements: [
      'I cannot search this drawing.',
      'OCR is not working.',
      'The overlay does not line up.',
      'The sheet links are broken.'
    ],
    minimumEvidence: [
      'Whether the PDF is scanned or digitally generated — scanned sheets have no text layer at all.',
      'Whether OCR has actually been run on this document.',
      'For overlays, whether the two sheets share an alignment reference.',
      'Whether the edition in use includes the feature being attempted.'
    ],
    branches: [
      {
        question: 'Can you select any text on the sheet with the text tool, or does it behave like a picture?',
        evidenceKey: 'bluebeam.ocr.textSelectable',
        outcomes: [
          { whenAnswer: 'behaves_like_picture', cause: 'user_training', confidenceDelta: 25, note: 'Scanned sheet with no text layer. Search failing is expected behaviour, not a defect — OCR is the answer, not a repair.' },
          { whenAnswer: 'text_selectable', cause: 'application_defect', confidenceDelta: 15, note: 'Text layer exists but search is failing.' }
        ]
      },
      {
        question: 'Are the two drawings you are overlaying the same sheet size and orientation?',
        evidenceKey: 'bluebeam.overlay.sameGeometry',
        outcomes: [
          { whenAnswer: 'no', cause: 'user_training', confidenceDelta: 25, note: 'Overlay misalignment from differing geometry — needs alignment points, not a repair.' },
          { whenAnswer: 'yes', cause: 'application_defect', confidenceDelta: 10, note: 'Same geometry but misaligned.' }
        ]
      }
    ],
    candidateCauses: ['user_training', 'application_defect', 'file_specific', 'licensing', 'unknown_cause'],
    employeeSafeActions: [
      'Try selecting text to establish whether a text layer exists.',
      'Compare sheet size and orientation before overlaying.',
      'Run OCR on a copy.'
    ],
    approvalRequiredActions: [
      'Run OCR across a large plan set — this is time-consuming and changes the file, so it runs on a copy.'
    ],
    prohibitedActions: [
      'Running OCR over the original issued plan set in place.',
      'Presenting a capability limitation as a defect — if the edition or document simply cannot do it, say so.'
    ],
    verificationSequence: verify('Confirm the employee can find the sheets or content they were actually looking for.'),
    escalationConditions: [
      'The feature is not available in the licensed edition.',
      'OCR quality is too poor on the source scan to be useful.'
    ],
    handoffFields: ['pdf_origin', 'text_layer_present', 'ocr_attempted', 'overlay_geometry', 'edition'],
    repairTimeMinutes: { min: 10, max: 60 },
    defaultPriority: 'normal'
  },

  // ----------------------------------------------------------
  file_sync_locking: {
    key: 'file_sync_locking',
    label: 'SharePoint, OneDrive, read-only, and file locking',
    exampleStatements: [
      'The drawing opens read-only.',
      'It says someone else has it open.',
      'I cannot get into the SharePoint folder.',
      'There is a conflicting copy.'
    ],
    minimumEvidence: [
      'Whether the file is opened from SharePoint/OneDrive or a local folder.',
      'Whether OneDrive is currently syncing, paused, or in error.',
      'Whether the employee has unsynced local changes that must be preserved.',
      'Whether the employee has access to the folder at all, versus the file being locked.'
    ],
    branches: [
      {
        question: 'Are you opening this from a SharePoint or OneDrive folder, or from a folder on this computer?',
        evidenceKey: 'bluebeam.file.location',
        outcomes: [
          { whenAnswer: 'sharepoint_or_onedrive', cause: 'm365_identity_access', confidenceDelta: 20, note: 'Sync, checkout, or permission are all plausible.' },
          { whenAnswer: 'local', cause: 'file_specific', confidenceDelta: 20, note: 'Local file — sync and permissions are ruled out.' }
        ]
      },
      {
        question: 'Does a local copy of the same drawing open normally with full editing?',
        evidenceKey: 'bluebeam.localCopyWorks',
        outcomes: [
          { whenAnswer: 'yes', cause: 'm365_identity_access', confidenceDelta: 30, note: 'Confirms the file is fine; access or sync is the problem.' },
          { whenAnswer: 'no', cause: 'file_specific', confidenceDelta: 25, note: 'Fails locally too — the document itself.' }
        ]
      },
      {
        question: 'Do you have markups on this drawing that have not synced yet?',
        evidenceKey: 'bluebeam.pendingWork',
        outcomes: [
          { whenAnswer: 'yes', cause: 'unknown_cause', confidenceDelta: -20, note: 'Unsynced work present. No repair may proceed until it is preserved — this is a hard stop, not a caution.' },
          { whenAnswer: 'no', cause: 'unknown_cause', confidenceDelta: 0, note: 'Nothing pending to protect.' }
        ]
      }
    ],
    candidateCauses: ['m365_identity_access', 'permissions', 'file_specific', 'network', 'unknown_cause'],
    employeeSafeActions: [
      'Check the OneDrive sync status icon.',
      'Open a local copy to compare.',
      'Check whether the file is checked out to someone else.',
      'Save a copy of unsynced work to a safe local folder first.'
    ],
    approvalRequiredActions: [
      'Retry a failed sync.'
    ],
    prohibitedActions: [
      'Deleting a conflicting copy — conflicting copies frequently contain the only record of someone’s markups.',
      'Overwriting the server copy with a stale local copy.',
      'Breaking another person’s checkout (administrator only).',
      'Changing SharePoint permissions.'
    ],
    verificationSequence: verify('Confirm the employee can open the correct copy with editing enabled and their markups are intact.'),
    escalationConditions: [
      'A checkout must be broken by an administrator.',
      'SharePoint permissions must be changed.',
      'Conflicting copies must be reconciled by their authors.'
    ],
    handoffFields: ['file_location', 'sync_state', 'lock_state', 'pending_work', 'local_copy_result', 'permission_result'],
    repairTimeMinutes: { min: 10, max: 45 },
    defaultPriority: 'urgent'
  },

  // ----------------------------------------------------------
  profiles_settings: {
    key: 'profiles_settings',
    label: 'Profiles, preferences, and user-state recovery',
    exampleStatements: [
      'Bluebeam has forgotten all my settings.',
      'My workspace layout is gone.',
      'Everything reset after an update.'
    ],
    minimumEvidence: [
      'What specifically was lost — profile, Tool Chest, stamps, columns, or layout.',
      'When it was last known good.',
      'Whether a backup or a previous profile file still exists.',
      'Whether an update or a reinstall preceded the loss.'
    ],
    branches: [
      {
        question: 'What did you lose — your tool sets, your stamps, your column layout, or the whole workspace?',
        evidenceKey: 'bluebeam.settings.lostWhat',
        outcomes: [
          { whenAnswer: 'toolchest', cause: 'application_defect', confidenceDelta: 15, note: 'Tool Chest loss is usually recoverable from a profile file.' },
          { whenAnswer: 'whole_profile', cause: 'application_defect', confidenceDelta: 20, note: 'Whole-profile loss — check for a backup before anything else.' }
        ]
      },
      {
        question: 'Did this happen straight after a Bluebeam update or a reinstall?',
        evidenceKey: 'bluebeam.settings.afterUpdate',
        outcomes: [
          { whenAnswer: 'yes', cause: 'application_defect', confidenceDelta: 20, note: 'Update-related profile migration.' },
          { whenAnswer: 'no', cause: 'unknown_cause', confidenceDelta: -5, note: 'No obvious trigger — needs more evidence.' }
        ]
      }
    ],
    candidateCauses: ['application_defect', 'windows_endpoint', 'unknown_cause'],
    employeeSafeActions: [
      'Identify exactly what is missing.',
      'Check whether the old profile is still listed.',
      'Avoid recreating tools until recovery has been attempted.'
    ],
    approvalRequiredActions: [
      'Restore a profile or Tool Chest from backup.',
      'Reset the workspace layout only after settings are backed up.'
    ],
    prohibitedActions: [
      'Any reset or reinstall before a backup of the current state exists — a reset here destroys the very thing being recovered.',
      'Deleting profile folders to "start clean".'
    ],
    verificationSequence: verify('Confirm the employee’s own tools, stamps, and layout are back and usable on a real drawing.'),
    escalationConditions: [
      'No backup exists and the profile is unrecoverable.',
      'Roaming or deployed profile configuration must be changed.'
    ],
    handoffFields: ['lost_items', 'last_known_good', 'backup_exists', 'preceded_by_update', 'bluebeam_version'],
    repairTimeMinutes: { min: 15, max: 60 },
    defaultPriority: 'normal'
  }
};

export const BLUEBEAM_FAMILY_KEYS = Object.keys(BLUEBEAM_FAMILIES) as BluebeamFamilyKey[];

export function bluebeamFamily(key: BluebeamFamilyKey): BluebeamFamily {
  return BLUEBEAM_FAMILIES[key];
}
