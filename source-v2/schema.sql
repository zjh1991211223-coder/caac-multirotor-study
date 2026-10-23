create table public.caac_profiles (
 id text primary key check (id in ('zhang-jiahao','ji-yaqun','huang-chunlin')),
 display_name text not null unique
);
insert into public.caac_profiles values
 ('zhang-jiahao','张佳昊'),('ji-yaqun','纪亚群'),('huang-chunlin','黄春林');
create table public.caac_events (
 seq bigint generated always as identity primary key,
 id uuid not null unique,
 profile_id text not null references public.caac_profiles(id),
 device_id uuid not null,
 kind text not null check(kind in ('answer','ui','seed','exam')),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=600000),
 created_at timestamptz not null default now()
);
create index caac_events_profile_seq on public.caac_events(profile_id,seq);
alter table public.caac_profiles enable row level security;
alter table public.caac_events enable row level security;
revoke all on public.caac_profiles,public.caac_events from anon,authenticated;
grant select on public.caac_profiles to anon;
grant select,insert on public.caac_events to anon;
grant usage,select on sequence public.caac_events_seq_seq to anon;
create policy "Name selection deliberately permits public profile listing" on public.caac_profiles for select to anon using(true);
create policy "Name-only study group can read its three profiles" on public.caac_events for select to anon using(profile_id in ('zhang-jiahao','ji-yaqun','huang-chunlin'));
create policy "Name-only study group can append; history cannot be edited" on public.caac_events for insert to anon with check(profile_id in ('zhang-jiahao','ji-yaqun','huang-chunlin'));
create function public.caac_append_events(p_profile text,p_events jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare e jsonb; accepted integer:=0;
begin
 if p_profile not in ('zhang-jiahao','ji-yaqun','huang-chunlin') then raise exception 'Unknown profile'; end if;
 if jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>100 then raise exception 'Invalid batch'; end if;
 -- Serialize appends within a profile so a later cursor cannot skip a still-uncommitted earlier sequence.
 perform pg_advisory_xact_lock(hashtext('caac-study-'||p_profile));
 for e in select value from jsonb_array_elements(p_events) loop
   insert into public.caac_events(id,profile_id,device_id,kind,payload)
   values((e->>'id')::uuid,p_profile,(e->>'device_id')::uuid,e->>'kind',e->'payload') on conflict(id) do nothing;
   if found then accepted:=accepted+1; end if;
 end loop;
 return jsonb_build_object('accepted',accepted);
end $$;
revoke all on function public.caac_append_events(text,jsonb) from public;
grant execute on function public.caac_append_events(text,jsonb) to anon;
comment on table public.caac_events is 'User explicitly chose name-only sharing. Profiles are organizational separation, not authentication. Append-only event IDs deduplicate offline retries.';
