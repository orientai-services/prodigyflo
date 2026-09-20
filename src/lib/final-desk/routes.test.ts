import {afterEach,expect,it,vi} from 'vitest'
import {staffRouteAllowed} from '@/lib/staff-routes'
afterEach(()=>vi.unstubAllEnvs())
it('keeps final interface within its visible surfaces and two roles',()=>{
 vi.stubEnv('PRODIGYFLO_FINAL_DESK','true')
 expect(staffRouteAllowed('SUPER_ADMIN','/engine')).toBe(true)
 expect(staffRouteAllowed('CLOSER','/engine')).toBe(false)
 expect(staffRouteAllowed('SUPER_ADMIN','/pipeline')).toBe(false)
 expect(staffRouteAllowed('SUPER_ADMIN','/settings/phone-numbers')).toBe(false)
 expect(staffRouteAllowed('CLOSER','/settings/users')).toBe(false)
 expect(staffRouteAllowed('CLOSER','/clients/client-1/questionnaire')).toBe(true)
 expect(staffRouteAllowed('CLOSER','/clients/client-1/closeops')).toBe(false)
 expect(staffRouteAllowed('ADMIN','/board')).toBe(false)
 expect(staffRouteAllowed('CLOSER','/api/documents/doc-1/file')).toBe(true)
})
it('turning off the flag restores the legacy admin route boundary',()=>{
 vi.stubEnv('PRODIGYFLO_FINAL_DESK','false')
 expect(staffRouteAllowed('SUPER_ADMIN','/settings/phone-numbers')).toBe(true)
 expect(staffRouteAllowed('SUPER_ADMIN','/engine')).toBe(false)
})
