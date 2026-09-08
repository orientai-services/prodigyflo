import type { RoleKey } from '@prisma/client'

/**
 * Permission catalog. Every server-side guard references one of these keys.
 * Roles map to permission sets below; the mapping is seeded into the database
 * (Role -> RolePermission -> Permission) so admins can adjust it per org.
 */
export const PERMISSIONS = {
  // Organization & administration
  'org:manage': { category: 'Administration', description: 'Manage organization settings' },
  'org:view_audit': { category: 'Administration', description: 'View the audit log' },
  'users:read': { category: 'Administration', description: 'View users' },
  'users:manage': { category: 'Administration', description: 'Create, edit, and deactivate users' },
  'roles:manage': { category: 'Administration', description: 'Edit roles and permissions' },
  'connectors:read': { category: 'Administration', description: 'View integration connectors' },
  'connectors:manage': { category: 'Administration', description: 'Configure integration connectors' },
  'telephony:read': { category: 'Administration', description: 'View phone numbers and the telephony wallet' },
  'telephony:manage': { category: 'Administration', description: 'Buy, configure, and release phone numbers' },

  // Pipeline configuration
  'pipeline:configure': { category: 'Configuration', description: 'Edit pipeline stages and gates' },
  'documents:configure': { category: 'Configuration', description: 'Edit document packages and requirements' },
  'qualification:configure': { category: 'Configuration', description: 'Edit qualification rules' },
  'assignment:configure': { category: 'Configuration', description: 'Edit closer assignment rules' },

  // Clients
  'clients:read_all': { category: 'Clients', description: 'View every client in the organization' },
  'clients:read_region': { category: 'Clients', description: 'View clients in own region' },
  'clients:read_team': { category: 'Clients', description: 'View clients on own team' },
  'clients:read_assigned': { category: 'Clients', description: 'View clients assigned to self' },
  'clients:create': { category: 'Clients', description: 'Create clients' },
  'clients:update': { category: 'Clients', description: 'Edit client records' },
  'clients:delete': { category: 'Clients', description: 'Delete client records' },
  'clients:reassign': { category: 'Clients', description: 'Reassign a client to another closer' },
  'clients:advance_stage': { category: 'Clients', description: 'Move a client between pipeline stages' },

  // Sensitive data
  'credit:request': { category: 'Sensitive', description: 'Initiate a soft credit pull' },
  'credit:read': { category: 'Sensitive', description: 'View credit summary data' },
  'qualification:review': { category: 'Sensitive', description: 'Record a qualification decision' },
  'payment:read': { category: 'Sensitive', description: 'View payment and financing status' },
  'payment:manage': { category: 'Sensitive', description: 'Record payment and financing selections' },

  // Documents
  'documents:read': { category: 'Documents', description: 'View client documents' },
  'documents:request': { category: 'Documents', description: 'Request documents from a client' },
  'documents:upload': { category: 'Documents', description: 'Upload documents' },
  'documents:review': { category: 'Documents', description: 'Approve or reject documents' },
  'documents:assign_collector': { category: 'Documents', description: 'Assign an outsourced document collector' },

  // Communications
  'communications:read': { category: 'Communications', description: 'View the communication timeline' },
  'communications:send': { category: 'Communications', description: 'Send messages and place calls' },
  'communications:read_internal': { category: 'Communications', description: 'View internal-only notes' },

  // Scheduling
  'appointments:read': { category: 'Scheduling', description: 'View appointments' },
  'appointments:manage': { category: 'Scheduling', description: 'Schedule, reschedule, and cancel appointments' },
  'presentations:manage': { category: 'Scheduling', description: 'Record presentations and follow-ups' },

  // Submission
  'submissions:read': { category: 'Submission', description: 'View deal submissions' },
  'submissions:prepare': { category: 'Submission', description: 'Assemble a submission package' },
  'submissions:approve': { category: 'Submission', description: 'Approve and send a submission' },

  // Analytics
  'analytics:org': { category: 'Analytics', description: 'View organization-wide analytics' },
  'analytics:region': { category: 'Analytics', description: 'View regional analytics' },
  'analytics:team': { category: 'Analytics', description: 'View team analytics' },
  'analytics:self': { category: 'Analytics', description: 'View own performance' },
  'analytics:marketing': { category: 'Analytics', description: 'View marketing, funnel, and attribution analytics' },

  // AI
  'ai:run': { category: 'AI', description: 'Run AI analysis on a client' },
  'ai:review': { category: 'AI', description: 'Accept or override an AI recommendation' },

  // Client portal (the client's own record only)
  'portal:self': { category: 'Portal', description: 'Access own client portal' },
} as const

export type PermissionKey = keyof typeof PERMISSIONS

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[]

const CLOSER_PERMISSIONS: PermissionKey[] = [
  'clients:read_assigned',
  'clients:update',
  'clients:advance_stage',
  'credit:read',
  'payment:read',
  'payment:manage',
  'documents:read',
  'documents:request',
  'documents:upload',
  'communications:read',
  'communications:send',
  'communications:read_internal',
  'appointments:read',
  'appointments:manage',
  'presentations:manage',
  'submissions:read',
  'submissions:prepare',
  'analytics:self',
  'ai:run',
]

const SALES_MANAGER_PERMISSIONS: PermissionKey[] = [
  ...CLOSER_PERMISSIONS,
  'clients:read_team',
  'clients:create',
  'clients:reassign',
  'users:read',
  'analytics:team',
  'ai:review',
  'qualification:review',
  'documents:review',
  'documents:assign_collector',
  // Read-only on purpose: a manager should know which line their team calls
  // from without being able to spend the account's balance.
  'telephony:read',
]

const REGIONAL_MANAGER_PERMISSIONS: PermissionKey[] = [
  ...SALES_MANAGER_PERMISSIONS,
  'clients:read_region',
  'analytics:region',
  'credit:request',
]

const ADMIN_PERMISSIONS: PermissionKey[] = [
  ...REGIONAL_MANAGER_PERMISSIONS,
  'clients:read_all',
  'clients:delete',
  'org:view_audit',
  'users:manage',
  'connectors:read',
  'connectors:manage',
  'telephony:manage',
  'pipeline:configure',
  'documents:configure',
  'qualification:configure',
  'assignment:configure',
  'submissions:approve',
  'analytics:org',
  'analytics:marketing',
]

const DOCUMENT_COLLECTOR_PERMISSIONS: PermissionKey[] = [
  'clients:read_assigned',
  'documents:read',
  'documents:request',
  'documents:upload',
  'communications:read',
  'communications:send',
]

const MARKETING_PERMISSIONS: PermissionKey[] = [
  'analytics:marketing',
  'analytics:org',
  'connectors:read',
  'clients:read_all',
]

/**
 * Default role -> permission mapping, seeded per organization.
 *
 * Note the deliberate exclusions:
 *  - DOCUMENT_COLLECTOR has no credit, payment, analytics, or internal-note access.
 *  - MARKETING sees aggregate analytics but cannot act on a client record.
 *  - CLIENT can only reach its own portal.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  REGIONAL_MANAGER: REGIONAL_MANAGER_PERMISSIONS,
  SALES_MANAGER: SALES_MANAGER_PERMISSIONS,
  CLOSER: CLOSER_PERMISSIONS,
  DOCUMENT_COLLECTOR: DOCUMENT_COLLECTOR_PERMISSIONS,
  MARKETING: MARKETING_PERMISSIONS,
  CLIENT: ['portal:self'],
}

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin / Operations',
  REGIONAL_MANAGER: 'Regional Manager',
  SALES_MANAGER: 'Sales Manager',
  CLOSER: 'Closer',
  DOCUMENT_COLLECTOR: 'Document Collector',
  MARKETING: 'Marketing',
  CLIENT: 'Client',
}

/** Landing route per role — the home experience changes with who signs in. */
/**
 * Landing route per role. Each target must exist and be reachable with that
 * role's permissions — the role-specific homes (/my-day, /collector,
 * /performance, /marketing, /portal) are P1+ and are not routed yet.
 */
/** Post-login landing for a user: a per-user override wins over the role default. */
export function homeFor(user: { role: RoleKey; landingPath?: string | null }): string {
  return user.landingPath || ROLE_HOME[user.role]
}

export const ROLE_HOME: Record<RoleKey, string> = {
  SUPER_ADMIN: '/dashboard',
  ADMIN: '/dashboard',
  REGIONAL_MANAGER: '/sales',
  SALES_MANAGER: '/sales',
  CLOSER: '/sales/hot-leads',
  DOCUMENT_COLLECTOR: '/clients',
  MARKETING: '/marketing',
  CLIENT: '/portal',
}

export function permissionsForRole(role: RoleKey): PermissionKey[] {
  return ROLE_PERMISSIONS[role] ?? []
}
