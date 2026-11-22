-- Add the approved international sources to the assistant's active catalog.
with candidates(domain, name, country, language, source_type, priority) as (
  values
    ('efe.com', 'Agencia EFE', 'ES', 'es', 'agency', 'A'),
    ('tvpworld.com', 'TVP World', 'PL', 'en', 'media', 'A'),
    ('euronews.com', 'Euronews English', 'BE', 'en', 'media', 'A'),
    ('occrp.org', 'OCCRP', 'US', 'en', 'media', 'A'),
    ('en.yna.co.kr', 'Yonhap News Agency · English', 'KR', 'en', 'agency', 'A'),
    ('nknews.org', 'NK News', 'KR', 'en', 'media', 'A'),
    ('cna.com.tw', 'Central News Agency (Taiwan)', 'TW', 'zh', 'agency', 'A'),
    ('sbs.com.au', 'SBS News', 'AU', 'en', 'media', 'A'),
    ('libyaobserver.ly', 'The Libya Observer', 'LY', 'en', 'media', 'A'),
    ('alwasat.ly', 'Alwasat', 'LY', 'ar', 'media', 'A'),
    ('irrawaddy.com', 'The Irrawaddy', 'MM', 'en', 'media', 'A'),
    ('gnlm.com.mm', 'Global New Light of Myanmar', 'MM', 'en', 'media', 'B'),
    ('today.lorientlejour.com', 'L’Orient Today', 'LB', 'en', 'media', 'A'),
    ('mtv.com.lb', 'MTV Lebanon', 'LB', 'ar', 'media', 'B'),
    ('prensa-latina.cu', 'Prensa Latina', 'CU', 'es', 'agency', 'A'),
    ('granma.cu', 'Granma', 'CU', 'es', 'media', 'B')
), added as (
  insert into public.l_news_sources (domain, name, country, language, source_type, priority, coverage)
  select domain, name, country, language, source_type, priority,
    '{"gdelt":"unverified","perigon":"unverified","newscatcher":"unverified"}'::jsonb
  from candidates
  on conflict (domain) do nothing
)
update public.l_news_settings s
set countries = s.countries || array(
      select distinct country from candidates where country <> all(s.countries) order by country
    ),
    catalog_version = 'curated-international-2026-11-20',
    updated_at = now()
where s.id;
