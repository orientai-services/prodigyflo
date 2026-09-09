import type { PermissionKey } from '@/lib/permissions'
import type { SessionUser } from '@/lib/rbac'

export type NavItem = {
  href: string
  label: string
  icon: string
  /** Visible when the user holds ANY of these. Empty = always visible. */
  anyOf?: PermissionKey[]
  /** Restrict to specific roles regardless of permissions. */
  roles?: SessionUser['role'][]
  /** Visible only to the org owner (isOwner flag), on top of any other filter. */
  ownerOnly?: boolean
  /** Visible only when the user's HOME org is an AGENCY, on top of any other filter. */
  agencyOnly?: boolean
  exact?: boolean
}

export type NavSection = { title: string; items: NavItem[] }

/**
 * Every entry here must point at a route that exists and that the listed
 * permission actually opens — a nav item the user can click into a 404 or a
 * /forbidden bounce is worse than no nav item. P1+ destinations (pipeline board,
 * performance, marketing, client portal) are added when those routes ship.
 */
const SECTIONS: NavSection[] = [
  {
    title: 'Work',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: 'LayoutDashboard', anyOf: ['analytics:org'] },
      { href: '/engine', label: 'Prodigy Engine', icon: 'Sparkles', anyOf: ['ai:review'] },
      { href: '/inbox', label: 'Inbox', icon: 'Inbox', anyOf: ['communications:read'] },
      { href: '/inbound', label: 'Inbound', icon: 'DownloadCloud', anyOf: ['connectors:read'] },
      { href: '/notifications', label: 'Notifications', icon: 'Bell' },
    ],
  },
  {
    title: 'Sales',
    items: [
      {
        href: '/sales',
        label: 'Sales command',
        icon: 'Target',
        anyOf: ['analytics:self', 'analytics:team', 'analytics:region', 'analytics:org'],
      },
      {
        href: '/board',
        label: 'Pipeline board',
        icon: 'Columns3',
        anyOf: ['clients:read_assigned', 'clients:read_team', 'clients:read_region', 'clients:read_all'],
      },
      {
        href: '/performance',
        label: 'Scoreboard',
        icon: 'Trophy',
        anyOf: ['analytics:self', 'analytics:team', 'analytics:region', 'analytics:org'],
      },
    ],
  },
  {
    title: 'Marketing',
    items: [
      { href: '/marketing', label: 'Overview', icon: 'Megaphone', anyOf: ['analytics:marketing'], exact: true },
      { href: '/marketing/sources', label: 'Lead sources', icon: 'Radar', anyOf: ['analytics:marketing'] },
      { href: '/marketing/meta', label: 'Meta Ads', icon: 'Facebook', anyOf: ['connectors:read'] },
      { href: '/marketing/analytics', label: 'Attribution & forecast', icon: 'ChartSpline', anyOf: ['analytics:marketing'] },
    ],
  },
  {
    title: 'Clients',
    items: [
      {
        href: '/clients',
        label: 'All clients',
        icon: 'Users',
        anyOf: ['clients:read_assigned', 'clients:read_team', 'clients:read_region', 'clients:read_all'],
      },
      { href: '/documents', label: 'Document review', icon: 'FileText', anyOf: ['documents:review'] },
      { href: '/attorney', label: 'Attorney review', icon: 'Scale', anyOf: ['submissions:prepare'] },
      { href: '/submissions', label: 'Submissions', icon: 'Send', anyOf: ['submissions:read'] },
    ],
  },
  {
    title: 'Insight',
    items: [
      { href: '/reports', label: 'Reports', icon: 'BarChart3', anyOf: ['analytics:team', 'analytics:region', 'analytics:org'] },
    ],
  },
  {
    title: 'Setup',
    items: [
      { href: '/settings/profile', label: 'My profile', icon: 'UserRound' },
      { href: '/settings/users', label: 'Users & access', icon: 'UserCog', anyOf: ['users:read'] },
      { href: '/agency', label: 'Agency accounts', icon: 'Building2', anyOf: ['users:manage'], agencyOnly: true },
      { href: '/settings/sequences', label: 'Sequences', icon: 'Workflow', anyOf: ['connectors:read'] },
      { href: '/settings/phone-numbers', label: 'Phone numbers', icon: 'Phone', anyOf: ['telephony:read'] },
      { href: '/settings/connectors', label: 'Connectors', icon: 'Blocks', anyOf: ['connectors:read'] },
      { href: '/settings/intake', label: 'Intake sources', icon: 'Plug', anyOf: ['connectors:read'] },
      { href: '/settings/templates', label: 'Message templates', icon: 'MessageSquare', anyOf: ['connectors:manage'] },
      { href: '/settings/cys', label: 'CYS field map', icon: 'ListChecks', anyOf: ['submissions:prepare'] },
      // Planning boards and their report index are not in this deployment, so
      // the entry that pointed at /settings/progress is withdrawn rather than
      // left linking at a 404. Individual reports remain reachable directly at
      // /settings/progress/<report>. Restore this when the boards land.
      { href: '/settings/deploy', label: 'Deployments', icon: 'Rocket', ownerOnly: true },
    ],
  },
]

/** /sales/** gates via requireSalesAccess(): any analytics grant at any level. */
const SALES_ANALYTICS: PermissionKey[] = ['analytics:self', 'analytics:team', 'analytics:region', 'analytics:org']
/** /reports/** gates via requireAnalyticsLevel(): team-level analytics or wider. */
const REPORT_ANALYTICS: PermissionKey[] = ['analytics:team', 'analytics:region', 'analytics:org']

/**
 * Destinations that live BELOW a top-nav route — reachable in-app but absent
 * from the sidebar. The ⌘K palette surfaces them in its "Go deeper" group.
 * Same contract as SECTIONS: every href must exist (navigation.test.ts checks
 * against the filesystem) and anyOf must mirror the page's actual gate.
 */
export const SUBROUTES: NavItem[] = [
  { href: '/sales/huddle', label: 'Daily huddle', icon: 'Sunrise', anyOf: SALES_ANALYTICS },
  { href: '/sales/hot-leads', label: 'Hot leads', icon: 'Flame', anyOf: SALES_ANALYTICS },
  { href: '/sales/qualifier', label: 'Qualifier queue', icon: 'ClipboardCheck', anyOf: ['qualification:review'] },
  { href: '/sales/nurture', label: 'Pre-call nurture', icon: 'Sprout', anyOf: SALES_ANALYTICS },
  { href: '/sales/ops', label: 'Close-rate operations', icon: 'Gauge', anyOf: SALES_ANALYTICS },
  { href: '/sales/coaching', label: 'Coaching & call QA', icon: 'GraduationCap', anyOf: SALES_ANALYTICS },
  { href: '/sales/accuracy', label: 'AI accuracy', icon: 'Target', anyOf: SALES_ANALYTICS },
  { href: '/sales/hygiene', label: 'Data health', icon: 'ShieldCheck', anyOf: SALES_ANALYTICS },
  { href: '/attention', label: 'Attention', icon: 'BellRing', anyOf: REPORT_ANALYTICS },
  { href: '/clients/new', label: 'New client', icon: 'UserPlus', anyOf: ['clients:create'] },
  { href: '/clients/import', label: 'Import clients', icon: 'Upload', anyOf: ['clients:create'] },
  { href: '/reports/documents', label: 'Document completion', icon: 'FileCheck', anyOf: REPORT_ANALYTICS },
  { href: '/reports/submissions', label: 'CYS submissions', icon: 'MailCheck', anyOf: REPORT_ANALYTICS },
  { href: '/reports/conversion', label: 'Conversion funnel', icon: 'Filter', anyOf: REPORT_ANALYTICS },
  { href: '/reports/overdue', label: 'Overdue follow-ups', icon: 'AlarmClock', anyOf: REPORT_ANALYTICS },
  { href: '/marketing/analytics/forecast', label: 'Revenue forecast', icon: 'TrendingUp', anyOf: ['analytics:marketing'] },
  { href: '/marketing/analytics/journey', label: 'Customer journey', icon: 'Route', anyOf: ['analytics:marketing'] },
]

function visibleTo(user: SessionUser, item: NavItem): boolean {
  if (item.ownerOnly && !user.isOwner) return false
  // organizationKind is the HOME org's kind (absence = CLIENT, per SessionUser).
  if (item.agencyOnly && user.organizationKind !== 'AGENCY') return false
  if (item.roles && !item.roles.includes(user.role)) return false
  if (item.roles && item.roles.includes(user.role)) return true
  if (!item.anyOf?.length) return true
  return item.anyOf.some((p) => user.permissions.has(p))
}

export function navigationFor(user: SessionUser): NavSection[] {
  // The client portal is deferred (P3); CLIENT accounts have no staff-app nav.
  if (user.role === 'CLIENT') return []

  return SECTIONS.map((section) => ({
    title: section.title,
    items: section.items.filter((item) => visibleTo(user, item)),
  })).filter((section) => section.items.length > 0)
}

/** SUBROUTES the user may actually open — the palette's "Go deeper" group. */
export function subroutesFor(user: SessionUser): NavItem[] {
  if (user.role === 'CLIENT') return []
  return SUBROUTES.filter((item) => visibleTo(user, item))
}
