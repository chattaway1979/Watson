// ============================================================
// Watson — H&R AI IT Agent : Knowledge Base + Mock Data Seeds
// ============================================================
import { db, uuid, nowIso, isSeeded, markSeeded, save } from '../store/db';
import { writeAudit } from './audit';
import type { KnowledgeArticle, MockM365User, MockDevice, TicketCategory } from './types';

type SeedArticle = {
  slug: string;
  title: string;
  category: TicketCategory;
  summary: string;
  tags: string[];
  body: string;
};

const ARTICLES: SeedArticle[] = [
  {
    slug: 'outlook-setup-iphone',
    title: 'Set up Outlook on iPhone',
    category: 'outlook',
    summary: 'Add your H&R Electric email to the Outlook app on an iPhone.',
    tags: ['outlook', 'iphone', 'mobile', 'email'],
    body: [
      '1. Install "Microsoft Outlook" from the App Store.',
      '2. Open Outlook and tap "Add Account".',
      '3. Enter your H&R email (first.last@hrelectriccompany.com).',
      '4. Enter your password when prompted.',
      '5. Approve the Microsoft Authenticator MFA prompt.',
      '6. Allow notifications so you receive new mail alerts.',
      'If sign-in loops, confirm MFA is set up (see Microsoft Authenticator article) and contact IT.'
    ].join('\n')
  },
  {
    slug: 'outlook-setup-android',
    title: 'Set up Outlook on Android',
    category: 'outlook',
    summary: 'Add your H&R Electric email to the Outlook app on an Android phone.',
    tags: ['outlook', 'android', 'mobile', 'email'],
    body: [
      '1. Install "Microsoft Outlook" from Google Play.',
      '2. Open Outlook and tap "Add Account".',
      '3. Enter your H&R email and tap Continue.',
      '4. Enter your password and approve the MFA prompt.',
      '5. Choose to sync Calendar and Contacts if desired.',
      'If the app cannot connect, check Wi-Fi/cellular and retry. Escalate to IT if MFA fails.'
    ].join('\n')
  },
  {
    slug: 'outlook-setup-windows',
    title: 'Set up Outlook on Windows',
    category: 'outlook',
    summary: 'Configure the Outlook desktop client on a Windows PC.',
    tags: ['outlook', 'windows', 'desktop', 'email'],
    body: [
      '1. Open Outlook (or the new Outlook for Windows).',
      '2. Enter your H&R email and click Connect.',
      '3. Sign in with your password and approve MFA.',
      '4. Wait for the mailbox to download (first sync can take several minutes).',
      '5. Confirm send/receive works by emailing yourself.',
      'If Outlook keeps asking for a password, restart the PC and confirm the M365 license is active (IT can check).'
    ].join('\n')
  },
  {
    slug: 'microsoft-authenticator-setup',
    title: 'Set up Microsoft Authenticator',
    category: 'password_mfa',
    summary: 'Register Microsoft Authenticator for secure multi-factor sign-in.',
    tags: ['mfa', 'authenticator', 'security', 'login'],
    body: [
      '1. Install "Microsoft Authenticator" on your phone.',
      '2. On a computer go to https://aka.ms/mfasetup and sign in.',
      '3. Choose "Add sign-in method" > "Authenticator app".',
      '4. In the app tap + > Work or school account > Scan QR code.',
      '5. Approve the test notification.',
      'Keep recovery options updated. If you get a new phone, re-register before wiping the old one.'
    ].join('\n')
  },
  {
    slug: 'onedrive-sync-troubleshooting',
    title: 'OneDrive sync troubleshooting',
    category: 'onedrive',
    summary: 'Fix common OneDrive sync problems on Windows.',
    tags: ['onedrive', 'sync', 'files'],
    body: [
      '1. Click the OneDrive cloud icon in the system tray and check for errors.',
      '2. If "Sign in" is shown, sign in with your H&R account.',
      '3. Pause and resume sync to nudge stuck files.',
      '4. Confirm you have free disk space (sync stops when the disk is full).',
      '5. Shorten very long file paths/names that block syncing.',
      'For "processing changes" that never finishes, restart OneDrive. Escalate if files are missing.'
    ].join('\n')
  },
  {
    slug: 'teams-camera-mic-troubleshooting',
    title: 'Teams camera and microphone troubleshooting',
    category: 'teams',
    summary: 'Resolve camera/mic problems in Microsoft Teams meetings.',
    tags: ['teams', 'camera', 'microphone', 'meeting'],
    body: [
      '1. In Teams go to Settings > Devices and select the correct camera/mic/speaker.',
      '2. Close other apps that may be using the camera (Zoom, browser tabs).',
      '3. Check Windows Settings > Privacy > Camera/Microphone and allow Teams.',
      '4. Unplug/replug external webcams and headsets.',
      '5. Restart Teams, then restart the PC if needed.',
      'If hardware is not detected at all, the device may need a driver update — create a ticket.'
    ].join('\n')
  },
  {
    slug: 'printer-troubleshooting',
    title: 'Printer troubleshooting',
    category: 'printer',
    summary: 'First steps for office and field printer/scanner problems.',
    tags: ['printer', 'scanner', 'office'],
    body: [
      '1. Check the printer is powered on and shows no error/paper-jam lights.',
      '2. Confirm you are connected to the office network/Wi-Fi.',
      '3. Open Settings > Printers & scanners and confirm the printer is listed and default.',
      '4. Remove and re-add the printer if it shows "offline".',
      '5. Restart the print spooler or the PC.',
      'For repeated jams or hardware faults, log a ticket with the printer location and model.'
    ].join('\n')
  },
  {
    slug: 'sharepoint-access-basics',
    title: 'SharePoint access basics',
    category: 'sharepoint_access',
    summary: 'How to reach H&R project sites and request access.',
    tags: ['sharepoint', 'access', 'files', 'projects'],
    body: [
      '1. Open the SharePoint site link shared by your manager or PM.',
      '2. Sign in with your H&R account and approve MFA.',
      '3. If you see "Access denied", use "Request access" and state the project/role.',
      '4. Site owners or IT approve access — this may require manager confirmation.',
      '5. Add frequently used sites to your favorites for quick access.',
      'Access changes to project sites are tracked. Never share documents externally without approval.'
    ].join('\n')
  },
  {
    slug: 'new-employee-it-onboarding-checklist',
    title: 'New employee IT onboarding checklist',
    category: 'onboarding',
    summary: 'IT setup checklist for a new H&R Electric hire.',
    tags: ['onboarding', 'new hire', 'checklist'],
    body: [
      '1. Create Microsoft 365 account (prepared, requires approval).',
      '2. Assign appropriate license (office vs field).',
      '3. Set up Microsoft Authenticator / MFA.',
      '4. Configure Outlook, Teams, OneDrive on assigned device.',
      '5. Grant SharePoint/project access for the role.',
      '6. Issue and enroll device (laptop/phone) in device management.',
      '7. Provide email signature and security awareness basics.',
      'Manager initiates; IT/admin approves all account, license, and device actions.'
    ].join('\n')
  },
  {
    slug: 'offboarding-it-checklist',
    title: 'Offboarding IT checklist',
    category: 'offboarding',
    summary: 'Controlled IT steps when an employee departs.',
    tags: ['offboarding', 'termination', 'security', 'checklist'],
    body: [
      '1. Confirm termination date, manager, and urgency.',
      '2. Plan account disable (NEVER automatic — owner/admin approval required).',
      '3. Review mailbox delegation and forwarding rules.',
      '4. Plan license removal and group/SharePoint access removal.',
      '5. Recover company device(s) and plan retire/wipe (approval required).',
      '6. Preserve data per retention policy before any removal.',
      'All critical offboarding actions are queued for owner/admin approval; nothing executes automatically in this system.'
    ].join('\n')
  },
  {
    slug: 'slow-windows-first-checks',
    title: 'Slow Windows computer first checks',
    category: 'device_slow',
    summary: 'Quick wins for a sluggish Windows PC before logging a ticket.',
    tags: ['slow', 'performance', 'windows', 'device'],
    body: [
      '1. Restart the PC (clears memory and pending updates).',
      '2. Close unused apps and browser tabs.',
      '3. Check free disk space — under ~10% free will slow the machine.',
      '4. Reduce startup apps via Task Manager > Startup.',
      '5. Confirm Windows Update is current (pending updates cause slowness).',
      'If the device is still slow after these checks, create a ticket and IT will review device status remotely.'
    ].join('\n')
  },
  {
    slug: 'lost-or-stolen-device-process',
    title: 'Lost or stolen device process',
    category: 'security',
    summary: 'What to do immediately if a company device is lost or stolen.',
    tags: ['security', 'lost', 'stolen', 'device', 'incident'],
    body: [
      '1. Report it to IT and your manager IMMEDIATELY — time matters.',
      '2. Note the device type, last known location, and what data it held.',
      '3. Change your H&R password from another trusted device.',
      '4. IT will plan a remote lock/wipe (approval required; never automatic here).',
      '5. File any required theft report with the appropriate authority.',
      'A high-priority security ticket should be created right away so IT can act quickly.'
    ].join('\n')
  },
  {
    slug: 'company-email-signature-setup',
    title: 'Company email signature setup',
    category: 'email_setup',
    summary: 'Set a consistent H&R Electric email signature in Outlook.',
    tags: ['email', 'signature', 'outlook', 'branding'],
    body: [
      '1. In Outlook go to File > Options > Mail > Signatures (or Settings in new Outlook).',
      '2. Create a new signature named "H&R".',
      '3. Include: Full name, Title, H&R Electric Company, phone, and email.',
      '4. Keep formatting simple and professional; avoid large images.',
      '5. Set it as default for New messages and Replies.',
      'Ask your manager for the approved signature template if your team has one.'
    ].join('\n')
  },
  {
    slug: 'approved-software-request-process',
    title: 'Approved software request process',
    category: 'software_install',
    summary: 'How to request installation of approved software.',
    tags: ['software', 'install', 'request', 'approval'],
    body: [
      '1. Check whether the software is already available in your company portal.',
      '2. If not, create a software install ticket with the app name and business reason.',
      '3. IT reviews the request against the approved software list and licensing.',
      '4. Installation is prepared and queued for approval (high-risk action).',
      '5. Once approved, IT performs the (future) controlled install.',
      'Do not install software from unknown sources. All installs are tracked and approved.'
    ].join('\n')
  }
];

const MOCK_USERS: Omit<MockM365User, 'id'>[] = [
  {
    email: 'sarah.office@hrelectriccompany.com',
    displayName: 'Sarah Office',
    jobTitle: 'Office Administrator',
    department: 'Administration',
    accountEnabled: true,
    licenses: ['Microsoft 365 Business Premium'],
    mfaEnabled: true,
    mfaMethods: ['Microsoft Authenticator'],
    mailboxType: 'user',
    mailboxSizeGb: 12.4,
    mailboxQuotaGb: 50,
    groups: ['All Staff', 'Office', 'SharePoint-Admin-Read'],
    lastSignIn: '2026-06-25T14:02:00.000Z'
  },
  {
    email: 'mike.pm@hrelectriccompany.com',
    displayName: 'Mike Rivera',
    jobTitle: 'Project Manager',
    department: 'Operations',
    accountEnabled: true,
    licenses: ['Microsoft 365 Business Premium', 'Project Plan 3'],
    mfaEnabled: true,
    mfaMethods: ['Microsoft Authenticator', 'Phone'],
    mailboxType: 'user',
    mailboxSizeGb: 28.1,
    mailboxQuotaGb: 50,
    groups: ['All Staff', 'Project Managers', 'SharePoint-Projects'],
    lastSignIn: '2026-06-26T08:15:00.000Z'
  },
  {
    email: 'dana.est@hrelectriccompany.com',
    displayName: 'Dana Cole',
    jobTitle: 'Estimator',
    department: 'Estimating',
    accountEnabled: true,
    licenses: ['Microsoft 365 Business Standard'],
    mfaEnabled: false,
    mfaMethods: [],
    mailboxType: 'user',
    mailboxSizeGb: 9.7,
    mailboxQuotaGb: 50,
    groups: ['All Staff', 'Estimating'],
    lastSignIn: '2026-06-24T17:40:00.000Z'
  },
  {
    email: 'carlos.field@hrelectriccompany.com',
    displayName: 'Carlos Field',
    jobTitle: 'Field Electrician',
    department: 'Field',
    accountEnabled: true,
    licenses: ['Microsoft 365 F3'],
    mfaEnabled: true,
    mfaMethods: ['Microsoft Authenticator'],
    mailboxType: 'user',
    mailboxSizeGb: 1.2,
    mailboxQuotaGb: 2,
    groups: ['All Staff', 'Field'],
    lastSignIn: '2026-06-26T06:55:00.000Z'
  },
  {
    email: 'admin.it@hrelectriccompany.com',
    displayName: 'Watson Admin',
    jobTitle: 'IT Administrator',
    department: 'IT',
    accountEnabled: true,
    licenses: ['Microsoft 365 Business Premium'],
    mfaEnabled: true,
    mfaMethods: ['Microsoft Authenticator', 'FIDO2 Key'],
    mailboxType: 'user',
    mailboxSizeGb: 5.3,
    mailboxQuotaGb: 50,
    groups: ['All Staff', 'IT', 'Privileged-Admins'],
    lastSignIn: '2026-06-26T09:30:00.000Z'
  },
  {
    email: 'projects.shared@hrelectriccompany.com',
    displayName: 'Projects Shared Mailbox',
    jobTitle: 'Shared Mailbox',
    department: 'Operations',
    accountEnabled: true,
    licenses: [],
    mfaEnabled: false,
    mfaMethods: [],
    mailboxType: 'shared',
    mailboxSizeGb: 34.0,
    mailboxQuotaGb: 50,
    groups: ['Projects-Mailbox-Access'],
    lastSignIn: '2026-06-20T12:00:00.000Z'
  }
];

const MOCK_DEVICES: Omit<MockDevice, 'id'>[] = [
  {
    ownerEmail: 'sarah.office@hrelectriccompany.com',
    deviceName: 'HRE-OFFICE-01',
    os: 'Windows',
    osVersion: '11 23H2',
    serialNumber: 'SN-OFF-44821',
    lastCheckIn: '2026-06-26T08:50:00.000Z',
    diskFreeGb: 180,
    diskTotalGb: 512,
    antivirusStatus: 'healthy',
    patchStatus: 'up_to_date',
    complianceStatus: 'compliant',
    remoteSupportAvailable: true,
    managedBy: 'intune_mock'
  },
  {
    ownerEmail: 'mike.pm@hrelectriccompany.com',
    deviceName: 'HRE-PM-07',
    os: 'Windows',
    osVersion: '11 22H2',
    serialNumber: 'SN-PM-91002',
    lastCheckIn: '2026-06-26T07:30:00.000Z',
    diskFreeGb: 42,
    diskTotalGb: 512,
    antivirusStatus: 'healthy',
    patchStatus: 'pending',
    complianceStatus: 'in_grace',
    remoteSupportAvailable: true,
    managedBy: 'ninjaone_mock'
  },
  {
    ownerEmail: 'dana.est@hrelectriccompany.com',
    deviceName: 'HRE-EST-03',
    os: 'Windows',
    osVersion: '10 22H2',
    serialNumber: 'SN-EST-22310',
    lastCheckIn: '2026-06-22T16:10:00.000Z',
    diskFreeGb: 18,
    diskTotalGb: 256,
    antivirusStatus: 'out_of_date',
    patchStatus: 'behind',
    complianceStatus: 'non_compliant',
    remoteSupportAvailable: true,
    managedBy: 'atera_mock'
  },
  {
    ownerEmail: 'carlos.field@hrelectriccompany.com',
    deviceName: 'HRE-FIELD-12',
    os: 'iOS',
    osVersion: '17.5',
    serialNumber: 'SN-FLD-77451',
    lastCheckIn: '2026-06-26T06:50:00.000Z',
    diskFreeGb: 33,
    diskTotalGb: 128,
    antivirusStatus: 'healthy',
    patchStatus: 'up_to_date',
    complianceStatus: 'compliant',
    remoteSupportAvailable: false,
    managedBy: 'intune_mock'
  }
];

export function seedAll(force = false): { articles: number; users: number; devices: number } {
  const d = db();
  if (isSeeded() && !force && d.knowledge.length > 0) {
    return { articles: d.knowledge.length, users: d.mockUsers.length, devices: d.mockDevices.length };
  }
  if (d.knowledge.length === 0) {
    for (const a of ARTICLES) {
      const article: KnowledgeArticle = {
        id: uuid(),
        slug: a.slug,
        title: a.title,
        category: a.category,
        summary: a.summary,
        body: a.body,
        tags: a.tags,
        visibility: a.category === 'offboarding' || a.category === 'security' ? 'internal' : 'public',
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      d.knowledge.push(article);
      writeAudit({
        actorType: 'system',
        actorId: 'seed',
        action: 'knowledge_article_created',
        targetType: 'knowledge_article',
        targetId: article.slug,
        metadata: { seeded: true }
      });
    }
  }
  if (d.mockUsers.length === 0) {
    for (const u of MOCK_USERS) d.mockUsers.push({ id: uuid(), ...u });
  }
  if (d.mockDevices.length === 0) {
    for (const dev of MOCK_DEVICES) d.mockDevices.push({ id: uuid(), ...dev });
  }
  markSeeded();
  return { articles: d.knowledge.length, users: d.mockUsers.length, devices: d.mockDevices.length };
}

// Ensure a deterministic, HEALTHY mock M365 profile + managed device exists for a
// given employee email. Used so the mock employee experience works for any
// authenticated pilot user (whose real email is not in the fixed seed set) —
// otherwise every scenario escalates because the account "isn't found". This adds
// MOCK data only (read by the mock connector); it is inert in live mode. Idempotent.
export function ensureMockIdentity(email: string | undefined, displayName?: string): void {
  const e = (email ?? '').trim().toLowerCase();
  if (!e || !e.includes('@')) return;
  const d = db();
  if (!d.mockUsers.some((u) => u.email.toLowerCase() === e)) {
    const user: Omit<MockM365User, 'id'> = {
      email: e,
      displayName: displayName?.trim() || e.split('@')[0],
      jobTitle: 'Employee',
      department: 'H&R Electric',
      accountEnabled: true,
      licenses: ['Microsoft 365 Business Premium'],
      mfaEnabled: true,
      mfaMethods: ['Microsoft Authenticator'],
      mailboxType: 'user',
      mailboxSizeGb: 8.2,
      mailboxQuotaGb: 50,
      groups: ['All Staff'],
      lastSignIn: '2026-06-26T09:00:00.000Z'
    };
    d.mockUsers.push({ id: uuid(), ...user });
  }
  if (!d.mockDevices.some((dev) => dev.ownerEmail.toLowerCase() === e)) {
    const device: Omit<MockDevice, 'id'> = {
      ownerEmail: e,
      deviceName: 'HRE-PILOT-01',
      os: 'Windows',
      osVersion: '11 23H2',
      serialNumber: 'SN-PILOT-0001',
      lastCheckIn: '2026-06-26T09:00:00.000Z',
      diskFreeGb: 120,
      diskTotalGb: 512,
      antivirusStatus: 'healthy',
      patchStatus: 'up_to_date',
      complianceStatus: 'compliant',
      remoteSupportAvailable: true,
      managedBy: 'intune_mock'
    };
    d.mockDevices.push({ id: uuid(), ...device });
  }
  save();
}
