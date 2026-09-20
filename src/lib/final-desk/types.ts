import type { DeskBoard } from '@/lib/daily-desk'
import type { CaseFileData } from '@/lib/daily-desk-case-types'
import type { QuestionnaireAnswers } from './questions'
export type DeskView = 'board' | 'clients' | 'profile' | 'questionnaire' | 'queue' | 'engine' | 'documents' | 'submissions' | 'users'
export type FinalClient = {
  id: string; name: string; state: string; zip: string; stage: string; owner: string | null;
  appointment: string | null; docs: { id: string; label: string; state: string; key: string }[];
  extraction: 'none' | 'unverified' | 'verified'; credit: string | null
}
export type FinalSuggestion = { id: string; clientId: string; name: string; title: string; body: string; state: string }
export type FinalStaff = { id: string; name: string; email: string; role: string; status: string; inviteId?: string }
export type FinalDeskPayload = {
  user: { id: string; name: string; role: 'SUPER_ADMIN' | 'CLOSER' }; queueCount: number;
  board?: DeskBoard; clients?: FinalClient[]; file?: CaseFileData;
  questionnaire?: { answers: QuestionnaireAnswers; page: number; done: boolean; revision: number };
  suggestions?: FinalSuggestion[]; staff?: FinalStaff[];
}
