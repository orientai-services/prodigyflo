'use client'

import dynamic from 'next/dynamic'

/**
 * The Ads dashboard's heavy client islands, split into their own chunks. The
 * dashboard also renders inside the Call Center (More › Campaigns), and static
 * imports put Recharts (~110 KB gzip) and the `fb>` console's cmdk (~17 KB
 * gzip) on every Call Center section, whether the Ads view was open or not.
 * Server-rendered as before; each chunk loads only where its island renders.
 * The campaign table and the dashboard's buttons and forms (meta-islands)
 * are here for the same reason: ~80 KB of client code the Call Center's
 * other sections never draw.
 */
export const TrendChart = dynamic(() => import('@/components/charts/trend-chart').then((m) => m.TrendChart))
export const SpendBars = dynamic(() => import('./spend-bars').then((m) => m.SpendBars))
export const MetaConsole = dynamic(() => import('../meta-console').then((m) => m.MetaConsole))
export const CampaignTable = dynamic(() => import('../campaign-table').then((m) => m.CampaignTable))
export const CampaignDialog = dynamic(() => import('../meta-islands').then((m) => m.CampaignDialog))
export const TestLeadButton = dynamic(() => import('../meta-islands').then((m) => m.TestLeadButton))
export const StartCycleButton = dynamic(() => import('../meta-islands').then((m) => m.StartCycleButton))
export const CycleLengthForm = dynamic(() => import('../meta-islands').then((m) => m.CycleLengthForm))
export const RecheckButton = dynamic(() => import('../meta-islands').then((m) => m.RecheckButton))
export const RematchButton = dynamic(() => import('../meta-islands').then((m) => m.RematchButton))
