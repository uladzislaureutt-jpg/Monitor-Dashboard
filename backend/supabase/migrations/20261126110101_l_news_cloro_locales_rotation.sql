-- One fixed country list and a nine-country rotation, with the existing budget.
alter table public.l_news_assistant2_settings
 add column cloro_rotation_start bigint not null default 1 check(cloro_rotation_start>=1),
 alter column cloro_countries set default array['US','DE','PL','FR','IT','UA','GB','ES','TR','LT','LV','EE'];
update public.l_news_assistant2_settings
 set cloro_countries=array['US','DE','PL','FR','IT','UA','GB','ES','TR','LT','LV','EE'],
     cloro_rotation_start=(select coalesce(max(assistant_number),0)+1 from public.l_news_runs where assistant_id=2),
     updated_at=now()
 where id=true;
