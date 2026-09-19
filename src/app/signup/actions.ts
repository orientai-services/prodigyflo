'use server'

export type SignupState = { error?: string; fieldErrors?: Record<string, string> }
export async function signupAction(_prev: SignupState, _formData: FormData): Promise<SignupState> {
  void _prev; void _formData
  return { error: 'Staff access requires an invitation from a Super Admin.' }
}
