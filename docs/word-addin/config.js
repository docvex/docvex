// DocVex Legal AI — Word add-in configuration.
//
// These are PUBLIC client values (the same Supabase URL + publishable
// "anon" key that ship inside the DocVex web bundle). The publishable key
// is safe to expose — it only grants what Row-Level Security allows, and
// the legal-assist Edge Function additionally requires a signed-in DocVex
// user (verify_jwt). No secret keys live here.
window.DOCVEX_ADDIN_CONFIG = {
  supabaseUrl: 'https://pntxlvhkqfryyyxlqytr.supabase.co',
  supabaseAnonKey: 'sb_publishable_2JXDUwP4MFAk9t78UELKpA_99CImHfW',
  // Edge Function that talks to Claude (deployed under supabase/functions/legal-assist).
  functionName: 'legal-assist',
};
