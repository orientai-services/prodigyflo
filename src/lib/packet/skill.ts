export function buildStrawberrySkill(fileId: string, payload: string): string {
  return [
    `Skill: SCS Packet Upload`,
    `Use only when STATUS = READY and a DASHBOARD PAYLOAD exists for ${fileId}.`,
    ``,
    `Preconditions`,
    `- Logged into the SCS Dashboard`,
    `- Payload below is in the conversation`,
    `- Human said run upload`,
    ``,
    `Steps`,
    `1. Open SCS Dashboard → New Client`,
    `2. Fill each field from DASHBOARD PAYLOAD, in payload order`,
    `3. Skip any field marked MISSING`,
    `4. Attach files in payload Docs attach order`,
    `5. Scroll the form once and confirm visible values match payload`,
    `6. WAIT FOR HUMAN. Do not click Submit.`,
    ``,
    `Stops: login/2FA, field label not in payload, missing file, any guess.`,
    ``,
    `DASHBOARD PAYLOAD`,
    payload,
  ].join('\n')
}
