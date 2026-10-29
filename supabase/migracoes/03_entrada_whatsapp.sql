-- O WhatsApp da mãe passa a ser guardado (vem da compra) e usado para conferir quem pede o aparelho.
drop view if exists public.pedidos_recentes;
drop table if exists public.pedidos_codigo;

alter table public.familias add column if not exists whatsapp text;
alter table public.compras add column if not exists whatsapp text not null default '';

-- Tentativas de entrar no portal (para travar quem fica chutando e-mails)
create table public.tentativas_entrada (
  id bigint generated always as identity primary key,
  ip text,
  email text,
  ok boolean not null default false,
  criado_em timestamptz not null default now()
);
alter table public.tentativas_entrada enable row level security;
revoke all on public.tentativas_entrada from anon, authenticated;

drop view if exists public.vendas;
create view public.vendas
with (security_invoker = true) as
select
  to_char(c.criado_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as horario,
  c.nome as familia,
  c.email,
  c.whatsapp,
  c.valor,
  c.status,
  to_char(f.acesso_ate, 'DD/MM/YYYY') as acesso_ate
from public.compras c
left join public.familias f on f.id = c.familia_id
order by c.criado_em desc;
revoke all on public.vendas from anon, authenticated;

drop function if exists public.registrar_pagamento(uuid, text);
create function public.registrar_pagamento(p_compra uuid, p_pagamento text)
returns table (familia_id uuid, familia_nome text, email text, whatsapp text, acesso_ate date, nova boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_compra public.compras;
  v_familia public.familias;
  v_nova boolean := false;
begin
  update public.compras c
     set status = 'pago', mp_pagamento = p_pagamento, pago_em = now()
   where c.id = p_compra and c.status <> 'pago'
  returning * into v_compra;
  if not found then
    return;
  end if;

  select * into v_familia from public.familias f where f.email = lower(trim(v_compra.email)) for update;

  if not found then
    insert into public.familias (nome, email, whatsapp, acesso_ate)
    values (v_compra.nome, v_compra.email, nullif(v_compra.whatsapp, ''), (v_hoje + interval '1 month')::date)
    returning * into v_familia;
    v_nova := true;
  else
    update public.familias f
       set ativa = true,
           whatsapp = coalesce(nullif(v_compra.whatsapp, ''), f.whatsapp),
           acesso_ate = (greatest(coalesce(f.acesso_ate, v_hoje), v_hoje) + interval '1 month')::date
     where f.id = v_familia.id
    returning * into v_familia;
  end if;

  update public.compras c set familia_id = v_familia.id where c.id = p_compra;

  return query select v_familia.id, v_familia.nome, v_familia.email, v_familia.whatsapp, v_familia.acesso_ate, v_nova;
end;
$$;

revoke execute on function public.registrar_pagamento(uuid, text) from public, anon, authenticated;
