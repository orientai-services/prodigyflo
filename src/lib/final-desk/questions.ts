/** Verbatim prototype questions; only approved additions are None for pressure/promises. */
export type Question = { id: string; l: string; ty: 'text' | 'long' | 'one' | 'multi'; o?: string[] }
export type QuestionSection = { t: string; qs: Question[] }
export type QuestionnaireAnswers = Record<string, string | string[]>
export const QUESTIONNAIRE_NAME = 'ProdigyFlo Final Questionnaire'
export const QUESTIONNAIRE_VERSION = 14
export const QUESTION_SECTIONS: QuestionSection[] =[
  {t:"1. Client & Property",qs:[
    {id:"legal_name",l:"Full legal name",ty:"text"},
    {id:"prop_addr",l:"Property address",ty:"text"},
    {id:"mail_same",l:"Mailing address same as property address?",ty:"one",o:["Yes","No"]},
    {id:"phone",l:"Phone",ty:"text"},
    {id:"email",l:"Email",ty:"text"},
    {id:"sole_owner",l:"Are you the sole property owner?",ty:"one",o:["Yes","No"]},
    {id:"on_contract",l:"Who is on the solar contract? (name/s)",ty:"text"},
    {id:"prop_type",l:"Property type",ty:"one",o:["Single-family home","Condo / Townhome","Manufactured home","Commercial property"]}
  ]},
  {t:"2. Contract & Companies",qs:[
    {id:"sales_co",l:"Solar company (sales company)",ty:"text"},
    {id:"install_co",l:"Installer company (if different)",ty:"text"},
    {id:"lender",l:"Finance company or lender name",ty:"text"},
    {id:"agree_type",l:"Type of solar agreement(s)",ty:"multi",o:["Loan","Lease","Purchase Agreement","PPA (Power Purchase Agreement)","Cash purchase","Warranty Contract"]},
    {id:"year_signed",l:"Year contract was actually signed",ty:"text"},
    {id:"sign_where",l:"Where were the documents signed?",ty:"one",o:["At client's home (door-to-door)","In a business/office"]},
    {id:"notice_3day",l:"Did you receive a 3-day cancellation notice?",ty:"one",o:["Yes","No","Not sure"]},
    {id:"got_copies",l:"Did you receive copies of all documents you signed?",ty:"one",o:["Yes","No"]}
  ]},
  {t:"3. Sales Practices",qs:[
    {id:"first_contact",l:"How did the solar company first contact you?",ty:"one",o:["Door-to-door salesperson","Phone call (cold call)","I responded to a mailer or advertisement","Online inquiry I submitted","Referral from friend/family","Event or home show","Other"]},
    {id:"pres_where",l:"Where did the main sales presentation take place?",ty:"one",o:["At my home","At their office/sales center","Online/virtual meeting","Other"]},
    {id:"pres_len",l:"Approximately how long did the sales presentation(s) last?",ty:"text"},
    {id:"pressure",l:"Did the salesperson use high-pressure tactics? (check all that apply)",ty:"multi",o:["Limited-time offer","Told I had to sign immediately","Wouldn't allow me to review contract before signing","Long sales visit / repeated visits or calls","Said they were affiliated with utility/city/government","None"]},
    {id:"promises",l:"Promises made by salesperson (check all that apply)",ty:"multi",o:["\"No cost solar\" / \"Free solar\"","Bill will drop significantly","\"You won't pay the utility again\"","Guaranteed tax credit","No lien or UCC filing","Buyout available anytime","Zero maintenance required","Other","None"]},
    {id:"misled",l:"Did you feel misled by the salesperson?",ty:"one",o:["Yes","No","Unsure"]},
    {id:"untrue",l:"Were there any other promises later discovered to be untrue?",ty:"long"}
  ]},
  {t:"4. Financial Terms",qs:[
    {id:"mo_pay",l:"Monthly solar payment amount",ty:"text"},
    {id:"term_yrs",l:"Length of agreement / loan",ty:"text"},
    {id:"escalator",l:"Does your payment increase yearly?",ty:"one",o:["Yes","No","Not sure"]},
    {id:"combo_bill",l:"Has your combined solar + utility bill increased?",ty:"one",o:["Yes, significantly","Yes, slightly","No, about the same","No, it decreased"]},
    {id:"told_lower",l:"Were you told your bill would be lower than it is now?",ty:"one",o:["Yes","No"]}
  ]},
  {t:"5. System Performance & Installation",qs:[
    {id:"working",l:"Is your system working today?",ty:"one",o:["Yes","No","Never turned on"]},
    {id:"perf",l:"System performance issues (check all that apply)",ty:"multi",o:["System shuts off / inconsistent performance","Not meeting performance projections","Battery not working (if applicable)","None - no issues"]},
    {id:"install",l:"Installation problems (check all that apply)",ty:"multi",o:["Roof leaks","Structural damage","Shading issues","Design issues","Improper roof penetrations","Poor electrical work","Failed inspections","Installation delays","None - no issues"]}
  ]},
  {t:"6. Billing, Service & Company Behavior",qs:[
    {id:"service",l:"Customer service issues experienced (check all that apply)",ty:"multi",o:["No response / delayed response","Delayed repairs","Billing errors","Broken promises","None - no issues"]},
    {id:"oob",l:"Has your installer or finance company gone out of business?",ty:"one",o:["Yes","No"]},
    {id:"complaints",l:"Have you filed complaints anywhere? (check all that apply)",ty:"multi",o:["BBB","Attorney General","Utility","Finance company","FTC Complaint","None"]}
  ]},
  {t:"7. Home Sale, Liens & Title Issues",qs:[
    {id:"selling",l:"Are you selling or attempting to sell your home?",ty:"one",o:["Yes","No"]},
    {id:"sale_issue",l:"Has the solar agreement caused issues with the sale?",ty:"one",o:["Yes","No"]},
    {id:"ucc",l:"Was a UCC financing statement filed?",ty:"one",o:["Yes","No","Not sure"]}
  ]},
  {t:"8. Personal Circumstances",qs:[
    {id:"age",l:"Age range",ty:"one",o:["Under 40","40-64","65+"]},
    {id:"le",l:"Limited English?",ty:"one",o:["Yes","No"]},
    {id:"credit_ck",l:"Was a credit check run?",ty:"one",o:["Yes","No","Unsure"]},
    {id:"hardship",l:"Has the solar panel contract caused financial hardship?",ty:"multi",o:["Behind on payments","Damaged credit","No hardship"]}
  ]},
  {t:"9. Client Goal",qs:[
    {id:"goal",l:"What outcome are you seeking?",ty:"multi",o:["Cancel the contract entirely","Remove lien","Fix the system","Lower payments"]}
  ]}
];

export const QUESTIONS = QUESTION_SECTIONS.flatMap(s => s.qs)
export const emptyAnswers = (): QuestionnaireAnswers => Object.fromEntries(QUESTIONS.map(q => [q.id, q.ty === 'multi' ? [] : '']))
export function answerCount(answers: QuestionnaireAnswers): number {
  return QUESTIONS.filter(q => Array.isArray(answers[q.id]) ? answers[q.id].length > 0 : String(answers[q.id] ?? '').trim().length > 0).length
}
export function validateAnswers(raw: unknown): QuestionnaireAnswers {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid questionnaire')
  const input = raw as Record<string, unknown>, result = emptyAnswers()
  for (const key of Object.keys(input)) if (!QUESTIONS.some(q => q.id === key)) throw Error('Unknown question')
  for (const q of QUESTIONS) {
    const value = input[q.id] ?? result[q.id]
    if (q.ty === 'multi') {
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !q.o?.includes(v))) throw Error('Invalid selection')
      const unique = [...new Set(value as string[])]
      if (unique.some(v => /^(None|No hardship)/.test(v)) && unique.length > 1) throw Error('None cannot be combined with other choices')
      result[q.id] = unique
    } else {
      if (typeof value !== 'string' || value.length > 8000) throw Error('Invalid answer')
      if (q.ty === 'one' && value && !q.o?.includes(value)) throw Error('Invalid selection')
      result[q.id] = value
    }
  }
  return result
}
