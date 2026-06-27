// ============================================================
// Watson — H&R AI IT Agent : Troubleshooting Plan Library
// ------------------------------------------------------------
// Deterministic per-category plans: likely causes, first checks,
// steps, escalation guidance, recommended (safe) actions, and
// related KB article slugs. No external calls.
// ============================================================
import type { TicketCategory, Priority, TroubleshootingPlan, RecommendedAction } from './types';

function rec(actionKey: string, displayName: string, riskLevel: RecommendedAction['riskLevel'], requiresApproval: boolean, rationale: string): RecommendedAction {
  return { actionKey, displayName, riskLevel, requiresApproval, rationale };
}

type PlanSeed = Omit<TroubleshootingPlan, 'category' | 'priority'>;

const PLANS: Record<TicketCategory, PlanSeed> = {
  outlook: {
    likelyCauses: ['No internet/VPN', 'Expired session or password', 'Mailbox near quota', 'License lapsed', 'Corrupt Outlook profile'],
    firstChecks: ['Confirm internet connection', 'Confirm login works at office.com in a browser'],
    steps: [
      'Confirm internet connection.',
      'Confirm Microsoft 365 login works in a browser at office.com.',
      'Restart Outlook.',
      'Check mailbox storage status (Watson can check mock connector).',
      'Check license status (Watson can check mock connector).',
      'For mobile setup, follow the iPhone/Android Outlook article.',
      'If unresolved, create a ticket and recommend an admin mailbox/license lookup.'
    ],
    whenToEscalate: 'Escalate if login works in browser but desktop Outlook still fails, or if mailbox is over quota.',
    recommendedActions: [
      rec('check_mailbox_status', 'Check Mailbox Status', 'medium', false, 'Verify mailbox is not over quota.'),
      rec('check_license_status', 'Check License Status', 'medium', false, 'Confirm an active M365 license.'),
      rec('send_setup_instructions', 'Send Outlook Setup Article', 'low', false, 'Guide mobile/desktop setup.')
    ],
    relatedArticleSlugs: ['outlook-setup-windows', 'outlook-setup-iphone', 'outlook-setup-android']
  },
  email_setup: {
    likelyCauses: ['New device', 'Missing signature', 'Wrong account added'],
    firstChecks: ['Confirm which device', 'Confirm correct H&R email address'],
    steps: [
      'Confirm the device (iPhone / Android / Windows).',
      'Add the H&R account in the Outlook app.',
      'Approve MFA when prompted.',
      'Set up the company email signature.',
      'Create a ticket if sign-in fails repeatedly.'
    ],
    whenToEscalate: 'Escalate if the account cannot be added after MFA approval.',
    recommendedActions: [
      rec('send_setup_instructions', 'Send Email Setup Article', 'low', false, 'Share device-specific setup steps.')
    ],
    relatedArticleSlugs: ['outlook-setup-iphone', 'outlook-setup-android', 'outlook-setup-windows', 'company-email-signature-setup']
  },
  teams: {
    likelyCauses: ['Wrong device selected', 'OS privacy blocking camera/mic', 'Another app using the device', 'Driver issue'],
    firstChecks: ['Check Teams device settings', 'Check OS camera/mic privacy permissions'],
    steps: [
      'In Teams, open Settings > Devices and select the right camera/mic/speaker.',
      'Close other apps using the camera.',
      'Allow Teams in OS privacy settings.',
      'Reconnect external webcam/headset.',
      'Restart Teams, then the PC.',
      'Create a ticket if hardware is not detected at all.'
    ],
    whenToEscalate: 'Escalate if the device is not detected after a restart (possible driver/hardware fault).',
    recommendedActions: [
      rec('send_setup_instructions', 'Send Teams A/V Article', 'low', false, 'Share camera/mic troubleshooting.'),
      rec('lookup_device', 'Lookup Device', 'medium', false, 'Check device for driver/compliance issues.')
    ],
    relatedArticleSlugs: ['teams-camera-mic-troubleshooting']
  },
  onedrive: {
    likelyCauses: ['Not signed in', 'Disk full', 'Long file paths', 'Stuck sync queue'],
    firstChecks: ['Check OneDrive tray icon for errors', 'Confirm free disk space'],
    steps: [
      'Open the OneDrive icon and check for errors.',
      'Sign in if prompted.',
      'Pause and resume sync.',
      'Free disk space if low.',
      'Shorten long file names/paths.',
      'Restart OneDrive; create a ticket if files are missing.'
    ],
    whenToEscalate: 'Escalate if files are missing or sync never completes after a restart.',
    recommendedActions: [
      rec('send_setup_instructions', 'Send OneDrive Article', 'low', false, 'Share sync troubleshooting.'),
      rec('lookup_device', 'Lookup Device', 'medium', false, 'Check device disk space/status.')
    ],
    relatedArticleSlugs: ['onedrive-sync-troubleshooting']
  },
  sharepoint_access: {
    likelyCauses: ['No access granted', 'Wrong account', 'Site moved'],
    firstChecks: ['Confirm signed in with H&R account', 'Confirm correct site link'],
    steps: [
      'Open the SharePoint site link.',
      'Sign in with the H&R account and approve MFA.',
      'If access denied, use Request access stating project/role.',
      'Manager/site owner or IT approves access.',
      'Create a ticket if access is urgent for a project.'
    ],
    whenToEscalate: 'Escalate if a project deadline is blocked by missing access.',
    recommendedActions: [
      rec('check_group_membership', 'Check Group Membership', 'medium', false, 'Verify the user is in the right access group.'),
      rec('send_setup_instructions', 'Send SharePoint Article', 'low', false, 'Share access basics.')
    ],
    relatedArticleSlugs: ['sharepoint-access-basics']
  },
  password_mfa: {
    likelyCauses: ['Forgotten password', 'Account lockout', 'New phone / lost authenticator', 'MFA method removed'],
    firstChecks: ['Determine: password vs MFA vs lockout vs lost device', 'Confirm identity per policy'],
    steps: [
      'Determine whether this is a password issue, MFA issue, lockout, or lost MFA device.',
      'Do NOT reset anything automatically.',
      'Check mock account/MFA status (admin).',
      'Prepare a password or MFA reset request — this creates an approval, it does not execute.',
      'Escalate to admin for the approval decision.'
    ],
    whenToEscalate: 'Always route resets through approval. Escalate immediately if the account may be compromised.',
    recommendedActions: [
      rec('check_mfa_status', 'Check MFA Status', 'medium', false, 'See current MFA enrollment/methods.'),
      rec('prepare_password_reset', 'Prepare Password Reset', 'high', true, 'Queue a password reset for admin approval.'),
      rec('prepare_mfa_reset', 'Prepare MFA Reset', 'high', true, 'Queue an MFA reset for admin approval.'),
      rec('send_setup_instructions', 'Send Authenticator Article', 'low', false, 'Help re-register Authenticator.')
    ],
    relatedArticleSlugs: ['microsoft-authenticator-setup']
  },
  printer: {
    likelyCauses: ['Printer offline', 'Not on office network', 'Driver/spooler issue', 'Paper jam'],
    firstChecks: ['Confirm printer power and error lights', 'Confirm network connection'],
    steps: [
      'Check the printer is on with no error lights.',
      'Confirm you are on the office network/Wi-Fi.',
      'Confirm the printer is listed and set as default.',
      'Remove and re-add the printer if offline.',
      'Restart the print spooler or PC.',
      'Create a ticket with printer location/model for hardware faults.'
    ],
    whenToEscalate: 'Escalate for repeated jams or hardware faults.',
    recommendedActions: [
      rec('send_setup_instructions', 'Send Printer Article', 'low', false, 'Share printer troubleshooting.')
    ],
    relatedArticleSlugs: ['printer-troubleshooting']
  },
  network: {
    likelyCauses: ['Wi-Fi down', 'VPN not connected', 'ISP outage', 'Cached network config'],
    firstChecks: ['Check Wi-Fi connection', 'Check VPN status', 'Check if others are affected'],
    steps: [
      'Confirm Wi-Fi/cellular is connected.',
      'Reconnect VPN if used.',
      'Restart the device network adapter or the device.',
      'Check whether colleagues are also affected (possible outage).',
      'Create a high-priority ticket if multiple users are down.'
    ],
    whenToEscalate: 'Escalate immediately if multiple users or a whole site is offline.',
    recommendedActions: [
      rec('lookup_device', 'Lookup Device', 'medium', false, 'Check device last check-in/compliance.')
    ],
    relatedArticleSlugs: []
  },
  device_slow: {
    likelyCauses: ['Low disk space', 'Too many startup apps', 'Pending updates', 'Aging hardware'],
    firstChecks: ['Ask device name if missing', 'Check disk space, patch status, last check-in (mock)'],
    steps: [
      'Ask for the device name if not provided.',
      'Check mock device status (disk, patch, last check-in).',
      'Restart the device.',
      'Reduce startup apps and free disk space.',
      'Confirm Windows Update is current.',
      'Create a ticket if the device status is degraded or the issue repeats.'
    ],
    whenToEscalate: 'Escalate if device status is degraded (low disk / non-compliant / very old patches).',
    recommendedActions: [
      rec('lookup_device', 'Lookup Device', 'medium', false, 'Find the device for this user.'),
      rec('check_device_status', 'Check Device Status', 'medium', false, 'Inspect disk/patch/compliance.'),
      rec('collect_device_diagnostics_mock', 'Collect Diagnostics (Mock)', 'medium', false, 'Gather a mock diagnostics bundle.')
    ],
    relatedArticleSlugs: ['slow-windows-first-checks']
  },
  device_access: {
    likelyCauses: ['Forgotten PIN', 'BitLocker/lock screen', 'Account disabled', 'Compliance lock'],
    firstChecks: ['Confirm exactly what fails (PIN, password, lock screen)', 'Check mock device/account status'],
    steps: [
      'Confirm what the user is locked out of (PIN, password, device).',
      'Check mock account status and device compliance.',
      'If account/password related, route to password/MFA flow (approval required).',
      'Escalate to admin; never unlock automatically.'
    ],
    whenToEscalate: 'Escalate to admin; device unlock and account changes always require approval.',
    recommendedActions: [
      rec('lookup_user', 'Lookup User', 'medium', false, 'Confirm the account is enabled.'),
      rec('lookup_device', 'Lookup Device', 'medium', false, 'Check device compliance/lock state.'),
      rec('prepare_password_reset', 'Prepare Password Reset', 'high', true, 'Queue reset if account-related.')
    ],
    relatedArticleSlugs: []
  },
  software_install: {
    likelyCauses: ['App not in portal', 'License needed', 'Not approved software'],
    firstChecks: ['Check the company portal', 'Confirm business justification'],
    steps: [
      'Check whether the software is already in the company portal.',
      'If not, capture the app name and business reason.',
      'Prepare a software install request — this queues an approval, it does not install.',
      'Admin reviews against the approved software list.',
      'On approval, IT performs the (future) controlled install.'
    ],
    whenToEscalate: 'Escalate if the software is needed for an active project.',
    recommendedActions: [
      rec('prepare_software_install', 'Prepare Software Install', 'high', true, 'Queue an approved-software install for approval.'),
      rec('send_setup_instructions', 'Send Software Request Article', 'low', false, 'Explain the request process.')
    ],
    relatedArticleSlugs: ['approved-software-request-process']
  },
  onboarding: {
    likelyCauses: ['New hire needs accounts/licenses/device'],
    firstChecks: ['Confirm name, start date, role, manager, required software'],
    steps: [
      'Confirm employee name, start date, role, manager, and required software.',
      'Prepare a new-user checklist.',
      'Prepare the Microsoft 365 account creation request (approval required).',
      'Prepare the license assignment request (approval required).',
      'Prepare the device request.',
      'Require admin approval before any actual user/license/device action.'
    ],
    whenToEscalate: 'Manager initiates; admin approves all account/license/device actions before anything executes.',
    recommendedActions: [
      rec('prepare_onboarding_checklist', 'Prepare Onboarding Checklist', 'high', true, 'Assemble onboarding requests for approval.'),
      rec('prepare_new_user', 'Prepare New User', 'high', true, 'Queue M365 account creation for approval.'),
      rec('prepare_license_assignment', 'Prepare License Assignment', 'high', true, 'Queue license assignment for approval.')
    ],
    relatedArticleSlugs: ['new-employee-it-onboarding-checklist']
  },
  offboarding: {
    likelyCauses: ['Employee departing; access must be controlled'],
    firstChecks: ['Confirm name, termination date, manager, urgency'],
    steps: [
      'Confirm employee name, termination date, manager, and urgency.',
      'Prepare an access disable request (NEVER automatic).',
      'Prepare mailbox delegation/forwarding review.',
      'Prepare a device recovery checklist.',
      'Require owner/admin approval before any critical action.',
      'Never disable accounts automatically in this build.'
    ],
    whenToEscalate: 'All critical offboarding actions require owner/admin approval; nothing executes automatically.',
    recommendedActions: [
      rec('prepare_offboarding_checklist', 'Prepare Offboarding Checklist', 'critical', true, 'Assemble offboarding plan for owner/admin approval.'),
      rec('offboarding_access_shutdown', 'Offboarding Access Shutdown', 'critical', true, 'Queue access shutdown (live disabled).')
    ],
    relatedArticleSlugs: ['offboarding-it-checklist']
  },
  security: {
    likelyCauses: ['Lost/stolen device', 'Phishing', 'Possible account compromise'],
    firstChecks: ['Confirm what happened and when', 'Confirm what data/device is involved'],
    steps: [
      'Treat as urgent: report to IT and manager immediately.',
      'Capture device type, last location, and data at risk.',
      'Have the user change their password from a trusted device.',
      'Prepare a remote lock/wipe request (approval required; never automatic).',
      'Create a high-priority security ticket immediately.'
    ],
    whenToEscalate: 'Escalate immediately — security incidents are time-sensitive.',
    recommendedActions: [
      rec('lookup_user', 'Lookup User', 'medium', false, 'Confirm account state.'),
      rec('lookup_device', 'Lookup Device', 'medium', false, 'Locate the affected device.'),
      rec('prepare_mfa_reset', 'Prepare MFA Reset', 'high', true, 'Queue MFA reset if compromise suspected.'),
      rec('wipe_device', 'Wipe Device', 'critical', true, 'Queue device wipe (live disabled).')
    ],
    relatedArticleSlugs: ['lost-or-stolen-device-process']
  },
  other: {
    likelyCauses: ['Unclear / needs human triage'],
    firstChecks: ['Gather more detail from the employee'],
    steps: [
      'Ask the employee for more detail (what, when, which device/app).',
      'Search the knowledge base for related articles.',
      'Create a ticket so an admin can review.'
    ],
    whenToEscalate: 'Escalate to admin when the category is unclear.',
    recommendedActions: [
      rec('search_knowledge_base', 'Search Knowledge Base', 'low', false, 'Look for related guidance.'),
      rec('create_ticket', 'Create Ticket', 'low', false, 'Log for admin review.')
    ],
    relatedArticleSlugs: []
  }
};

export function buildTroubleshootingPlan(category: TicketCategory, priority: Priority): TroubleshootingPlan {
  const seed = PLANS[category] ?? PLANS.other;
  return { category, priority, ...seed };
}
