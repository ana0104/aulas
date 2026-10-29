-- Pedidos de código (o código vai para o WhatsApp da professora, que repassa à mãe)
create table public.pedidos_codigo (
  id uuid primary key default gen_random_uuid(),
  familia_id uuid not null references public.familias(id) on delete cascade,
  familia_nome text,
  email text,
  whatsapp text,
  apelido text,
  codigo text not null,
  tentativas int not null default 0,
  usado boolean not null default false,
  ip text,
  navegador text,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '24 hours'
);
alter table public.pedidos_codigo enable row level security;
revoke all on public.pedidos_codigo from anon, authenticated;
