-- ============================================================
-- Banco completo da área das famílias (versão com loja)
-- ============================================================

-- 1) Famílias (quem comprou)
create table public.familias (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  email text not null unique,
  ativa boolean not null default true,
  acesso_ate date,
  limite_aparelhos int not null default 2,
  lembrete_em date,
  criado_em timestamptz not null default now()
);

-- Deixa o e-mail sempre em minúsculas
create or replace function public.normaliza_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

create trigger familias_email
before insert or update on public.familias
for each row execute function public.normaliza_email();

-- 2) Aparelhos liberados (os "crachás")
create table public.aparelhos (
  id uuid primary key default gen_random_uuid(),
  familia_id uuid not null references public.familias(id) on delete cascade,
  familia_nome text,
  apelido text,
  token_hash text not null unique,
  ativo boolean not null default true,
  ip text,
  navegador text,
  criado_em timestamptz not null default now(),
  ultimo_acesso timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '90 days'
);

-- 3) Pedidos de código (o código vai para o e-mail da mãe e aparece no painel)
create table public.pedidos_codigo (
  id uuid primary key default gen_random_uuid(),
  familia_id uuid not null references public.familias(id) on delete cascade,
  familia_nome text,
  email text,
  apelido text,
  codigo text not null,
  tentativas int not null default 0,
  usado boolean not null default false,
  ip text,
  navegador text,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '24 hours'
);

-- 4) Sites (o conteúdo de cada mês)
create table public.sites (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  titulo text not null,
  arquivo text not null,
  publicado boolean not null default true,
  ordem int not null default 0,
  criado_em timestamptz not null default now()
);

-- Tranca tudo: ninguém de fora lê essas tabelas direto.
alter table public.familias enable row level security;
alter table public.aparelhos enable row level security;
alter table public.pedidos_codigo enable row level security;
alter table public.sites enable row level security;

revoke all on public.familias, public.aparelhos, public.pedidos_codigo, public.sites
  from anon, authenticated;

-- Tela fácil para ver os pedidos (horário de Brasília, mais recentes primeiro)
create view public.pedidos_recentes
with (security_invoker = true) as
select
  to_char(criado_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as horario,
  familia_nome as familia,
  email,
  apelido as aparelho,
  codigo,
  case
    when usado then 'usado'
    when expira_em < now() then 'vencido'
    when tentativas >= 5 then 'bloqueado'
    else 'aguardando'
  end as situacao,
  ip
from public.pedidos_codigo
where criado_em > now() - interval '3 days'
order by criado_em desc;

revoke all on public.pedidos_recentes from anon, authenticated;

-- Pasta privada onde ficam os arquivos HTML dos sites
insert into storage.buckets (id, name, public)
values ('sites', 'sites', false)
on conflict (id) do nothing;

-- 5) Compras feitas pela loja
create table public.compras (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  email text not null,
  valor numeric(10,2) not null,
  status text not null default 'aguardando', -- aguardando | pago
  mp_pagamento text unique,
  familia_id uuid references public.familias(id) on delete set null,
  ip text,
  criado_em timestamptz not null default now(),
  pago_em timestamptz
);

alter table public.compras enable row level security;
revoke all on public.compras from anon, authenticated;

-- Tela fácil para ver as vendas (horário de Brasília, mais recentes primeiro)
create view public.vendas
with (security_invoker = true) as
select
  to_char(c.criado_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as horario,
  c.nome as familia,
  c.email,
  c.valor,
  c.status,
  to_char(f.acesso_ate, 'DD/MM/YYYY') as acesso_ate
from public.compras c
left join public.familias f on f.id = c.familia_id
order by c.criado_em desc;

revoke all on public.vendas from anon, authenticated;

-- 6) Pagamento aprovado: cadastra a família (ou renova) e soma 1 mês.
--    Só vale uma vez por compra, mesmo se o Mercado Pago avisar duas vezes.
create or replace function public.registrar_pagamento(p_compra uuid, p_pagamento text)
returns table (familia_id uuid, familia_nome text, email text, acesso_ate date, nova boolean)
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
    insert into public.familias (nome, email, acesso_ate)
    values (v_compra.nome, v_compra.email, (v_hoje + interval '1 month')::date)
    returning * into v_familia;
    v_nova := true;
  else
    update public.familias f
       set ativa = true,
           acesso_ate = (greatest(coalesce(f.acesso_ate, v_hoje), v_hoje) + interval '1 month')::date
     where f.id = v_familia.id
    returning * into v_familia;
  end if;

  update public.compras c set familia_id = v_familia.id where c.id = p_compra;

  return query select v_familia.id, v_familia.nome, v_familia.email, v_familia.acesso_ate, v_nova;
end;
$$;

revoke execute on function public.registrar_pagamento(uuid, text) from public, anon, authenticated;

-- 7) Libera um aparelho só se a família ainda tiver vaga.
--    A trava (for update) impede que dois aparelhos ocupem a mesma vaga ao mesmo tempo.
create or replace function public.liberar_aparelho(
  p_familia uuid, p_apelido text, p_token_hash text, p_ip text, p_navegador text, p_expira timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_familia public.familias;
  v_ativos int;
begin
  select * into v_familia from public.familias f where f.id = p_familia for update;
  if not found then
    return 'familia';
  end if;

  select count(*) into v_ativos
    from public.aparelhos a
   where a.familia_id = p_familia and a.ativo and a.expira_em > now();
  if v_ativos >= v_familia.limite_aparelhos then
    return 'limite';
  end if;

  insert into public.aparelhos (familia_id, familia_nome, apelido, token_hash, ip, navegador, expira_em)
  values (p_familia, v_familia.nome, p_apelido, p_token_hash, p_ip, p_navegador, p_expira);
  return 'ok';
end;
$$;

revoke execute on function public.liberar_aparelho(uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
