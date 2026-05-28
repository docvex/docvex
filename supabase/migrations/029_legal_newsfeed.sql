-- Legal Newsfeed (Newsletter tab) — real data + AI.
--
-- The Newsletter page previously rendered a hardcoded JS array. This
-- migration moves that feed into Postgres and adds per-user state so
-- the page reads live data and remembers read/pin/save across devices.
--
-- Two tables:
--   legal_updates        — the global feed. Not project-scoped: legal /
--                          regulatory updates are the same for everyone.
--                          Rows are written by the `legal-ai` Edge
--                          Function (service role) or this seed. Clients
--                          only ever SELECT.
--   legal_update_states  — per-(user, update) read/pin/save flags. Each
--                          column is a nullable timestamp; null = "not
--                          read / not pinned / not saved". Gated on
--                          user_id = auth.uid() like notifications.
--
-- The per-item `summary`, `areas`, `impact`, and `category` are
-- AI-generated at ingestion time (see supabase/functions/legal-ai). The
-- seed below ports the original editorial feed verbatim so the page has
-- content immediately; ai_status='done' marks those as already
-- summarised.

create table public.legal_updates (
  id            uuid primary key default gen_random_uuid(),
  -- Natural key so re-running the seed (or an idempotent ingest) doesn't
  -- duplicate rows. ON CONFLICT (slug) DO NOTHING below relies on this.
  slug          text not null unique,
  category      text not null
                  check (category in ('employment','corporate','gdpr','litigation','tax','compliance')),
  impact        text not null default 'medium'
                  check (impact in ('low','medium','high')),
  title         text not null,
  source        text,
  citations     text,
  -- AI brief (Romanian). Null until the ingest function fills it.
  summary       text,
  -- AI-extracted affected practice areas.
  areas         text[] not null default '{}',
  -- The source text the AI summarised. Kept for re-summarisation / audit.
  raw_content   text,
  ai_status     text not null default 'pending'
                  check (ai_status in ('pending','done','failed')),
  published_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Feed query: newest first, optionally filtered by category.
create index legal_updates_published_idx on public.legal_updates (published_at desc);
create index legal_updates_category_idx on public.legal_updates (category, published_at desc);

alter table public.legal_updates enable row level security;

-- READ: anyone (signed-in or not). The Newsletter route is a public
-- personal route, and legal updates are public information. No client
-- write policies — INSERT/UPDATE/DELETE happen only via the service-role
-- Edge Function (which bypasses RLS) or migrations.
create policy "legal_updates: public read"
  on public.legal_updates
  for select
  using (true);


create table public.legal_update_states (
  user_id    uuid not null references auth.users(id) on delete cascade,
  update_id  uuid not null references public.legal_updates(id) on delete cascade,
  read_at    timestamptz,
  pinned_at  timestamptz,
  saved_at   timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, update_id)
);

create index legal_update_states_user_idx on public.legal_update_states (user_id);

alter table public.legal_update_states enable row level security;

-- Personal rows — every op gated on ownership (same shape as
-- project_member_branches / branch_changes).
create policy "legal_update_states: read own"
  on public.legal_update_states
  for select
  using (user_id = (select auth.uid()));

create policy "legal_update_states: insert own"
  on public.legal_update_states
  for insert
  with check (user_id = (select auth.uid()));

create policy "legal_update_states: update own"
  on public.legal_update_states
  for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "legal_update_states: delete own"
  on public.legal_update_states
  for delete
  using (user_id = (select auth.uid()));


-- ── Seed: the original editorial feed as real rows ──────────────────
-- Text fields are dollar-quoted ($$...$$) so Romanian apostrophes /
-- quotes don't need escaping. Dates are the original published-at values.
insert into public.legal_updates
  (slug, category, impact, title, source, citations, summary, areas, ai_status, published_at)
values
  ('oug-156-2024-tva-21', 'tax', 'high',
   $$OUG 156/2024 — TVA standard urcă la 21% începând cu 1 august 2026$$,
   $$Monitorul Oficial · OUG 156/2024$$,
   $$OUG 156/2024, art. 291 Cod fiscal$$,
   $$Cota standard de TVA crește de la 19% la 21% pentru toate livrările de bunuri și prestările de servicii care nu beneficiază de o cotă redusă. Cotele reduse de 9% și 5% rămân neschimbate, dar lista bunurilor încadrate la 5% se restrânge — locuințele sociale ies din această categorie.$$,
   array['Contracte comerciale','Facturare','Real estate','Prețuri & promoții'],
   'done', '2026-05-24T07:30:00Z'),

  ('codul-muncii-concediu-medical-5-zile', 'employment', 'high',
   $$Codul Muncii — concediul medical plătit integral de angajator pentru primele 5 zile$$,
   $$Legea 88/2026$$,
   $$Legea 88/2026 · OUG 158/2005 modificată$$,
   $$Începând cu 1 iunie 2026, primele 5 zile de concediu medical (în loc de primele 5 calendaristice anterioare) sunt suportate integral de angajator, indiferent de cauza incapacității. Indemnizația rămâne 75% din baza de calcul, cu excepția bolilor grave (100%).$$,
   array['Contracte de muncă','Politici HR','Bugetare salarială'],
   'done', '2026-05-24T05:15:00Z'),

  ('anspdcp-transfer-international-schrems-iii', 'gdpr', 'medium',
   $$ANSPDCP — Ghid actualizat privind transferurile internaționale de date după Schrems III$$,
   $$ANSPDCP · Comunicat nr. 14/2026$$,
   $$GDPR art. 46 · Decizia Schrems III (C-311/22)$$,
   $$Autoritatea publică un nou ghid pentru evaluarea transferurilor către state non-UE care nu beneficiază de decizie de adecvare. Sunt introduse cerințe suplimentare de Transfer Impact Assessment (TIA), iar SCC-urile trebuie completate cu măsuri tehnice documentate până la 30 septembrie 2026.$$,
   array['DPA','Vendor management','Cloud agreements'],
   'done', '2026-05-23T14:00:00Z'),

  ('onrc-srl-online-ubo-anual', 'corporate', 'medium',
   $$ONRC — Înregistrare 100% online pentru SRL-uri și obligație nouă de raportare UBO la 12 luni$$,
   $$Lege 265/1994 modificată · OUG 23/2026$$,
   $$Legea 129/2019 · OUG 23/2026$$,
   $$Înființarea unui SRL devine integral electronică, fără deplasare la registru. În paralel, declarația privind beneficiarul real (UBO) trebuie reconfirmată anual, nu doar la modificări. Termen-limită pentru societățile existente: 15 ianuarie 2027. Amenzi de la 5.000 la 10.000 RON pentru nedepunere.$$,
   array['Înființări','Compliance UBO','Restructurări'],
   'done', '2026-05-22T09:00:00Z'),

  ('iccj-ril-8-2026-termen-apel', 'litigation', 'medium',
   $$ICCJ — Decizie RIL: termenul de apel curge de la comunicarea hotărârii motivate, nu de la dispozitiv$$,
   $$ICCJ · Decizia RIL 8/2026$$,
   $$Cod procedură civilă art. 468 · ICCJ RIL 8/2026$$,
   $$Recurs în interesul legii admis: în procedura civilă, termenul de 30 de zile pentru apel se calculează exclusiv de la data comunicării hotărârii motivate către parte. Soluția pune capăt practicii neunitare a curților de apel și permite redeschiderea termenelor în dosarele în care apelul a fost respins ca tardiv pe baza comunicării minutei.$$,
   array['Litigii comerciale','Litigii de muncă','Apeluri'],
   'done', '2026-05-21T11:00:00Z'),

  ('telemunca-indemnizatie-400-ron', 'employment', 'medium',
   $$Telemuncă — Indemnizație obligatorie de 400 RON/lună și auditarea condițiilor de la domiciliu$$,
   $$Legea 81/2018 modificată$$,
   $$Legea 81/2018 · OG 16/2026$$,
   $$Angajatorii care folosesc telemunca trebuie să acorde o indemnizație lunară minimă de 400 RON pentru utilități și echipamente, neimpozabilă în limita acestui plafon. Se introduce și obligația unui audit anual al condițiilor de muncă de la domiciliu, cu confirmare scrisă a salariatului.$$,
   array['Telework policies','Contracte de muncă','Sănătate & securitate'],
   'done', '2026-05-20T08:30:00Z'),

  ('dac8-raportare-cripto-anaf', 'compliance', 'high',
   $$DAC8 transpus — Raportare automată a tranzacțiilor cripto către ANAF din 1 ianuarie 2027$$,
   $$OG 26/2026$$,
   $$Directiva (UE) 2023/2226 · OG 26/2026$$,
   $$România transpune Directiva DAC8. Furnizorii de servicii de cripto-active (CASP) trebuie să raporteze automat ANAF tranzacțiile clienților cu rezidență fiscală în România. Sunt incluse: stablecoins, NFT-uri folosite ca instrumente de plată, și e-money tokens. Prima raportare anuală: 31 ianuarie 2028.$$,
   array['CASP licensing','Reporting','KYC/AML'],
   'done', '2026-05-19T13:20:00Z'),

  ('edpb-pixeli-tracking-b2b', 'gdpr', 'low',
   $$EDPB — Linii directoare privind utilizarea pixelilor de tracking în comunicările B2B$$,
   $$EDPB · Guidelines 03/2026$$,
   $$EDPB Guidelines 03/2026 · GDPR art. 6(1)$$,
   $$Comitetul European pentru Protecția Datelor clarifică faptul că pixelii de tracking în emailurile către contacte B2B necesită consimțământ explicit, inclusiv pentru contactele „business-only". Excepție: monitorizarea agregată, fără identificarea individuală a destinatarului.$$,
   array['Marketing legal','CRM compliance'],
   'done', '2026-05-18T10:00:00Z'),

  ('asf-oferte-publice-8-mil-eur', 'corporate', 'low',
   $$ASF — Plafonul pentru ofertele publice fără prospect ridicat la 8 milioane EUR$$,
   $$Regulamentul ASF 5/2026$$,
   $$Regulamentul ASF 5/2026 · Regulament (UE) 2024/2809$$,
   $$Plafonul anual al ofertelor publice de valori mobiliare care nu necesită prospect aprobat crește de la 5 la 8 milioane EUR, aliniindu-se la noul Listing Act european. Documentul de informare simplificat rămâne obligatoriu peste 1 milion EUR.$$,
   array['Capital markets','Crowdfunding'],
   'done', '2026-05-17T15:45:00Z'),

  ('microintreprinderi-plafon-100k-eur', 'tax', 'medium',
   $$Microîntreprinderi — Plafonul de venituri scade la 100.000 EUR și se exclud activitățile de consultanță IT$$,
   $$Legea 296/2023 modificată$$,
   $$Legea 296/2023 · OUG 159/2024$$,
   $$De la 1 ianuarie 2027, plafonul pentru regimul microîntreprinderilor scade de la 250.000 la 100.000 EUR. Societățile care depășesc plafonul trec automat la impozit pe profit. Activitățile de consultanță IT și management sunt excluse complet din regim, indiferent de cifra de afaceri.$$,
   array['Tax planning','Restructurări fiscale','Consultanță IT'],
   'done', '2026-05-16T12:00:00Z'),

  ('mediere-obligatorie-litigii-comerciale', 'litigation', 'low',
   $$Mediere obligatorie reintrodusă pentru litigii comerciale sub 50.000 RON$$,
   $$OG 27/2026$$,
   $$OG 27/2026 · Legea 192/2006$$,
   $$Pentru litigiile patrimoniale între profesioniști cu valoare sub 50.000 RON, ședința de informare privind medierea redevine obligatorie înainte de înregistrarea acțiunii. Lipsa dovezii atrage suspendarea cauzei până la depunerea acesteia.$$,
   array['Recuperare creanțe','Small claims'],
   'done', '2026-05-15T09:30:00Z')
on conflict (slug) do nothing;
