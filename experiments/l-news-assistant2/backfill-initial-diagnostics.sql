-- Historical audit import: no provider calls; original public response receipts.
begin;
select pg_advisory_xact_lock(hashtext('l-news-initial-diagnostic-import'));
insert into public.l_news_usage(provider,endpoint,page,status,credits,billable,created_at,details)
select v.provider,'assistant2_initial_20261126',v.page,v.status,v.credits,v.billable,v.created_at,v.details
from (values
('currents',1,200,0,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "ru", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('currents',2,200,0,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "uk", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('currents',3,200,0,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "pl", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('currents',4,200,0,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "fr", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('currents',5,200,0,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "de", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('currents',6,200,0,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "en", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('currents',7,200,0,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "en-interview", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('currents',8,200,0,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "ru-zelensky", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('cloro',1,200,5,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "US", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": "495"}'::jsonb),
('cloro',2,0,0,false,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "PL", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('cloro',3,200,5,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "FR", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": "490"}'::jsonb),
('cloro',4,200,5,true,'2026-11-26T04:10:12.989Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "UA", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": "485"}'::jsonb),
('currents',9,200,0,true,'2026-11-26T04:12:17.586Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "en-page2", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('currents',10,200,0,true,'2026-11-26T04:12:17.586Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "ru-translit", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('currents',11,200,0,true,'2026-11-26T04:12:17.586Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "pl-translit", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": null}'::jsonb),
('cloro',5,200,5,true,'2026-11-26T04:12:17.586Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "PL", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": "480"}'::jsonb),
('cloro',6,200,5,true,'2026-11-26T04:12:17.586Z'::timestamptz,'{"audit_import": true, "diagnostic": "assistant2_initial", "tag": "DE", "source": "results-original.json", "timestamp_precision": "batch", "balance_after": "475"}'::jsonb)
) v(provider,page,status,credits,billable,created_at,details)
where not exists(select 1 from public.l_news_usage u where u.provider=v.provider
 and u.endpoint='assistant2_initial_20261126' and u.page=v.page);
commit;
select provider,count(*) requests,count(*) filter(where status=200) successful,sum(credits) credits
from public.l_news_usage where endpoint='assistant2_initial_20261126' group by provider;
